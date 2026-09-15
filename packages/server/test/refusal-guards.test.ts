import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Two organizer-only refusals that only the persistence layer can enforce, and
 * that nothing else pins.
 *
 * `lockOption` is the choice of which stay a city sleeps in: a member may vote,
 * but only the organizer may lock, and the route reports the refusal as a 403.
 * `leaveTrip` is a member walking away: everyone but the organizer may, because
 * the organizer leaving would orphan the trip. Both return a plain boolean, so
 * they are pinned here at the layer that decides, not through the browser.
 */

const tempRoot = join(tmpdir(), `trippy-refusal-guards-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'refusal-guards.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let auth: typeof import('../src/infra/auth.ts');
let trips: typeof import('../src/persistence/trips.ts');
let members: typeof import('../src/persistence/members.ts');
let lodging: typeof import('../src/persistence/lodging.ts');
let events: typeof import('../src/events.ts');

beforeAll(async () => {
	[{ db }, auth, trips, members, lodging, events] = await Promise.all([
		import('../src/db.ts'),
		import('../src/infra/auth.ts'),
		import('../src/persistence/trips.ts'),
		import('../src/persistence/members.ts'),
		import('../src/persistence/lodging.ts'),
		import('../src/events.ts')
	]);
});

let organizer: string;
let member: string;
let tripId: string;
let cityId: string;

beforeEach(() => {
	events.closeAll();
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
	organizer = auth.createUser('org@example.test', 'Org', 'hunter2hunter2').id;
	member = auth.createUser('member@example.test', 'Member', 'hunter2hunter2').id;
	tripId = trips.createTrip(organizer, {
		name: 'Kyoto',
		startDate: '2026-10-01',
		endDate: '2026-10-03',
		homeCurrency: 'USD'
	}).id!;
	expect(members.addPerson(tripId, organizer, 'Member', auth.findUserById(member)!.email)).toBe(
		'added'
	);
	cityId = trips.addCity(tripId, organizer, {
		name: 'Kyoto',
		country: 'Japan',
		tz: 'Asia/Tokyo',
		lat: 35.01,
		lng: 135.77
	})!;
});

afterAll(() => {
	events.closeAll();
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

const lockedFlag = (optionId: string): number =>
	(db.prepare(`SELECT locked FROM lodging_options WHERE id = ?`).get(optionId) as { locked: number })
		.locked;

describe('lockOption is organizer-only', () => {
	it('refuses a member and leaves the option unlocked', () => {
		const optionId = lodging.addOption(tripId, organizer, cityId, 'Ryokan')!;
		expect(lodging.lockOption(tripId, member, optionId)).toBe(false);
		expect(lockedFlag(optionId)).toBe(0);
	});

	it('lets the organizer lock an option', () => {
		const optionId = lodging.addOption(tripId, organizer, cityId, 'Ryokan')!;
		expect(lodging.lockOption(tripId, organizer, optionId)).toBe(true);
		expect(lockedFlag(optionId)).toBe(1);
	});

	it('locks one option per city, clearing any other lock there', () => {
		const first = lodging.addOption(tripId, organizer, cityId, 'Ryokan')!;
		const second = lodging.addOption(tripId, organizer, cityId, 'Hostel')!;
		expect(lodging.lockOption(tripId, organizer, first)).toBe(true);
		expect(lodging.lockOption(tripId, organizer, second)).toBe(true);
		// The city sleeps in one place, so locking the second clears the first.
		expect(lockedFlag(first)).toBe(0);
		expect(lockedFlag(second)).toBe(1);
	});

	it('unlocks an option that is already locked (the lock button toggles)', () => {
		const optionId = lodging.addOption(tripId, organizer, cityId, 'Ryokan')!;
		expect(lodging.lockOption(tripId, organizer, optionId)).toBe(true);
		expect(lockedFlag(optionId)).toBe(1);
		// Pressing lock again on the current choice takes the city back to undecided.
		expect(lodging.lockOption(tripId, organizer, optionId)).toBe(true);
		expect(lockedFlag(optionId)).toBe(0);
	});

	it('refuses an option that belongs to another trip', () => {
		const otherTrip = trips.createTrip(organizer, {
			name: 'Oslo',
			startDate: '2026-11-01',
			endDate: '2026-11-03',
			homeCurrency: 'USD'
		}).id!;
		const otherCity = trips.addCity(otherTrip, organizer, {
			name: 'Oslo',
			country: 'Norway',
			tz: 'Europe/Oslo',
			lat: 59.91,
			lng: 10.75
		})!;
		const elsewhere = lodging.addOption(otherTrip, organizer, otherCity, 'Cabin')!;
		// Organizer of this trip, but the option lives in a trip this call names wrong.
		expect(lodging.lockOption(tripId, organizer, elsewhere)).toBe(false);
		expect(lockedFlag(elsewhere)).toBe(0);
	});
});

describe('leaveTrip refuses the organizer', () => {
	const isMember = (userId: string): boolean =>
		db.prepare(`SELECT 1 FROM memberships WHERE trip_id = ? AND user_id = ?`).get(tripId, userId) !==
		undefined;

	it('refuses the organizer, who would orphan the trip', () => {
		expect(trips.leaveTrip(tripId, organizer)).toBe(false);
		expect(isMember(organizer)).toBe(true);
	});

	it('lets a regular member leave', () => {
		expect(trips.leaveTrip(tripId, member)).toBe(true);
		expect(isMember(member)).toBe(false);
		// The organizer stays put: one departure is not the whole roster.
		expect(isMember(organizer)).toBe(true);
	});

	it('refuses somebody who is not on the trip at all', () => {
		const stranger = auth.createUser('stranger@example.test', 'Stranger', 'hunter2hunter2').id;
		expect(trips.leaveTrip(tripId, stranger)).toBe(false);
	});
});
