import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The schedule, as the database sees it.
 *
 * `packages/core/test/travel.test.ts` pins what the planner decides. This file
 * pins the two things only the persistence layer can get wrong: that a stored
 * leg is reconciled against the plan without losing a person's override, and
 * that a stay is allowed to end before it starts because it ends the next day.
 */

const tempRoot = join(tmpdir(), `trippy-schedule-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'schedule.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let auth: typeof import('../src/infra/auth.ts');
let trips: typeof import('../src/persistence/trips.ts');
let schedule: typeof import('../src/persistence/schedule.ts');
let bus: typeof import('../src/events.ts');

beforeAll(async () => {
	[{ db }, auth, trips, schedule, bus] = await Promise.all([
		import('../src/db.ts'),
		import('../src/infra/auth.ts'),
		import('../src/persistence/trips.ts'),
		import('../src/persistence/schedule.ts'),
		import('../src/events.ts')
	]);
});

const DAY = '2026-10-01';
const NEXT = '2026-10-02';

/* Far enough apart to be real journeys, close enough to stay inside one city. */
const HOTEL = { lat: 37.975, lng: 23.734 };
const MUSEUM = { lat: 37.968, lng: 23.729 };
const PARK = { lat: 37.99, lng: 23.742 };

let alice: string;
let bob: string;
let tripId: string;

beforeEach(() => {
	bus.closeAll();
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
	alice = auth.createUser('alice@example.test', 'Alice', 'hunter2hunter2').id;
	bob = auth.createUser('bob@example.test', 'Bob', 'hunter2hunter2').id;
	tripId = trips.createTrip(alice, {
		name: 'Athens',
		startDate: DAY,
		endDate: '2026-10-05',
		homeCurrency: 'EUR'
	})!.id;
	db.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'member')`).run(
		tripId,
		bob
	);
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

function add(
	over: {
		day?: string;
		title?: string;
		type?: 'activity' | 'food' | 'stay' | 'travel' | 'freetime';
		startMin: number;
		endMin: number;
		people: string[];
	} & Partial<{ lat: number; lng: number }>
): string {
	return schedule.createEvent(tripId, alice, {
		day: over.day ?? DAY,
		title: over.title ?? 'Stop',
		type: over.type ?? 'activity',
		startMin: over.startMin,
		endMin: over.endMin,
		lat: over.lat ?? null,
		lng: over.lng ?? null,
		people: over.people
	})!;
}

