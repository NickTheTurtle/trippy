import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The ceiling on the one billed call nobody asks for by name.
 *
 * Cover photos are looked up by a backlog drainer on a board load, not by
 * anything a member typed, and each lookup is a paid Places request. The
 * existing rules bound a single visit (one lookup per row ever, a cap per
 * request) but not a caller: somebody who adds rows faster than the backlog
 * drains turns "save a place" into "buy a Places call", forever. A gate now
 * bounds it, and because a missing picture must never break a page it stops the
 * drain rather than raising.
 */
const tempRoot = join(tmpdir(), `trippy-photo-backlog-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'photo-backlog.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let auth: typeof import('../src/infra/auth.ts');
let trips: typeof import('../src/persistence/trips.ts');
let pois: typeof import('../src/persistence/pois.ts');
let photos: typeof import('../src/photos.ts');

beforeAll(async () => {
	[{ db }, auth, trips, pois, photos] = await Promise.all([
		import('../src/db.ts'),
		import('../src/infra/auth.ts'),
		import('../src/persistence/trips.ts'),
		import('../src/persistence/pois.ts'),
		import('../src/photos.ts')
	]);
});

afterAll(() => {
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
	db.prepare(`DELETE FROM users`).run();
	process.env.GOOGLE_SERVER_KEY = 'test-key';
	delete process.env.TRIPPY_OFFLINE_PROVIDERS;
});

/** Counts the billed lookups, and answers as Google with one photo. */
function stubPhotoLookup(): () => number {
	let calls = 0;
	vi.stubGlobal('fetch', async () => {
		calls += 1;
		return {
			ok: true,
			json: async () => ({ places: [{ photos: [{ name: 'places/x/photos/y' }] }] })
		};
	});
	return () => calls;
}

/** A trip with `count` saved places, none of which has ever had a photo. */
function tripWithPhotolessPois(count: number): string {
	const organizer = auth.createUser(
		`photo-${crypto.randomUUID()}@example.test`,
		'Organizer',
		'password123'
	).id;
	const tripId = trips.createTrip(organizer, {
		name: 'Photo Trip',
		startDate: '2026-10-01',
		endDate: '2026-10-03',
		homeCurrency: 'EUR'
	}).id!;
	const cityId = trips.addCity(tripId, organizer, {
		name: 'Athens',
		country: 'Greece',
		tz: 'Europe/Athens',
		lat: 37.98,
		lng: 23.73
	})!;
	for (let i = 0; i < count; i += 1) {
		pois.addPoi(tripId, organizer, cityId, `Place ${i}`, 'Sights', null, null, 37.98, 23.73);
	}
	return tripId;
}

describe('the cover-photo backlog', () => {
	it('stops where the gate stops, and leaves the rest in the backlog', async () => {
		const calls = stubPhotoLookup();
		const tripId = tripWithPhotolessPois(6);

		let allowed = 2;
		const done = await photos.backfillTripPhotos(tripId, 24, () => allowed-- > 0);

		expect(done).toBe(2);
		expect(calls()).toBe(2);
		// The rows nobody paid for are untouched, so the next visit picks them up
		// rather than them being marked as looked-at-and-empty.
		expect(pois.poisNeedingPhotos(tripId).length).toBe(4);
	});

	it('does not raise when the allowance is spent, because a picture is decoration', async () => {
		stubPhotoLookup();
		const tripId = tripWithPhotolessPois(3);
		await expect(photos.backfillTripPhotos(tripId, 24, () => false)).resolves.toBe(0);
		expect(pois.poisNeedingPhotos(tripId).length).toBe(3);
	});

	it('drains as before when no gate is given, so a seed or script is unaffected', async () => {
		const calls = stubPhotoLookup();
		const tripId = tripWithPhotolessPois(3);

		expect(await photos.backfillTripPhotos(tripId)).toBe(3);
		expect(calls()).toBe(3);
		expect(pois.poisNeedingPhotos(tripId)).toEqual([]);
	});
});
