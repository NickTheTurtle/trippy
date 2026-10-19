import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Events that run past their own day, as the database stores and reads them.
 *
 * `packages/core/test/span-plan.test.ts` pins the rules. This file pins what
 * only the persistence layer can get wrong: the one stored form a write settles
 * a span into, the board listing a span on every day it covers, a drag or an
 * edit carrying the end day with it, the resize it refuses, the days a write
 * settles, and the day lists and arrows counting every covered day.
 */

const tempRoot = join(tmpdir(), `trippy-schedule-span-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'schedule-span.test.db');
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

const D1 = '2026-10-01';
const D2 = '2026-10-02';
const D3 = '2026-10-03';
const D4 = '2026-10-04';

const HOTEL = { lat: 37.975, lng: 23.734 };
const TRAILHEAD = { lat: 38.1, lng: 23.9 };
const TAVERNA = { lat: 38.12, lng: 23.95 };

let alice: string;
let bob: string;
let tripId: string;
let athens: string;
let tokyo: string;

beforeEach(() => {
	bus.closeAll();
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
	alice = auth.createUser('alice@example.test', 'Alice', 'hunter2hunter2').id;
	bob = auth.createUser('bob@example.test', 'Bob', 'hunter2hunter2').id;
	tripId = trips.createTrip(alice, {
		name: 'ZZ Span',
		startDate: D1,
		endDate: '2026-10-08',
		homeCurrency: 'EUR'
	})!.id;
	db.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'member')`).run(
		tripId,
		bob
	);
	athens = trips.addCity(tripId, alice, { name: 'Athens', country: 'GR', tz: 'Europe/Athens' })!;
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

type Over = Partial<Parameters<typeof schedule.createEvent>[2]>;

function add(over: Over): string {
	return schedule.createEvent(tripId, alice, {
		day: D1,
		title: 'ZZ Stop',
		type: 'activity',
		startMin: 600,
		endMin: 660,
		cityId: athens,
		people: [],
		...over
	})!;
}

interface Stored {
	day: string;
	end_day: string | null;
	end_city_id: string | null;
	start_min: number;
	end_min: number;
	time_auto: number;
	type: string;
}

function stored(id: string): Stored {
	return db
		.prepare(
			`SELECT day, end_day, end_city_id, start_min, end_min, time_auto, type FROM events WHERE id = ?`
		)
		.get(id) as unknown as Stored;
}