describe('legs follow the events', () => {
	it('plans one leg for a shared journey and two when the group splits', () => {
		add({ startMin: 540, endMin: 600, people: [alice, bob], ...HOTEL });
		add({ startMin: 660, endMin: 720, people: [alice, bob], ...MUSEUM });
		expect(schedule.legsForDay(tripId, DAY)).toHaveLength(1);

		// Nobody declares a split: an event simply carries different people.
		add({ startMin: 780, endMin: 840, people: [alice], ...PARK });
		add({ startMin: 780, endMin: 840, people: [bob], ...HOTEL });
		const legs = schedule.legsForDay(tripId, DAY);
		expect(legs).toHaveLength(3);
		expect(legs.filter((l) => l.people.length === 1)).toHaveLength(2);
	});

	it('removes a leg once the event it led to is gone', () => {
		add({ startMin: 540, endMin: 600, people: [alice], ...HOTEL });
		const second = add({ startMin: 660, endMin: 720, people: [alice], ...MUSEUM });
		expect(schedule.legsForDay(tripId, DAY)).toHaveLength(1);

		expect(schedule.deleteEvent(second, alice, tripId)).toBe(true);
		expect(schedule.legsForDay(tripId, DAY)).toHaveLength(0);
		expect(
			db.prepare(`SELECT COUNT(*) AS n FROM travel_legs WHERE trip_id = ?`).get(tripId)
		).toMatchObject({ n: 0 });
	});

	it('keeps an override when an unrelated edit moves the day around', () => {
		const first = add({ startMin: 540, endMin: 600, people: [alice, bob], ...HOTEL });
		add({ startMin: 660, endMin: 720, people: [alice, bob], ...MUSEUM });
		const leg = schedule.legsForDay(tripId, DAY)[0];

		expect(schedule.editLeg(leg.id, tripId, alice, 'ferry', 45)).toBe(true);
		// A drag changes the times but not who is going where, which is exactly
		// what the leg key is built from.
		expect(schedule.moveEvent(first, alice, 550, tripId)).toBe(true);

		const after = schedule.legsForDay(tripId, DAY)[0];
		expect(after.id).toBe(leg.id);
		expect(after.manual).toBe(true);
		expect(after.resolvedMode).toBe('ferry');
		expect(after.resolvedMins).toBe(45);
	});

	it('drops an override when the travelling group changes, rather than leaking it', () => {
		const first = add({ startMin: 540, endMin: 600, people: [alice, bob], ...HOTEL });
		const second = add({ startMin: 660, endMin: 720, people: [alice, bob], ...MUSEUM });
		const leg = schedule.legsForDay(tripId, DAY)[0];
		expect(schedule.editLeg(leg.id, tripId, alice, 'ferry', 45)).toBe(true);

		// Bob drops out of both ends. Alice's journey is a different journey now,
		// and a ferry booked for two is not a fact about it.
		expect(schedule.setEventPeople(first, tripId, alice, [alice])).toBe(true);
		expect(schedule.setEventPeople(second, tripId, alice, [alice])).toBe(true);

		const after = schedule.legsForDay(tripId, DAY)[0];
		expect(after.id).not.toBe(leg.id);
		expect(after.manual).toBe(false);
	});

	it('hands a leg back to the router when the override is cleared', () => {
		add({ startMin: 540, endMin: 600, people: [alice], ...HOTEL });
		add({ startMin: 660, endMin: 720, people: [alice], ...MUSEUM });
		const leg = schedule.legsForDay(tripId, DAY)[0];

		schedule.saveAutoLeg(tripId, DAY, leg.key, 'walk', 12);
		expect(schedule.editLeg(leg.id, tripId, alice, 'drive', 30)).toBe(true);
		expect(schedule.legsForDay(tripId, DAY)[0].resolvedMins).toBe(30);

		expect(schedule.editLeg(leg.id, tripId, alice, null, null)).toBe(true);
		const back = schedule.legsForDay(tripId, DAY)[0];
		expect(back.manual).toBe(false);
		expect(back.resolvedMode).toBe('walk');
		expect(back.resolvedMins).toBe(12);
	});

	it('never lets a provider answer overwrite what somebody typed', () => {
		add({ startMin: 540, endMin: 600, people: [alice], ...HOTEL });
		add({ startMin: 660, endMin: 720, people: [alice], ...MUSEUM });
		const leg = schedule.legsForDay(tripId, DAY)[0];
		expect(schedule.editLeg(leg.id, tripId, alice, 'cycle', 22)).toBe(true);

		schedule.saveAutoLeg(tripId, DAY, leg.key, 'drive', 9);

		const after = schedule.legsForDay(tripId, DAY)[0];
		expect(after.autoMins).toBe(9);
		expect(after.resolvedMins).toBe(22);
	});

	it('refuses a leg belonging to another trip', () => {
		add({ startMin: 540, endMin: 600, people: [alice], ...HOTEL });
		add({ startMin: 660, endMin: 720, people: [alice], ...MUSEUM });
		const leg = schedule.legsForDay(tripId, DAY)[0];
		const otherTrip = trips.createTrip(alice, {
			name: 'Elsewhere',
			startDate: DAY,
			endDate: NEXT,
			homeCurrency: 'EUR'
		})!.id;

		expect(schedule.editLeg(leg.id, otherTrip, alice, 'walk', 5)).toBe(false);
		expect(schedule.legsForDay(tripId, DAY)[0].manual).toBe(false);
	});

	it('estimates a journey until a provider has said better, so no gap is drawn', () => {
		add({ startMin: 540, endMin: 600, people: [alice], ...HOTEL });
		add({ startMin: 660, endMin: 720, people: [alice], ...MUSEUM });
		const leg = schedule.legsForDay(tripId, DAY)[0];
		expect(leg.autoMins).toBeNull();
		expect(leg.resolvedMins).toBeGreaterThan(0);
		// Anchored to the arrival: you leave in time for the thing you booked.
		expect(leg.endMin).toBe(660);
	});
});

