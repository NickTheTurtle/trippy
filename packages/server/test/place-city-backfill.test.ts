import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The one-off pass that moves a place-linked block to its place's city.
 *
 * Blocks written before a linked place decided the city carry the trip's first
 * city. The pass in `db.ts` corrects them once. This pins what it may and may
 * not do to real rows: only `city_id` changes, only on a non-journey block
 * linked to a place on the same trip, never on travel or free time, and a
 * second run changes nothing.
 */

const tempRoot = join(tmpdir(), `trippy-place-city-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'place-city.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let dbMod: typeof import('../src/db.ts');
let db: (typeof import('../src/db.ts'))['db'];
let auth: typeof import('../src/infra/auth.ts');
let trips: typeof import('../src/persistence/trips.ts');
let schedule: typeof import('../src/persistence/schedule.ts');
let pois: typeof import('../src/persistence/pois.ts');
let lodging: typeof import('../src/persistence/lodging.ts');
let bus: typeof import('../src/events.ts');

beforeAll(async () => {
	[dbMod, auth, trips, schedule, pois, lodging, bus] = await Promise.all([
		import('../src/db.ts'),
		import('../src/infra/auth.ts'),
		import('../src/persistence/trips.ts'),
		import('../src/persistence/schedule.ts'),
		import('../src/persistence/pois.ts'),
		import('../src/persistence/lodging.ts'),
		import('../src/events.ts')
	]);
	db = dbMod.db;
});

const DAY = '2026-10-02';

let alice: string;
let tripId: string;
let la: string;
let tokyo: string;

beforeEach(() => {
	bus.closeAll();
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
	alice = auth.createUser('alice@example.test', 'Alice', 'hunter2hunter2').id;
	tripId = trips.createTrip(alice, {
		name: 'ZZ Backfill',
		startDate: '2026-10-01',
		endDate: '2026-10-05',
		homeCurrency: 'USD'
	})!.id;
	la = trips.addCity(tripId, alice, {
		name: 'Los Angeles',
		country: 'US',
		tz: 'America/Los_Angeles'
	})!;
	tokyo = trips.addCity(tripId, alice, { name: 'Tokyo', country: 'JP', tz: 'Asia/Tokyo' })!;
});

afterAll(() => {
	bus.closeAll();
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const path = `${dbPath}${suffix}`;
		if (existsSync(path)) rmSync(path, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

/** Every column of a row, so a test can prove which of them moved. */
function row(id: string): Record<string, unknown> {
	return db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as Record<string, unknown>;
}

function add(over: Partial<Parameters<typeof schedule.createEvent>[2]>): string {
	const id = schedule.createEvent(tripId, alice, {
		day: DAY,
		title: 'ZZ Block',
		type: 'activity',
		startMin: 600,
		endMin: 660,
		people: [],
		...over
	})!;
	// Written as every block before linked places decided the city was: on the
	// trip's first city, whatever it is linked to.
	db.prepare(`UPDATE events SET city_id = ? WHERE id = ?`).run(la, id);
	return id;
}

describe('moving place-linked blocks to their place city', () => {
	it('runs once at boot under its marker', () => {
		expect(dbMod.backfillDone('events.city_id-from-linked-place')).toBe(true);
	});

	it('changes only city_id, only on linked blocks that are not journeys, and only once', () => {
		const museumPoi = pois.addPoi(
			tripId,
			alice,
			tokyo,
			'ZZ Museum',
			'Museum',
			null,
			null,
			35.7,
			139.7
		)!;
		const hotel = lodging.addOption(tripId, alice, tokyo, 'ZZ Hotel', { lat: 35.68, lng: 139.76 })!;

		const museum = add({ poiId: museumPoi, lat: 35.7, lng: 139.7 });
		const meal = add({ type: 'food', poiId: museumPoi, lat: 35.7, lng: 139.7 });
		const stay = add({ type: 'stay', endDay: '2026-10-03', lodgingId: hotel });
		const flight = add({ type: 'travel', poiId: museumPoi, startMin: 1020, endMin: 1080 });
		const typed = add({ placeText: 'ZZ Cafe' });
		const idle = add({ type: 'freetime' });
		// Free time cannot be linked through the API; forced here so the pass is
		// proven to leave it alone even if a row somehow is.
		db.prepare(`UPDATE events SET poi_id = ? WHERE id = ?`).run(museumPoi, idle);
		db.prepare(`UPDATE events SET time_auto = 1 WHERE id = ?`).run(museum);

		const ids = [museum, meal, stay, flight, typed, idle];
		const before = new Map(ids.map((id) => [id, row(id)]));

		expect(dbMod.backfillPlaceCities()).toBe(3);

		for (const id of [museum, meal, stay]) {
			const { city_id, ...rest } = row(id);
			const { city_id: was, ...restBefore } = before.get(id)!;
			expect(was).toBe(la);
			expect(city_id).toBe(tokyo);
			// No date, minute, version, flag or link moved with it.
			expect(rest).toEqual(restBefore);
		}
		for (const id of [flight, typed, idle]) expect(row(id)).toEqual(before.get(id));

		// Already right, so a second run touches nothing.
		const after = new Map(ids.map((id) => [id, row(id)]));
		expect(dbMod.backfillPlaceCities()).toBe(0);
		for (const id of ids) expect(row(id)).toEqual(after.get(id));
	});
});
