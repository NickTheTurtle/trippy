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
let lodging: typeof import('../src/persistence/lodging.ts');
let bus: typeof import('../src/events.ts');

beforeAll(async () => {
	[{ db }, auth, trips, schedule, lodging, bus] = await Promise.all([
		import('../src/db.ts'),
		import('../src/infra/auth.ts'),
		import('../src/persistence/trips.ts'),
		import('../src/persistence/schedule.ts'),
		import('../src/persistence/lodging.ts'),
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
		endDay?: string;
		title?: string;
		type?: 'activity' | 'food' | 'stay' | 'travel' | 'freetime';
		startMin: number;
		endMin: number;
		people: string[];
	} & Partial<{ lat: number; lng: number }>
): string {
	return schedule.createEvent(tripId, alice, {
		day: over.day ?? DAY,
		endDay: over.endDay ?? null,
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

	it('leaves for the night when the day ends, since a stay is a date not an hour', () => {
		add({ startMin: 540, endMin: 600, people: [alice], ...MUSEUM });
		add({ type: 'stay', startMin: 21 * 60, endMin: 24 * 60, people: [alice], ...HOTEL });
		const leg = schedule.legsForDay(tripId, DAY)[0];
		// Not 21:00 minus the walk: nobody waits three hours for the room to open.
		expect(leg.startMin).toBe(600);
		expect(leg.endMin).toBe(600 + leg.resolvedMins);
		expect(leg.tight).toBe(false);
	});
});

/**
 * "Everyone" is stored as no rows in `event_people`, so the roster has to be
 * put back before the planner sees the day. Until it was, a trip whose events
 * were all left on the default planned no journeys whatsoever.
 */
describe('an event left on Everyone travels with the whole trip', () => {
	it('plans the day when no event names anybody, instead of planning nothing', () => {
		add({ startMin: 540, endMin: 600, people: [], ...HOTEL });
		add({ startMin: 660, endMin: 720, people: [], ...MUSEUM });
		const legs = schedule.legsForDay(tripId, DAY);
		expect(legs).toHaveLength(1);
		expect(legs[0].people).toEqual([alice, bob].sort());
	});

	it('mixes Everyone with a named subset without merging the two journeys', () => {
		add({ startMin: 540, endMin: 600, people: [], ...HOTEL });
		add({ startMin: 660, endMin: 720, people: [alice], ...MUSEUM });
		add({ startMin: 780, endMin: 840, people: [], ...PARK });
		const legs = schedule.legsForDay(tripId, DAY);
		// Alice detours via the museum, Bob goes straight to the park: three
		// journeys, and Bob's is his own.
		expect(legs).toHaveLength(3);
		expect(legs.map((l) => l.people.join(',')).sort()).toEqual([alice, alice, bob].sort());
	});

	it("expands last night's stay too, so the morning starts for everybody on it", () => {
		add({
			day: '2026-09-30',
			type: 'stay',
			startMin: 21 * 60,
			endMin: 24 * 60,
			people: [],
			...HOTEL
		});
		add({ startMin: 600, endMin: 660, people: [], ...MUSEUM });
		const legs = schedule.legsForDay(tripId, DAY);
		expect(legs).toHaveLength(1);
		expect(legs[0].people).toEqual([alice, bob].sort());
		// Out of the stay, so anchored to midnight rather than to a checkout.
		expect(legs[0].startMin).toBeLessThan(600);
	});

	it('follows the roster rather than a copy of it, when somebody joins later', () => {
		add({ startMin: 540, endMin: 600, people: [], ...HOTEL });
		const second = add({ startMin: 660, endMin: 720, people: [], ...MUSEUM });
		const carol = auth.createUser('carol@example.test', 'Carol', 'hunter2hunter2').id;
		db.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'member')`).run(
			tripId,
			carol
		);
		// Any write reconciles the day; nothing about the events themselves changed.
		expect(schedule.setEventPeople(second, tripId, alice, [])).toBe(true);
		expect(schedule.legsForDay(tripId, DAY)[0].people).toEqual([alice, bob, carol].sort());
	});

	it('leaves out a member who has since left, rather than travelling with a ghost', () => {
		const first = add({ startMin: 540, endMin: 600, people: [alice, bob], ...HOTEL });
		const second = add({ startMin: 660, endMin: 720, people: [alice, bob], ...MUSEUM });
		// Bob leaves. His rows in `event_people` are the stale ids the planner
		// must not read as travellers.
		db.prepare(`DELETE FROM memberships WHERE trip_id = ? AND user_id = ?`).run(tripId, bob);
		const stillNamed = db
			.prepare(`SELECT COUNT(*) AS n FROM event_people WHERE event_id = ?`)
			.get(first);
		expect(stillNamed).toMatchObject({ n: 2 });
		schedule.recomputeLegs(tripId, DAY);

		const legs = schedule.legsForDay(tripId, DAY);
		expect(legs).toHaveLength(1);
		expect(legs[0].toEventId).toBe(second);
		expect(legs[0].people).toEqual([alice]);
	});

	it('plans nothing for a trip with nobody left on it, rather than throwing', () => {
		add({ startMin: 540, endMin: 600, people: [], ...HOTEL });
		add({ startMin: 660, endMin: 720, people: [], ...MUSEUM });
		db.prepare(`DELETE FROM memberships WHERE trip_id = ?`).run(tripId);
		schedule.recomputeLegs(tripId, DAY);
		expect(schedule.legsForDay(tripId, DAY)).toEqual([]);
	});

	it('reconciles days nobody has written since the expansion changed the plan', () => {
		add({ startMin: 540, endMin: 600, people: [], ...HOTEL });
		add({ startMin: 660, endMin: 720, people: [], ...MUSEUM });
		// What a database written by the old planner looks like: a day whose legs
		// were never stored, because the old planner found none.
		db.prepare(`DELETE FROM travel_legs WHERE trip_id = ? AND day = ?`).run(tripId, DAY);
		expect(schedule.legsForDay(tripId, DAY)).toEqual([]);

		expect(schedule.reconcileAllLegs()).toBeGreaterThan(0);
		expect(schedule.legsForDay(tripId, DAY)).toHaveLength(1);
	});
});

describe('a block with no location breaks the chain', () => {
	it('plans no journey across an event nobody has given an address', () => {
		add({ startMin: 540, endMin: 600, people: [alice], ...HOTEL });
		add({ startMin: 610, endMin: 650, people: [alice] });
		add({ startMin: 660, endMin: 720, people: [alice], ...MUSEUM });
		// Where Alice is between 10:10 and 10:50 is unknown, so an estimate from
		// the hotel would be a guess drawn as a fact.
		expect(schedule.legsForDay(tripId, DAY)).toEqual([]);
	});

	it('still lets a located hand-entered journey carry the chain', () => {
		add({ startMin: 540, endMin: 600, people: [alice], ...HOTEL });
		add({ type: 'travel', startMin: 600, endMin: 650, people: [alice], ...PARK });
		add({ startMin: 660, endMin: 720, people: [alice], ...MUSEUM });
		const legs = schedule.legsForDay(tripId, DAY);
		// Nothing is planned into the middle of the journey somebody typed, and
		// the leg out of where it lands is unaffected by the new break rule.
		expect(legs).toHaveLength(1);
		expect(legs[0].startMin).toBeLessThan(660);
	});
});

describe('a stay is a range of nights', () => {
	const THIRD = '2026-10-03';

	it('defaults to one night when no checkout is given', () => {
		const stay = add({ type: 'stay', startMin: 21 * 60, endMin: 24 * 60, people: [alice] });
		expect(db.prepare(`SELECT day, end_day FROM events WHERE id = ?`).get(stay)).toMatchObject({
			day: DAY,
			end_day: NEXT
		});
	});

	it('covers every night from arrival up to but not including checkout', () => {
		add({ type: 'stay', endDay: THIRD, startMin: 21 * 60, endMin: 24 * 60, people: [alice] });
		expect(schedule.staysCovering(tripId, DAY)).toHaveLength(1);
		expect(schedule.staysCovering(tripId, NEXT)).toHaveLength(1);
		// The checkout morning is not a night spent there.
		expect(schedule.staysCovering(tripId, THIRD)).toHaveLength(0);
	});

	it('is still on the board the morning it is checked out of', () => {
		add({ type: 'stay', endDay: THIRD, startMin: 21 * 60, endMin: 24 * 60, people: [alice] });
		// The room is still yours until you leave it, and it is where the day's
		// first journey starts, so the band runs a day past the last night.
		expect(schedule.staysOnBoard(tripId, DAY)).toHaveLength(1);
		expect(schedule.staysOnBoard(tripId, NEXT)).toHaveLength(1);
		expect(schedule.staysOnBoard(tripId, THIRD)).toHaveLength(1);
		expect(schedule.staysOnBoard(tripId, '2026-10-04')).toHaveLength(0);
	});

	it('bands a one-night stay on both its days', () => {
		add({ type: 'stay', startMin: 21 * 60, endMin: 24 * 60, people: [alice] });
		expect(schedule.staysOnBoard(tripId, DAY)).toHaveLength(1);
		expect(schedule.staysOnBoard(tripId, NEXT)).toHaveLength(1);
		expect(schedule.staysCovering(tripId, NEXT)).toHaveLength(0);
	});

	it('draws one chip when the same room is booked night by night', () => {
		add({ type: 'stay', title: 'Hotel', startMin: 21 * 60, endMin: 24 * 60, people: [alice] });
		add({
			day: NEXT,
			type: 'stay',
			title: 'Hotel',
			startMin: 21 * 60,
			endMin: 24 * 60,
			people: [alice]
		});
		// Checking out of a room and straight back into it is one stay to read.
		expect(schedule.staysOnBoard(tripId, NEXT)).toHaveLength(1);
		expect(schedule.staysOnBoard(tripId, NEXT)[0].day).toBe(NEXT);
	});

	it('draws both when the group changes hotel that morning', () => {
		add({ type: 'stay', title: 'Hotel', startMin: 21 * 60, endMin: 24 * 60, people: [alice] });
		add({
			day: NEXT,
			type: 'stay',
			title: 'Hostel',
			startMin: 21 * 60,
			endMin: 24 * 60,
			people: [alice]
		});
		expect(schedule.staysOnBoard(tripId, NEXT).map((s) => s.title)).toEqual(['Hotel', 'Hostel']);
	});

	it('holds several at once, because a group can sleep in two places', () => {
		add({ type: 'stay', title: 'Hotel', startMin: 21 * 60, endMin: 24 * 60, people: [alice] });
		add({ type: 'stay', title: 'Hostel', startMin: 21 * 60, endMin: 24 * 60, people: [bob] });
		const stays = schedule.staysCovering(tripId, DAY);
		expect(stays).toHaveLength(2);
		expect(stays.flatMap((s) => s.people).sort()).toEqual([alice, bob].sort());
	});

	it('stays out of the day it is on, because it is a band rather than a block', () => {
		add({ type: 'stay', startMin: 21 * 60, endMin: 24 * 60, people: [alice] });
		expect(schedule.eventsForDay(tripId, DAY)).toHaveLength(0);
	});

	it("starts each morning's first journey from where that person slept", () => {
		add({ type: 'stay', startMin: 21 * 60, endMin: 24 * 60, people: [alice, bob], ...HOTEL });
		add({ day: NEXT, startMin: 600, endMin: 660, people: [alice, bob], ...MUSEUM });

		const legs = schedule.legsForDay(tripId, NEXT);
		expect(legs).toHaveLength(1);
		expect(legs[0].people).toEqual([alice, bob].sort());
		expect(schedule.incomingStays(tripId, NEXT).map((s) => s.day)).toEqual([DAY]);
	});

	it('gives each half of a split group its own morning origin', () => {
		add({
			type: 'stay',
			title: 'Hotel',
			startMin: 21 * 60,
			endMin: 24 * 60,
			people: [alice],
			...HOTEL
		});
		add({
			type: 'stay',
			title: 'Hostel',
			startMin: 21 * 60,
			endMin: 24 * 60,
			people: [bob],
			...PARK
		});
		add({ day: NEXT, startMin: 600, endMin: 660, people: [alice], ...MUSEUM });
		add({ day: NEXT, startMin: 600, endMin: 660, people: [bob], ...MUSEUM });

		const legs = schedule.legsForDay(tripId, NEXT);
		expect(legs).toHaveLength(2);
		// Two journeys to the same morning, of different lengths, because they
		// start in different buildings.
		expect(new Set(legs.map((l) => l.km)).size).toBe(2);
	});

	it('leaves a morning alone when nobody slept anywhere', () => {
		add({ day: NEXT, startMin: 600, endMin: 660, people: [alice], ...MUSEUM });
		expect(schedule.legsForDay(tripId, NEXT)).toHaveLength(0);
		expect(schedule.incomingStays(tripId, NEXT)).toEqual([]);
	});

	it('plans the following morning as soon as a stay is added to the night before', () => {
		add({ day: NEXT, startMin: 600, endMin: 660, people: [alice], ...MUSEUM });
		expect(schedule.legsForDay(tripId, NEXT)).toHaveLength(0);

		// The write lands on DAY, but the day it changes is the one after it. This
		// is why every write recomputes the whole span plus the morning past it.
		add({ type: 'stay', startMin: 21 * 60, endMin: 24 * 60, people: [alice], ...HOTEL });
		expect(schedule.legsForDay(tripId, NEXT)).toHaveLength(1);
	});

	it('replans the days it leaves as well as the ones it arrives on', () => {
		const stay = add({
			type: 'stay',
			startMin: 21 * 60,
			endMin: 24 * 60,
			people: [alice],
			...HOTEL
		});
		const museum = add({ day: NEXT, startMin: 600, endMin: 660, people: [alice], ...MUSEUM });
		// The morning walk out of last night's hotel.
		expect(schedule.legsForDay(tripId, NEXT).map((l) => l.toEventId)).toEqual([museum]);

		// Moved a day later: the same morning now ends at the hotel instead of
		// starting from it, which only shows up because the write recomputed the
		// days the stay left as well as the ones it moved onto.
		expect(schedule.editEvent(stay, alice, { day: NEXT, endDay: THIRD }, tripId).ok).toBe(true);
		expect(schedule.legsForDay(tripId, NEXT).map((l) => l.fromEventId)).toEqual([museum]);
	});

	it('will not check out on or before the day it checks in', () => {
		const stay = add({
			type: 'stay',
			endDay: THIRD,
			startMin: 21 * 60,
			endMin: 24 * 60,
			people: [alice]
		});
		expect(schedule.editEvent(stay, alice, { endDay: DAY }, tripId).ok).toBe(true);
		expect(db.prepare(`SELECT end_day FROM events WHERE id = ?`).get(stay)).toMatchObject({
			end_day: NEXT
		});
	});

	it('drops the range when it stops being a stay', () => {
		const stay = add({
			type: 'stay',
			endDay: THIRD,
			startMin: 21 * 60,
			endMin: 24 * 60,
			people: [alice]
		});
		expect(schedule.editEvent(stay, alice, { type: 'activity' }, tripId).ok).toBe(true);
		expect(db.prepare(`SELECT end_day FROM events WHERE id = ?`).get(stay)).toMatchObject({
			end_day: null
		});
		// Back among the day's blocks, where an ordinary event belongs.
		expect(schedule.eventsForDay(tripId, DAY)).toHaveLength(1);
	});

	it('keeps its length in nights when it is moved to another day', () => {
		const stay = add({
			type: 'stay',
			endDay: THIRD,
			startMin: 21 * 60,
			endMin: 24 * 60,
			people: [alice]
		});
		expect(schedule.moveEvent(stay, alice, 21 * 60, tripId, NEXT)).toBe(true);
		// Two nights before, two nights after: a move is not a resize.
		expect(db.prepare(`SELECT day, end_day FROM events WHERE id = ?`).get(stay)).toMatchObject({
			day: NEXT,
			end_day: '2026-10-04'
		});
	});

	it('gains a range when an ordinary block becomes a stay', () => {
		const block = add({ startMin: 9 * 60, endMin: 10 * 60, people: [alice] });
		expect(schedule.editEvent(block, alice, { type: 'stay' }, tripId).ok).toBe(true);
		expect(db.prepare(`SELECT end_day FROM events WHERE id = ?`).get(block)).toMatchObject({
			end_day: NEXT
		});
	});

	it('tells Discover that a proposed stay is on the calendar', async () => {
		const lodging = await import('../src/persistence/lodging.ts');
		const cityId = trips.addCity(tripId, alice, {
			name: 'Athens',
			country: 'Greece',
			tz: 'Europe/Athens',
			lat: 37.98,
			lng: 23.73
		})!;
		const option = lodging.addOption(tripId, alice, cityId, 'Plaka apartments')!;
		const seen = () =>
			lodging
				.cityLodging(tripId, alice)
				.find((c) => c.id === cityId)!
				.options.find((o) => o.id === option)!.linked;

		// A proposal nobody has booked into carries no mark on its card.
		expect(seen()).toBe(0);

		schedule.createEvent(tripId, alice, {
			day: DAY,
			endDay: THIRD,
			title: 'Plaka apartments',
			type: 'stay',
			startMin: 21 * 60,
			endMin: 24 * 60,
			lat: null,
			lng: null,
			lodgingId: option,
			people: [alice]
		});
		// One band, however many nights it runs: the mark counts bookings, not
		// nights, which is what makes two crews in two rooms read as two.
		expect(seen()).toBe(1);
	});
});

describe('what an event type means', () => {
	it('clears the place when a block becomes free time, breaking the chain', () => {
		add({ startMin: 540, endMin: 600, people: [alice], ...HOTEL });
		const middle = add({ startMin: 630, endMin: 690, people: [alice], ...MUSEUM });
		add({ startMin: 720, endMin: 780, people: [alice], ...PARK });
		expect(schedule.legsForDay(tripId, DAY)).toHaveLength(2);

		expect(schedule.editEvent(middle, alice, { type: 'freetime' }, tripId).ok).toBe(true);
		expect(db.prepare(`SELECT lat, lng FROM events WHERE id = ?`).get(middle)).toMatchObject({
			lat: null,
			lng: null
		});
		// Nobody promised to be anywhere, so no journey is invented either side.
		expect(schedule.legsForDay(tripId, DAY)).toHaveLength(0);
	});

	it('plans nothing into a journey entered by hand, and resumes from where it lands', () => {
		add({ startMin: 540, endMin: 600, people: [alice], ...HOTEL });
		const manual = add({ type: 'travel', startMin: 600, endMin: 660, people: [alice], ...MUSEUM });
		const park = add({ startMin: 660, endMin: 720, people: [alice], ...PARK });
		const legs = schedule.legsForDay(tripId, DAY);
		expect(legs).toHaveLength(1);
		expect(legs[0].fromEventId).toBe(manual);
		expect(legs[0].toEventId).toBe(park);
	});

	it('breaks the chain at a journey entered by hand with no end location', () => {
		add({ startMin: 540, endMin: 600, people: [alice], ...HOTEL });
		add({ type: 'travel', startMin: 600, endMin: 660, people: [alice] });
		add({ startMin: 660, endMin: 720, people: [alice], ...PARK });
		expect(schedule.legsForDay(tripId, DAY)).toHaveLength(0);
	});
});

/**
 * Two people with the same event dialog open.
 *
 * Events were the last collaborative row in the app with no version on it.
 * Expenses and tasks had both been given one after a lost update was watched
 * happening; an event save still wrote the whole record back unconditionally,
 * so whoever pressed Save second silently erased the other's edit.
 */
describe('editing an event two people have open', () => {
	it('gives the first save the next version and refuses the second one', () => {
		const id = add({ startMin: 540, endMin: 600, people: [alice], ...MUSEUM });
		const opened = schedule.eventsForDay(tripId, DAY, alice).find((e) => e.id === id)!.version;

		const first = schedule.editEvent(id, alice, { title: 'Acropolis Museum' }, tripId, opened);
		expect(first.ok).toBe(true);
		expect(first.ok && first.version).toBe(opened + 1);

		// Bob's dialog still holds the version he opened on.
		const second = schedule.editEvent(id, bob, { title: 'Bob was here' }, tripId, opened);
		expect(second.ok).toBe(false);
		expect(second.ok === false && second.reason).toBe('conflict');

		const now = schedule.eventsForDay(tripId, DAY, alice).find((e) => e.id === id)!;
		expect(now.title).toBe('Acropolis Museum');
	});

	it('accepts the retry once the dialog has been reloaded onto the new version', () => {
		const id = add({ startMin: 540, endMin: 600, people: [alice], ...MUSEUM });
		const opened = schedule.eventsForDay(tripId, DAY, alice).find((e) => e.id === id)!.version;
		expect(schedule.editEvent(id, alice, { title: 'One' }, tripId, opened).ok).toBe(true);

		const reloaded = schedule.eventsForDay(tripId, DAY, bob).find((e) => e.id === id)!.version;
		expect(schedule.editEvent(id, bob, { title: 'Two' }, tripId, reloaded).ok).toBe(true);
		expect(schedule.eventsForDay(tripId, DAY, bob).find((e) => e.id === id)!.title).toBe('Two');
	});

	// A drag and a resize carry one field each and are deliberately unversioned:
	// holding a gesture to a version the board refetches constantly would refuse
	// perfectly good drags. Pinned so that stays a decision.
	it('lets an unversioned save through, which is what a drag relies on', () => {
		const id = add({ startMin: 540, endMin: 600, people: [alice], ...MUSEUM });
		schedule.editEvent(id, alice, { title: 'Moved on' }, tripId);
		expect(schedule.editEvent(id, bob, { title: 'And again' }, tripId).ok).toBe(true);
	});
});

/**
 * Deleting the stay everyone voted for.
 *
 * `events.lodging_id` is ON DELETE SET NULL, so the band that was booked into
 * the option used to survive it: still on the board, still holding its nights,
 * pointing at nothing, with nothing on screen saying why. Places had already
 * been given an explicit cascade for exactly this reason, so stays match them.
 */
describe('deleting a stay that is booked on the calendar', () => {
	function bookedStay() {
		const cityId = trips.addCity(tripId, alice, {
			name: 'Athens',
			country: 'Greece',
			tz: 'Europe/Athens',
			lat: 37.98,
			lng: 23.73
		})!;
		const optionId = lodging.addOption(tripId, alice, cityId, 'Hotel Grande')!;
		const eventId = schedule.createEvent(tripId, alice, {
			day: DAY,
			endDay: NEXT,
			title: 'Hotel Grande',
			type: 'stay',
			startMin: 21 * 60,
			endMin: 24 * 60,
			lodgingId: optionId,
			lat: HOTEL.lat,
			lng: HOTEL.lng,
			people: [alice]
		})!;
		return { cityId, optionId, eventId };
	}

	it('counts the booked band before it is deleted, so the question can say so', () => {
		const { cityId, optionId } = bookedStay();
		const city = lodging.cityLodging(tripId, alice).find((c) => c.id === cityId)!;
		expect(city.options.find((o) => o.id === optionId)!.linked).toBe(1);
	});

	it('takes the band with it instead of leaving it pointing at nothing', () => {
		const { optionId, eventId } = bookedStay();
		expect(lodging.removeOption(tripId, alice, optionId)).toBe(true);
		expect(schedule.eventsForDay(tripId, DAY, alice).some((e) => e.id === eventId)).toBe(false);
	});

	it('leaves every other event on the day alone', () => {
		const { optionId } = bookedStay();
		const other = add({ startMin: 540, endMin: 600, people: [alice], ...MUSEUM });
		expect(lodging.removeOption(tripId, alice, optionId)).toBe(true);
		expect(schedule.eventsForDay(tripId, DAY, alice).map((e) => e.id)).toEqual([other]);
	});
});

describe('a suggested time follows the day', () => {
	const times = (id: string) =>
		db.prepare(`SELECT start_min, end_min FROM events WHERE id = ?`).get(id) as {
			start_min: number;
			end_min: number;
		};

	it('places a new block after the one before it, plus the journey between them', () => {
		add({ startMin: 540, endMin: 600, people: [alice, bob], ...HOTEL });
		const lunch = schedule.createEvent(tripId, alice, {
			day: DAY,
			title: 'Lunch',
			type: 'food',
			// What the dialog opens at when nobody pointed at a time: the end of
			// the day so far, with the travel still to be added.
			startMin: 600,
			endMin: 660,
			...MUSEUM,
			people: [alice, bob],
			timeAuto: true
		})!;
		const at = times(lunch);
		expect(at.start_min).toBeGreaterThan(600);
		expect(at.end_min - at.start_min).toBe(60);
	});

	it('moves a suggested block when the block before it is lengthened', () => {
		const museum = add({ startMin: 540, endMin: 600, people: [alice, bob], ...HOTEL });
		const lunch = schedule.createEvent(tripId, alice, {
			day: DAY,
			title: 'Lunch',
			type: 'food',
			startMin: 600,
			endMin: 660,
			...MUSEUM,
			people: [alice, bob],
			timeAuto: true
		})!;
		const was = times(lunch).start_min;

		schedule.resizeEvent(museum, alice, 780, tripId);
		const now = times(lunch).start_min;
		expect(now).toBeGreaterThan(was);
		expect(now).toBeGreaterThanOrEqual(780);
		expect(times(lunch).end_min - now).toBe(60);
	});

	it('leaves a block somebody dragged where they dragged it', () => {
		const museum = add({ startMin: 540, endMin: 600, people: [alice, bob], ...HOTEL });
		const lunch = schedule.createEvent(tripId, alice, {
			day: DAY,
			title: 'Lunch',
			type: 'food',
			startMin: 600,
			endMin: 660,
			...MUSEUM,
			people: [alice, bob],
			timeAuto: true
		})!;

		// A drag is a choice, so the block stops following the day.
		schedule.moveEvent(lunch, alice, 900, tripId);
		schedule.resizeEvent(museum, alice, 780, tripId);
		expect(times(lunch).start_min).toBe(900);
	});

	it('leaves a block nobody marked as suggested alone, which is every old block', () => {
		const museum = add({ startMin: 540, endMin: 600, people: [alice, bob], ...HOTEL });
		const lunch = add({ startMin: 660, endMin: 720, people: [alice, bob], ...MUSEUM });

		schedule.resizeEvent(museum, alice, 780, tripId);
		expect(times(lunch).start_min).toBe(660);
	});

	it('does not pin a suggested block when an edit restates the time it already had', () => {
		const museum = add({ startMin: 540, endMin: 600, people: [alice, bob], ...HOTEL });
		const lunch = schedule.createEvent(tripId, alice, {
			day: DAY,
			title: 'Lunch',
			type: 'food',
			startMin: 600,
			endMin: 660,
			...MUSEUM,
			people: [alice, bob],
			timeAuto: true
		})!;
		const settled = times(lunch);

		// What the edit dialog sends when only the notes changed: every field it
		// shows, the unchanged time among them.
		schedule.editEvent(
			lunch,
			alice,
			{ notes: 'Book a table', startMin: settled.start_min, endMin: settled.end_min },
			tripId
		);
		schedule.resizeEvent(museum, alice, 780, tripId);
		expect(times(lunch).start_min).toBeGreaterThanOrEqual(780);
	});
});