describe('a stay spans midnight', () => {
	it('stores a checkout earlier than its check-in without correcting it', () => {
		const stay = add({
			type: 'stay',
			startMin: 21 * 60,
			endMin: 9 * 60,
			people: [alice],
			...HOTEL
		});
		const row = db.prepare(`SELECT start_min, end_min FROM events WHERE id = ?`).get(stay) as {
			start_min: number;
			end_min: number;
		};
		expect(row).toEqual({ start_min: 21 * 60, end_min: 9 * 60 });
	});

	it('moves the check-in without dragging the checkout into the next evening', () => {
		const stay = add({
			type: 'stay',
			startMin: 21 * 60,
			endMin: 9 * 60,
			people: [alice],
			...HOTEL
		});
		expect(schedule.moveEvent(stay, alice, 22 * 60, tripId)).toBe(true);
		expect(
			db.prepare(`SELECT start_min, end_min FROM events WHERE id = ?`).get(stay)
		).toMatchObject({ start_min: 22 * 60, end_min: 9 * 60 });
	});

	it("starts the next morning's first journey from last night's stay", () => {
		add({ type: 'stay', startMin: 21 * 60, endMin: 9 * 60, people: [alice, bob], ...HOTEL });
		add({ day: NEXT, startMin: 600, endMin: 660, people: [alice, bob], ...MUSEUM });

		const legs = schedule.legsForDay(tripId, NEXT);
		expect(legs).toHaveLength(1);
		expect(legs[0].people).toEqual([alice, bob].sort());
		expect(schedule.incomingStay(tripId, NEXT)?.day).toBe(DAY);
	});

	it('leaves a morning alone when nobody slept anywhere', () => {
		add({ day: NEXT, startMin: 600, endMin: 660, people: [alice], ...MUSEUM });
		expect(schedule.legsForDay(tripId, NEXT)).toHaveLength(0);
		expect(schedule.incomingStay(tripId, NEXT)).toBeNull();
	});

	it('plans the following morning as soon as a stay is added to the night before', () => {
		add({ day: NEXT, startMin: 600, endMin: 660, people: [alice], ...MUSEUM });
		expect(schedule.legsForDay(tripId, NEXT)).toHaveLength(0);

		// The write lands on DAY, but the day it changes is the one after it. This
		// is why every write recomputes both.
		add({ type: 'stay', startMin: 21 * 60, endMin: 9 * 60, people: [alice], ...HOTEL });
		expect(schedule.legsForDay(tripId, NEXT)).toHaveLength(1);
	});
});

describe('what an event type means', () => {
	it('clears the place when a block becomes free time, breaking the chain', () => {
		add({ startMin: 540, endMin: 600, people: [alice], ...HOTEL });
		const middle = add({ startMin: 630, endMin: 690, people: [alice], ...MUSEUM });
		add({ startMin: 720, endMin: 780, people: [alice], ...PARK });
		expect(schedule.legsForDay(tripId, DAY)).toHaveLength(2);

		expect(schedule.editEvent(middle, alice, { type: 'freetime' }, tripId)).toBe(true);
		expect(db.prepare(`SELECT lat, lng FROM events WHERE id = ?`).get(middle)).toMatchObject({
			lat: null,
			lng: null
		});
		// Nobody promised to be anywhere, so no journey is invented either side.
		expect(schedule.legsForDay(tripId, DAY)).toHaveLength(0);
	});

	it('suppresses automatic travel across a journey entered by hand', () => {
		add({ startMin: 540, endMin: 600, people: [alice], ...HOTEL });
		add({ type: 'travel', startMin: 600, endMin: 660, people: [alice], ...MUSEUM });
		add({ startMin: 660, endMin: 720, people: [alice], ...PARK });
		expect(schedule.legsForDay(tripId, DAY)).toHaveLength(0);
	});
});