describe('a span is stored in one form', () => {
	it('stores an end day on its own day as none', () => {
		const id = add({ endDay: D1 });
		expect(stored(id).end_day).toBeNull();
	});

	it('keeps an end day on a later day, and never makes that block a suggestion', () => {
		const id = add({ endDay: D3, startMin: 480, endMin: 1020, timeAuto: true });
		expect(stored(id)).toMatchObject({ end_day: D3, start_min: 480, end_min: 1020, time_auto: 0 });
		// The one-day path is untouched: a suggestion is still a suggestion.
		expect(stored(add({ timeAuto: true })).time_auto).toBe(1);
	});

	it('does not clamp the end of a multi-day block under its start', () => {
		const id = add({ endDay: D2, startMin: 1320, endMin: 120 });
		expect(stored(id)).toMatchObject({ end_day: D2, start_min: 1320, end_min: 120 });
	});

	it('stores 00:00 tomorrow as 24:00 today', () => {
		const id = add({ endDay: D2, startMin: 1200, endMin: 0 });
		expect(stored(id)).toMatchObject({ end_day: null, end_min: 1440 });
	});

	it('ends a longer span that runs to midnight on the last day it fills', () => {
		// D1 08:00 to D4 00:00 covers D1 to D3, and D4 is not one of its days.
		const hike = add({ endDay: D4, startMin: 480, endMin: 0, people: [alice], ...TRAILHEAD });
		expect(stored(hike)).toMatchObject({ end_day: D3, end_min: 1440 });
		expect(schedule.scheduleDays(tripId)).toEqual([D1, D2, D3]);
		expect(schedule.eventsForDay(tripId, D4)).toEqual([]);
		// So nobody is still on it at D4's midnight: Alice wakes up at the hotel.
		add({ type: 'stay', title: 'ZZ Hotel', day: D3, endDay: D4, ...HOTEL });
		const lunch = add({ day: D4, startMin: 720, endMin: 780, ...TAVERNA });
		const legs = schedule.legsForDay(tripId, D4);
		expect(legs.map((l) => [l.toEventId, l.people])).toEqual([[lunch, [alice, bob].sort()]]);
	});

	it('keeps an arrival city only on a journey, and only when it is another city', () => {
		const flight = add({
			type: 'travel',
			endDay: D2,
			startMin: 22 * 60,
			endMin: 15 * 60,
			endCityId: tokyo
		});
		expect(stored(flight)).toMatchObject({ end_day: D2, end_city_id: tokyo, end_min: 900 });
		expect(stored(add({ type: 'travel', endCityId: athens })).end_city_id).toBeNull();
		expect(stored(add({ type: 'activity', endCityId: tokyo })).end_city_id).toBeNull();
	});

	it('stores a same-day journey west with its arrival clock, unclamped, and not as a suggestion', () => {
		const la = trips.addCity(tripId, alice, {
			name: 'Los Angeles',
			country: 'US',
			tz: 'America/Los_Angeles'
		})!;
		const id = add({
			type: 'travel',
			cityId: tokyo,
			startMin: 17 * 60,
			endMin: 11 * 60,
			endCityId: la,
			timeAuto: true
		});
		expect(stored(id)).toMatchObject({
			end_day: null,
			end_city_id: la,
			end_min: 660,
			time_auto: 0
		});
	});

	it('re-reads a journey on its departure clock when its arrival city is deleted', () => {
		const flight = add({
			type: 'travel',
			endDay: D2,
			startMin: 1320,
			endMin: 900,
			endCityId: tokyo
		});
		trips.removeCity(tripId, alice, tokyo);
		// 15:00 Tokyo (UTC+9) is 06:00 UTC, which is 09:00 in Athens (UTC+3).
		expect(stored(flight)).toMatchObject({
			day: D1,
			end_day: D2,
			start_min: 1320,
			end_min: 540,
			end_city_id: null
		});
	});

	it('re-reads a journey on its arrival clock when its departure city is deleted', () => {
		const flight = add({
			type: 'travel',
			endDay: D2,
			startMin: 1320,
			endMin: 900,
			endCityId: tokyo
		});
		trips.removeCity(tripId, alice, athens);
		// 22:00 Athens is 19:00 UTC, which is 04:00 the next morning in Tokyo.
		expect(stored(flight)).toMatchObject({
			day: D2,
			end_day: null,
			start_min: 240,
			end_min: 900,
			end_city_id: null
		});
		const row = db.prepare(`SELECT city_id FROM events WHERE id = ?`).get(flight) as {
			city_id: string;
		};
		expect(row.city_id).toBe(tokyo);
	});

	it('settles the days of what a deleted city named', () => {
		const GATE = { lat: 35.55, lng: 139.78 };
		add({
			type: 'travel',
			endDay: D2,
			startMin: 1320,
			endMin: 900,
			endCityId: tokyo,
			...GATE
		});
		// A suggested block where the flight lands follows the landing.
		const after = add({ day: D2, startMin: 1200, endMin: 1260, timeAuto: true, ...GATE });
		expect(stored(after)).toMatchObject({ start_min: 900, end_min: 960 });
		trips.removeCity(tripId, alice, tokyo);
		// The landing is 09:00 on the clock that is left, and the day is settled again.
		expect(stored(after)).toMatchObject({ start_min: 540, end_min: 600 });
	});
});

describe('the board lists a span on every day it covers', () => {
	it('lists it on each day, ordered by where its part of the day begins', () => {
		const hike = add({ title: 'ZZ Hike', endDay: D3, startMin: 480, endMin: 1020 });
		const breakfast = add({ title: 'ZZ Breakfast', day: D2, startMin: 420, endMin: 480 });
		const late = add({ title: 'ZZ Late', day: D3, startMin: 1200, endMin: 1260 });
		expect(schedule.eventsForDay(tripId, D1).map((e) => e.id)).toEqual([hike]);
		expect(schedule.eventsForDay(tripId, D2).map((e) => e.id)).toEqual([hike, breakfast]);
		expect(schedule.eventsForDay(tripId, D3).map((e) => e.id)).toEqual([hike, late]);
		expect(schedule.eventsForDay(tripId, D4)).toEqual([]);
		// The row itself is the same on every day: the client asks core where it sits.
		const row = schedule.eventsForDay(tripId, D2)[0];
		expect(row).toMatchObject({ day: D1, end_day: D3, start_min: 480, end_min: 1020 });
		expect(row.end_city_id).toBeNull();
	});

	it('leaves stays out of the day, as before', () => {
		add({ type: 'stay', endDay: D3 });
		expect(schedule.eventsForDay(tripId, D2)).toEqual([]);
	});
});

describe('a span moves as a whole', () => {
	it('carries the end day with a drag across days', () => {
		const id = add({ endDay: D2, startMin: 1320, endMin: 120 });
		expect(schedule.moveEvent(id, alice, 1320, tripId, D3)).toBe(true);
		expect(stored(id)).toMatchObject({ day: D3, end_day: D4, start_min: 1320, end_min: 120 });
	});

	it('keeps its real length when dragged along the clock', () => {
		const id = add({ endDay: D2, startMin: 1320, endMin: 120 });
		schedule.moveEvent(id, alice, 1380, tripId);
		expect(stored(id)).toMatchObject({ day: D1, end_day: D2, start_min: 1380, end_min: 180 });
		// Earlier, so it lands at 00:00 the next day: one day, ending at midnight.
		schedule.moveEvent(id, alice, 1200, tripId);
		expect(stored(id)).toMatchObject({ day: D1, end_day: null, start_min: 1200, end_min: 1440 });
	});

	it('still keeps a one-day block inside its day', () => {
		const id = add({ startMin: 600, endMin: 720 });
		schedule.moveEvent(id, alice, 1400, tripId, D2);
		expect(stored(id)).toMatchObject({ day: D2, end_day: null, start_min: 1320, end_min: 1440 });
	});

	it('carries the end day with a day change in an edit', () => {
		const id = add({ endDay: D3, startMin: 480, endMin: 1020 });
		const res = schedule.editEvent(id, alice, { day: D2 }, tripId);
		expect(res.ok).toBe(true);
		expect(stored(id)).toMatchObject({ day: D2, end_day: D4, start_min: 480, end_min: 1020 });
	});

	it('ends on its own day when an edit sends a null end day', () => {
		const id = add({ endDay: D3, startMin: 480, endMin: 1020 });
		schedule.editEvent(id, alice, { endDay: null }, tripId);
		expect(stored(id)).toMatchObject({ day: D1, end_day: null, end_min: 1020 });
	});

	it('takes an end day and an arrival city from an edit', () => {
		const id = add({ type: 'travel', startMin: 1320, endMin: 1380 });
		schedule.editEvent(id, alice, { endDay: D2, endMin: 900, endCityId: tokyo }, tripId);
		expect(stored(id)).toMatchObject({ end_day: D2, end_city_id: tokyo, end_min: 900 });
		// Absent leaves the arrival city alone; null clears it.
		schedule.editEvent(id, alice, { title: 'ZZ Flight' }, tripId);
		expect(stored(id).end_city_id).toBe(tokyo);
		schedule.editEvent(id, alice, { endCityId: null }, tripId);
		expect(stored(id).end_city_id).toBeNull();
	});

	it('drops the arrival city when a journey becomes something else', () => {
		const id = add({ type: 'travel', endDay: D2, startMin: 1320, endMin: 900, endCityId: tokyo });
		schedule.editEvent(id, alice, { type: 'activity' }, tripId);
		expect(stored(id)).toMatchObject({ type: 'activity', end_city_id: null, end_day: D2 });
	});

	it('clears the time suggestion when an edit makes a block run over days', () => {
		const id = add({ timeAuto: true });
		schedule.editEvent(id, alice, { endDay: D2 }, tripId);
		expect(stored(id).time_auto).toBe(0);
	});
});

describe('a stay and another type swap without leaving the range incoherent', () => {
	it('drops a checkout when a stay becomes an activity', () => {
		const id = add({ type: 'stay', endDay: D3 });
		schedule.editEvent(id, alice, { type: 'activity' }, tripId);
		expect(stored(id)).toMatchObject({ type: 'activity', end_day: null });
	});

	it('takes an end day sent with the change from a stay', () => {
		const id = add({ type: 'stay', endDay: D3 });
		schedule.editEvent(
			id,
			alice,
			{ type: 'activity', endDay: D2, startMin: 600, endMin: 660 },
			tripId
		);
		expect(stored(id)).toMatchObject({ type: 'activity', end_day: D2 });
	});

	it('reads a block end day as the checkout when it becomes a stay', () => {
		const hike = add({ endDay: D3, startMin: 480, endMin: 1020 });
		schedule.editEvent(hike, alice, { type: 'stay' }, tripId);
		expect(stored(hike)).toMatchObject({ type: 'stay', end_day: D3 });
		const lunch = add({});
		schedule.editEvent(lunch, alice, { type: 'stay' }, tripId);
		expect(stored(lunch)).toMatchObject({ type: 'stay', end_day: D2 });
	});
});

describe('the bottom edge of a span', () => {
	it('is not a resize handle', () => {
		const id = add({ endDay: D2, startMin: 1320, endMin: 120 });
		expect(schedule.resizable(id)).toBe(false);
		expect(schedule.resizeEvent(id, alice, 300, tripId)).toBe(false);
		expect(stored(id).end_min).toBe(120);
	});

	it('cannot drag a journey between two clocks, and can drag a span on one', () => {
		const flight = add({
			type: 'travel',
			endDay: D2,
			startMin: 1320,
			endMin: 900,
			endCityId: tokyo
		});
		expect(schedule.movable(flight)).toBe(false);
		expect(schedule.moveEvent(flight, alice, 1380, tripId)).toBe(false);
		expect(stored(flight)).toMatchObject({ start_min: 1320, end_min: 900 });
		expect(schedule.movable(add({ endDay: D2, startMin: 1320, endMin: 120 }))).toBe(true);
	});

	it('still resizes a one-day block and a stay', () => {
		const id = add({});
		expect(schedule.resizable(id)).toBe(true);
		expect(schedule.resizeEvent(id, alice, 720, tripId)).toBe(true);
		expect(stored(id).end_min).toBe(720);
		expect(schedule.resizable(add({ type: 'stay', endDay: D3 }))).toBe(true);
	});
});

describe('planning around a span', () => {
	it('does not start a covered day at last night for the people on a multi-day activity', () => {
		add({ type: 'stay', title: 'ZZ Hotel', endDay: D4, ...HOTEL });
		add({
			title: 'ZZ Hike',
			endDay: D3,
			startMin: 480,
			endMin: 1020,
			people: [alice],
			...TRAILHEAD
		});
		const lunch = add({
			title: 'ZZ Lunch',
			day: D2,
			startMin: 720,
			endMin: 780,
			people: [bob],
			...TAVERNA
		});
		const legs = schedule.legsForDay(tripId, D2);
		// Alice spent the night on the mountain; only Bob leaves the hotel for lunch.
		expect(legs.map((l) => [l.toEventId, l.people])).toEqual([[lunch, [bob]]]);
	});

	it('goes on from a continuing journey where it lands', () => {
		add({ type: 'stay', title: 'ZZ Athens hotel', endDay: D2, ...HOTEL });
		const flight = add({
			type: 'travel',
			title: 'ZZ Flight',
			endDay: D2,
			startMin: 22 * 60,
			endMin: 15 * 60,
			endCityId: tokyo,
			lat: 35.55,
			lng: 139.78
		});
		const sushi = add({
			title: 'ZZ Sushi',
			day: D2,
			cityId: tokyo,
			startMin: 19 * 60,
			endMin: 20 * 60,
			lat: 35.66,
			lng: 139.7
		});
		const legs = schedule.legsForDay(tripId, D2);
		expect(legs.map((l) => [l.fromEventId, l.toEventId])).toEqual([[flight, sushi]]);
	});

	it('settles every day of the span and the morning after when it is written', () => {
		// A suggested dinner on the last day, at the same place the hike ends, so
		// the only thing that can move it is the hike being settled on that day.
		const dinner = add({
			title: 'ZZ Dinner',
			day: D3,
			startMin: 540,
			endMin: 600,
			timeAuto: true,
			...TRAILHEAD
		});
		expect(stored(dinner)).toMatchObject({ start_min: 540, end_min: 600 });
		add({ title: 'ZZ Hike', endDay: D3, startMin: 480, endMin: 1020, ...TRAILHEAD });
		expect(stored(dinner)).toMatchObject({ start_min: 1020, end_min: 1080 });
	});
});

describe('which days carry something', () => {
	it('counts every day a span covers, and a stay only by its own day', () => {
		add({ endDay: D3, startMin: 480, endMin: 1020 });
		add({ type: 'stay', day: '2026-10-06', endDay: '2026-10-09' });
		expect(schedule.scheduleDays(tripId)).toEqual([D1, D2, D3, '2026-10-06']);
		expect(schedule.dayHasEvents(tripId, D2)).toBe(true);
		expect(schedule.dayHasEvents(tripId, D4)).toBe(false);
		expect(schedule.dayHasEvents(tripId, '2026-10-07')).toBe(false);
		expect(schedule.scheduledDayEdges(tripId)).toEqual({ first: D1, last: '2026-10-06' });
	});

	it('steps to the nearest covered day either side', () => {
		add({ day: D2, endDay: D4, startMin: 480, endMin: 1020 });
		expect(schedule.scheduledDayAfter(tripId, D1)).toBe(D2);
		expect(schedule.scheduledDayAfter(tripId, D2)).toBe(D3);
		expect(schedule.scheduledDayAfter(tripId, D4)).toBeNull();
		expect(schedule.scheduledDayBefore(tripId, '2026-10-07')).toBe(D4);
		expect(schedule.scheduledDayBefore(tripId, D3)).toBe(D2);
		expect(schedule.scheduledDayBefore(tripId, D2)).toBeNull();
	});

	it('counts a span stranded outside the dates day by day', () => {
		add({ day: '2026-10-07', endDay: '2026-10-10', startMin: 480, endMin: 1020 });
		add({ type: 'stay', day: '2026-10-08', endDay: '2026-10-12' });
		expect(schedule.strandedDayCount(tripId, D1, '2026-10-08')).toBe(2);
		expect(schedule.scheduledDayEdges(tripId).last).toBe('2026-10-10');
	});

	it('finds a long span that ends after every later start', () => {
		// Eleven days from D1, with the latest start of the trip on D3.
		add({ endDay: '2026-10-12', startMin: 480, endMin: 1020 });
		add({ day: D3 });
		expect(schedule.scheduledDayEdges(tripId)).toEqual({ first: D1, last: '2026-10-12' });
		expect(schedule.scheduledDayBefore(tripId, '2026-10-20')).toBe('2026-10-12');
		expect(schedule.scheduledDayAfter(tripId, '2026-10-05')).toBe('2026-10-06');
		expect(schedule.scheduledDayAfter(tripId, '2026-10-12')).toBeNull();
		expect(schedule.dayHasEvents(tripId, '2026-10-12')).toBe(true);
		expect(schedule.eventsForDay(tripId, '2026-10-12')).toHaveLength(1);
	});
});
