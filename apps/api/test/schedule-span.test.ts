import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { segmentOn, type SpanRow } from '@trippy/core/span';

/**
 * Events that run past their own day, over HTTP.
 *
 * What the clients build against: `POST /events` and the `edit` op take an
 * `endDay` (null for "its own day") and a journey's `endCityId`, and a block
 * whose end is on another day or another clock sends `endMin`, its end as read
 * on its last day. The refusals are the sentences under `copy.schedule.span`.
 * A drag carries the end day with it, a resize of such a block is refused, and
 * the board and the agenda list it on every day it covers, as one unchanged row.
 */

const tempRoot = join(tmpdir(), `trippy-api-schedule-span-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'api.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let lodging: typeof import('@trippy/server/lodging');
let pois: typeof import('@trippy/server/pois');
let app: Hono;

interface Fixture {
	cookie: string;
	tripId: string;
	athens: string;
	tokyo: string;
	la: string;
}

const START = '2026-10-01';
const END = '2026-10-20';
const D1 = '2026-10-02';
const D2 = '2026-10-03';
const D3 = '2026-10-04';

const END_BEFORE_START = 'The end must be after the start.';
const TOO_LONG = 'An event can run for at most 14 days.';
const OUTSIDE = 'Pick an end date within the trip.';

beforeAll(async () => {
	const [dbMod, authMod, tripsMod, lodgingMod, poisMod, middleware, routes] = await Promise.all([
		import('@trippy/server/db'),
		import('@trippy/server/auth'),
		import('@trippy/server/trips'),
		import('@trippy/server/lodging'),
		import('@trippy/server/pois'),
		import('../src/middleware.ts'),
		import('../src/routes/schedule.ts')
	]);
	db = dbMod.db;
	auth = authMod;
	trips = tripsMod;
	lodging = lodgingMod;
	pois = poisMod;

	app = new Hono();
	app.use('*', middleware.session);
	app.route('/trips/:tripId/schedule', routes.schedule as unknown as Hono);
});

beforeEach(() => {
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
});

afterAll(() => {
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

function fixture(): Fixture {
	const organizer = auth.createUser(
		`span-${crypto.randomUUID()}@example.test`,
		'ZZ Organizer',
		'password123'
	).id;
	const tripId = trips.createTrip(organizer, {
		name: 'ZZ Span Trip',
		startDate: START,
		endDate: END,
		homeCurrency: 'USD'
	}).id!;
	const city = (name: string, country: string, tz: string) =>
		trips.addCity(tripId, organizer, { name, country, tz })!;
	return {
		cookie: `session=${auth.createSession(organizer)}`,
		tripId,
		athens: city('Athens', 'GR', 'Europe/Athens'),
		tokyo: city('Tokyo', 'JP', 'Asia/Tokyo'),
		la: city('Los Angeles', 'US', 'America/Los_Angeles')
	};
}

function post(f: Fixture, body: Record<string, unknown>) {
	return app.request(`/trips/${f.tripId}/schedule/events`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: f.cookie },
		body: JSON.stringify({
			day: D1,
			start: 9 * 60,
			duration: 60,
			title: 'ZZ Block',
			cityId: f.athens,
			...body
		})
	});
}

function op(f: Fixture, eventId: string, body: Record<string, unknown>) {
	return app.request(`/trips/${f.tripId}/schedule/events/${eventId}/op`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: f.cookie },
		body: JSON.stringify(body)
	});
}

function board(f: Fixture, query: string) {
	return app.request(`/trips/${f.tripId}/schedule${query}`, { headers: { cookie: f.cookie } });
}

async function created(res: Response): Promise<string> {
	expect(res.status, await res.clone().text()).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

async function refused(res: Response, message: string): Promise<void> {
	expect(res.status).toBe(400);
	expect(((await res.json()) as { error: string }).error).toBe(message);
}

interface Row {
	day: string;
	end_day: string | null;
	end_city_id: string | null;
	start_min: number;
	end_min: number;
}

function stored(id: string): Row {
	return db
		.prepare(`SELECT day, end_day, end_city_id, start_min, end_min FROM events WHERE id = ?`)
		.get(id) as unknown as Row;
}

/** A two-night hike, 08:00 on D1 to 17:00 on D3. */
async function hike(f: Fixture): Promise<string> {
	return created(await post(f, { title: 'ZZ Hike', start: 480, endDay: D3, endMin: 1020 }));
}

describe('creating a block that runs past its own day', () => {
	it('stores the end day and the end as read on the last day', async () => {
		const f = fixture();
		const id = await hike(f);
		expect(stored(id)).toMatchObject({ day: D1, end_day: D3, start_min: 480, end_min: 1020 });
	});

	it('stores an end day of its own day, or null, as one day', async () => {
		const f = fixture();
		expect(stored(await created(await post(f, { endDay: D1 }))).end_day).toBeNull();
		expect(stored(await created(await post(f, { endDay: null }))).end_day).toBeNull();
	});

	it('stores a block ending at 00:00 tomorrow as one ending at midnight, even on the last day', async () => {
		const f = fixture();
		const id = await created(
			await post(f, { day: END, start: 1200, endDay: '2026-10-21', endMin: 0 })
		);
		expect(stored(id)).toMatchObject({ day: END, end_day: null, end_min: 1440 });
	});

	it('reads start plus duration as the end on the last day when no end time is sent', async () => {
		const f = fixture();
		// 22:00 tonight to 07:00 tomorrow, as a client that sends the clock difference.
		const id = await created(await post(f, { start: 1320, duration: -900, endDay: D2 }));
		expect(stored(id)).toMatchObject({ end_day: D2, start_min: 1320, end_min: 420 });
		await refused(
			await post(f, { start: 600, duration: 1000, endDay: D2 }),
			'Pick an end time within the day.'
		);
		await refused(await post(f, { start: 600, endMin: 'noon', endDay: D2 }), 'Pick an end time.');
	});

	it('ends a longer span that runs to midnight on the last day it fills', async () => {
		const f = fixture();
		const id = await created(await post(f, { start: 480, endDay: '2026-10-05', endMin: 0 }));
		expect(stored(id)).toMatchObject({ day: D1, end_day: D3, end_min: 1440 });
		const monday = (await (await board(f, `?view=agenda&day=2026-10-05`)).json()) as {
			board: { day: string; events: unknown[] }[];
		};
		expect(monday.board.find((b) => b.day === '2026-10-05')!.events).toEqual([]);
	});

	it('refuses an end before the start', async () => {
		const f = fixture();
		await refused(await post(f, { day: D2, endDay: D1, endMin: 600 }), END_BEFORE_START);
	});

	it('refuses a span of more than fourteen days', async () => {
		const f = fixture();
		const ok = await post(f, { day: START, endDay: '2026-10-15', endMin: 600 });
		expect(ok.status).toBe(201);
		await refused(await post(f, { day: START, endDay: '2026-10-16', endMin: 600 }), TOO_LONG);
	});

	it('refuses a last day outside the trip', async () => {
		const f = fixture();
		await refused(await post(f, { day: END, endDay: '2026-10-21', endMin: 600 }), OUTSIDE);
	});

	it('refuses an end date that is not a date', async () => {
		const f = fixture();
		await refused(await post(f, { endDay: 'tomorrow', endMin: 600 }), 'Pick an end date.');
	});

	it('keeps the same-day rule for a block on one day', async () => {
		const f = fixture();
		await refused(
			await post(f, { start: 600, endMin: 600 }),
			'An event needs to run at least 15 minutes.'
		);
		const id = await created(await post(f, { start: 600, endMin: 690 }));
		expect(stored(id)).toMatchObject({ end_day: null, start_min: 600, end_min: 690 });
	});
});

describe('a journey that lands in another city', () => {
	it('stores the arrival city and reads the end on its clock', async () => {
		const f = fixture();
		const id = await created(
			await post(f, {
				type: 'travel',
				start: 22 * 60,
				endDay: D2,
				endMin: 15 * 60,
				endCityId: f.tokyo
			})
		);
		expect(stored(id)).toMatchObject({ end_day: D2, end_city_id: f.tokyo, end_min: 900 });
	});

	it('judges a same-day journey west by its real length', async () => {
		const f = fixture();
		const west = { type: 'travel', cityId: f.tokyo, start: 17 * 60, endMin: 11 * 60 };
		const id = await created(await post(f, { ...west, endCityId: f.la }));
		expect(stored(id)).toMatchObject({ end_day: null, end_city_id: f.la, end_min: 660 });
		// The same clock readings in one zone end before they start.
		await refused(await post(f, west), 'An event needs to run at least 15 minutes.');
	});

	it('refuses a landing before the take-off once the zones are read', async () => {
		const f = fixture();
		// 10:00 Tokyo is 04:00 Athens, so landing at 04:00 Athens is no flight at all.
		await refused(
			await post(f, {
				type: 'travel',
				cityId: f.tokyo,
				start: 600,
				endMin: 240,
				endCityId: f.athens
			}),
			END_BEFORE_START
		);
	});

	it('refuses an arrival city the trip does not have, and ignores one on anything else', async () => {
		const f = fixture();
		await refused(
			await post(f, { type: 'travel', endDay: D2, endMin: 600, endCityId: 'nowhere' }),
			'Pick a city on this trip.'
		);
		const id = await created(await post(f, { type: 'activity', endCityId: 'nowhere' }));
		expect(stored(id).end_city_id).toBeNull();
	});
});

describe('editing a span', () => {
	it('sets and clears the end day', async () => {
		const f = fixture();
		const id = await created(await post(f, {}));
		expect((await op(f, id, { op: 'edit', endDay: D2, endMin: 120 })).status).toBe(200);
		expect(stored(id)).toMatchObject({ end_day: D2, end_min: 120 });
		expect((await op(f, id, { op: 'edit', endDay: null, endMin: 660 })).status).toBe(200);
		expect(stored(id)).toMatchObject({ end_day: null, end_min: 660 });
	});

	it('lets a multi-day edit end earlier on the clock than it starts', async () => {
		const f = fixture();
		const id = await hike(f);
		const res = await op(f, id, { op: 'edit', startMin: 1200, endMin: 300 });
		expect(res.status).toBe(200);
		expect(stored(id)).toMatchObject({ end_day: D3, start_min: 1200, end_min: 300 });
	});

	it('carries the end day with a day change', async () => {
		const f = fixture();
		const id = await hike(f);
		expect((await op(f, id, { op: 'edit', day: '2026-10-10' })).status).toBe(200);
		expect(stored(id)).toMatchObject({ day: '2026-10-10', end_day: '2026-10-12' });
	});

	it('refuses an end before the start, too long, outside the trip and not a date', async () => {
		const f = fixture();
		const id = await hike(f);
		await refused(await op(f, id, { op: 'edit', endDay: START }), END_BEFORE_START);
		await refused(await op(f, id, { op: 'edit', endDay: '2026-10-17' }), TOO_LONG);
		const late = await created(await post(f, { day: '2026-10-19' }));
		await refused(await op(f, late, { op: 'edit', endDay: '2026-10-21' }), OUTSIDE);
		await refused(await op(f, id, { op: 'edit', endDay: 'soon' }), 'Pick an end date.');
		expect(stored(id)).toMatchObject({ day: D1, end_day: D3 });
	});

	it('refuses a day change that would carry the end out of the trip', async () => {
		const f = fixture();
		const id = await hike(f);
		await refused(await op(f, id, { op: 'edit', day: '2026-10-19' }), OUTSIDE);
	});

	it('sets, keeps and clears the arrival city of a journey', async () => {
		const f = fixture();
		const id = await created(await post(f, { type: 'travel', start: 1320, duration: 60 }));
		const res = await op(f, id, { op: 'edit', endDay: D2, endMin: 900, endCityId: f.tokyo });
		expect(res.status).toBe(200);
		expect(stored(id)).toMatchObject({ end_day: D2, end_city_id: f.tokyo });
		await op(f, id, { op: 'edit', title: 'ZZ Flight' });
		expect(stored(id).end_city_id).toBe(f.tokyo);
		await refused(
			await op(f, id, { op: 'edit', endCityId: 'nowhere' }),
			'Pick a city on this trip.'
		);
		await op(f, id, { op: 'edit', endCityId: null });
		expect(stored(id).end_city_id).toBeNull();
	});

	it('still holds a stay to its checkout rules', async () => {
		const f = fixture();
		const id = await created(await post(f, { type: 'stay', endDay: D3 }));
		await refused(
			await op(f, id, { op: 'edit', day: D2, endDay: D2 }),
			'Check-out must be after check-in.'
		);
	});
});

describe('dragging and resizing a span', () => {
	it('carries the end day with a drag across days', async () => {
		const f = fixture();
		const id = await hike(f);
		expect((await op(f, id, { op: 'move', startMin: 480, day: '2026-10-08' })).status).toBe(200);
		expect(stored(id)).toMatchObject({ day: '2026-10-08', end_day: '2026-10-10', end_min: 1020 });
	});

	it('refuses a drag that would carry the end out of the trip', async () => {
		const f = fixture();
		const id = await hike(f);
		await refused(await op(f, id, { op: 'move', startMin: 480, day: '2026-10-19' }), OUTSIDE);
		expect(stored(id).day).toBe(D1);
	});

	it('refuses a resize from the bottom edge', async () => {
		const f = fixture();
		const id = await hike(f);
		await refused(
			await op(f, id, { op: 'resize', endMin: 1200 }),
			'Open the event to change when it ends.'
		);
		expect(stored(id).end_min).toBe(1020);
		const plain = await created(await post(f, {}));
		expect((await op(f, plain, { op: 'resize', endMin: 720 })).status).toBe(200);
	});

	it('refuses a drag of a journey whose ends are on two clocks', async () => {
		const f = fixture();
		const west = await created(
			await post(f, {
				type: 'travel',
				cityId: f.tokyo,
				start: 17 * 60,
				endMin: 11 * 60,
				endCityId: f.la
			})
		);
		await refused(
			await op(f, west, { op: 'move', startMin: 18 * 60 }),
			'Open the event to change when it ends.'
		);
		await refused(
			await op(f, west, { op: 'resize', endMin: 12 * 60 }),
			'Open the event to change when it ends.'
		);
		expect(stored(west)).toMatchObject({ start_min: 1020, end_min: 660 });
	});
});

describe('the city a block starts in', () => {
	/**
	 * Neither client sent a city, and the server stored the trip's first one.
	 * On a trip listed Los Angeles then Tokyo, a flight out of Tokyo then had
	 * its start read on Los Angeles's clock, was taken for a one-clock block
	 * ending six hours before it started, and was refused.
	 */
	it('is the city of the day, from where the group woke up, when the body names none', async () => {
		const organizer = auth.createUser(
			`span-city-${crypto.randomUUID()}@example.test`,
			'ZZ Organizer',
			'password123'
		).id;
		const tripId = trips.createTrip(organizer, {
			name: 'ZZ Two Cities',
			startDate: START,
			endDate: END,
			homeCurrency: 'USD'
		}).id!;
		const la = trips.addCity(tripId, organizer, {
			name: 'Los Angeles',
			country: 'US',
			tz: 'America/Los_Angeles'
		})!;
		const tokyo = trips.addCity(tripId, organizer, {
			name: 'Tokyo',
			country: 'JP',
			tz: 'Asia/Tokyo'
		})!;
		const hotel = lodging.addOption(tripId, organizer, tokyo, 'ZZ Tokyo hotel')!;
		const cookie = `session=${auth.createSession(organizer)}`;
		const send = (body: Record<string, unknown>) =>
			app.request(`/trips/${tripId}/schedule/events`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', cookie },
				body: JSON.stringify(body)
			});

		// Two nights in Tokyo, checking out on the morning of the flight.
		await created(await send({ type: 'stay', day: D1, endDay: D3, poiId: hotel, people: [] }));

		// The body the web dialog sends: no city, the clock difference as the
		// duration, and the arrival city.
		const flight = await created(
			await send({
				day: D3,
				type: 'travel',
				start: 17 * 60,
				duration: 11 * 60 - 17 * 60,
				endCityId: la,
				notes: 'ZZ Flight home',
				people: [],
				timeAuto: false
			})
		);
		const row = db
			.prepare(`SELECT city_id, end_city_id, start_min, end_min, end_day FROM events WHERE id = ?`)
			.get(flight) as Record<string, unknown>;
		expect(row).toMatchObject({
			city_id: tokyo,
			end_city_id: la,
			start_min: 1020,
			end_min: 660,
			end_day: null
		});

		// The board says the same city for the day, which is what the clients
		// send as `cityId` from now on.
		const body = (await (
			await app.request(`/trips/${tripId}/schedule?day=${D3}&view=agenda`, {
				headers: { cookie }
			})
		).json()) as { board: { day: string; city: { id: string } | null }[] };
		expect(body.board.find((b) => b.day === D3)!.city?.id).toBe(tokyo);
		// With no stay to read, a day is the trip's first city, as before.
		const empty = (await (
			await app.request(`/trips/${tripId}/schedule?day=2026-10-10&view=agenda`, {
				headers: { cookie }
			})
		).json()) as { board: { day: string; city: { id: string } | null }[] };
		expect(empty.board.find((b) => b.day === '2026-10-10')!.city?.id).toBe(la);
	});
});

describe('correcting the city a journey departs from', () => {
	/** A trip listed Los Angeles then Tokyo, as every older event's city says. */
	function twoCities() {
		const organizer = auth.createUser(
			`span-depart-${crypto.randomUUID()}@example.test`,
			'ZZ Organizer',
			'password123'
		).id;
		const tripId = trips.createTrip(organizer, {
			name: 'ZZ Departs',
			startDate: START,
			endDate: END,
			homeCurrency: 'USD'
		}).id!;
		const la = trips.addCity(tripId, organizer, {
			name: 'Los Angeles',
			country: 'US',
			tz: 'America/Los_Angeles'
		})!;
		const tokyo = trips.addCity(tripId, organizer, {
			name: 'Tokyo',
			country: 'JP',
			tz: 'Asia/Tokyo'
		})!;
		const cookie = `session=${auth.createSession(organizer)}`;
		const call = (path: string, body?: Record<string, unknown>) =>
			app.request(`/trips/${tripId}/schedule${path}`, {
				method: body ? 'POST' : 'GET',
				headers: { 'content-type': 'application/json', cookie },
				body: body ? JSON.stringify(body) : undefined
			});
		return { tripId, la, tokyo, call, organizer };
	}

	it('stores and draws a Tokyo to Los Angeles flight once its departure is Tokyo', async () => {
		const { la, tokyo, call } = twoCities();
		// As an existing row: left on the first city, so its arrival there was
		// dropped as "the departure city named again".
		const flight = await created(
			await call('/events', {
				day: D2,
				type: 'travel',
				cityId: la,
				start: 17 * 60,
				duration: 60,
				endCityId: la,
				title: 'ZZ Flight'
			})
		);
		expect(stored(flight)).toMatchObject({ end_city_id: null, start_min: 1020, end_min: 1080 });

		const res = await call(`/events/${flight}/op`, {
			op: 'edit',
			cityId: tokyo,
			endCityId: la,
			startMin: 17 * 60,
			endMin: 11 * 60
		});
		expect(res.status, await res.clone().text()).toBe(200);
		expect(stored(flight)).toMatchObject({
			end_day: null,
			end_city_id: la,
			start_min: 1020,
			end_min: 660
		});
		const city = db.prepare(`SELECT city_id FROM events WHERE id = ?`).get(flight) as {
			city_id: string;
		};
		expect(city.city_id).toBe(tokyo);

		// Read back and drawn the way the clients draw it: on the arrival clock.
		const body = (await (await call(`?day=${D2}&view=agenda`)).json()) as {
			board: { day: string; events: SpanRow[] }[];
			cities: { id: string; tz: string }[];
		};
		const zones = new Map(body.cities.map((x) => [x.id, x.tz]));
		const row = body.board
			.find((b) => b.day === D2)!
			.events.find((e) => (e as SpanRow & { id: string }).id === flight)!;
		expect(segmentOn(row, D2, (id) => (id ? zones.get(id) : null))).toMatchObject({
			start: 60,
			end: 660
		});
	});

	it('refuses a departure city the trip does not have', async () => {
		const { la, call } = twoCities();
		const id = await created(
			await call('/events', { day: D2, cityId: la, start: 600, duration: 60, title: 'ZZ Block' })
		);
		const res = await call(`/events/${id}/op`, { op: 'edit', cityId: 'nowhere' });
		await refused(res, 'Pick a city on this trip.');
		await refused(
			await call(`/events/${id}/op`, { op: 'edit', cityId: null }),
			'Pick a city on this trip.'
		);
	});

	/**
	 * A block that is not a journey takes its city from the place it is linked
	 * to. Without that, the lunch below kept the day's city (Tokyo), was read
	 * as 13:00 in Tokyo, sorted before the 17:00 departure, and the planner
	 * walked the day museum, lunch, flight.
	 */
	it('walks a westward day in real time when its blocks are created as the clients create them', async () => {
		const { tripId, la, tokyo, call, organizer } = twoCities();
		const hotel = lodging.addOption(tripId, organizer, tokyo, 'ZZ Tokyo hotel', {
			lat: 35.68,
			lng: 139.76
		})!;
		const museumPoi = pois.addPoi(
			tripId,
			organizer,
			tokyo,
			'ZZ Museum',
			'Museum',
			null,
			null,
			35.72,
			139.77
		)!;
		const lax = pois.addPoi(
			tripId,
			organizer,
			la,
			'ZZ LAX',
			'Airport',
			null,
			null,
			33.94,
			-118.41
		)!;
		const diner = pois.addPoi(
			tripId,
			organizer,
			la,
			'ZZ Diner',
			'Restaurant',
			null,
			null,
			34.05,
			-118.25
		)!;

		const stay = await created(
			await call('/events', { type: 'stay', day: D1, endDay: D2, poiId: hotel, people: [] })
		);
		// Each block as the dialogs send it: the day's city (Tokyo, where the
		// group woke up), a start, the clock difference as a duration.
		const client = { day: D2, cityId: tokyo, people: [], timeAuto: false };
		const museum = await created(
			await call('/events', {
				...client,
				type: 'activity',
				start: 12 * 60,
				duration: 120,
				poiId: museumPoi
			})
		);
		const flight = await created(
			await call('/events', {
				...client,
				type: 'travel',
				start: 17 * 60,
				duration: 11 * 60 - 17 * 60,
				endCityId: la,
				poiId: lax
			})
		);
		const lunch = await created(
			await call('/events', { ...client, type: 'food', start: 13 * 60, duration: 60, poiId: diner })
		);

		const cityOf = (id: string) =>
			(db.prepare(`SELECT city_id FROM events WHERE id = ?`).get(id) as { city_id: string })
				.city_id;
		expect(cityOf(lunch)).toBe(la);
		expect(cityOf(museum)).toBe(tokyo);
		// A journey keeps the city it departs from, though its place is in LA.
		expect(cityOf(flight)).toBe(tokyo);

		const body = (await (await call(`?day=${D2}&view=agenda`)).json()) as {
			board: { day: string; legs: { fromEventId: string; toEventId: string }[] }[];
		};
		expect(
			body.board.find((b) => b.day === D2)!.legs.map((l) => [l.fromEventId, l.toEventId])
		).toEqual([
			[stay, museum],
			[flight, lunch]
		]);
	});

	it('moves a block to its place city, over a sent city, and again when it is relinked', async () => {
		const { tripId, la, tokyo, call, organizer } = twoCities();
		const museumPoi = pois.addPoi(
			tripId,
			organizer,
			tokyo,
			'ZZ Museum',
			'Museum',
			null,
			null,
			35.7,
			139.7
		)!;
		const diner = pois.addPoi(
			tripId,
			organizer,
			la,
			'ZZ Diner',
			'Restaurant',
			null,
			null,
			34,
			-118
		)!;
		const cityOf = (id: string) =>
			(db.prepare(`SELECT city_id FROM events WHERE id = ?`).get(id) as { city_id: string })
				.city_id;

		const id = await created(
			await call('/events', { day: D2, cityId: la, start: 600, duration: 60, poiId: museumPoi })
		);
		expect(cityOf(id)).toBe(tokyo);
		expect((await call(`/events/${id}/op`, { op: 'edit', poiId: diner })).status).toBe(200);
		expect(cityOf(id)).toBe(la);
		// A typed place has no city of its own, so the city it was given stands.
		const typed = await created(
			await call('/events', {
				day: D2,
				cityId: tokyo,
				start: 600,
				duration: 60,
				placeName: 'ZZ Cafe'
			})
		);
		expect(cityOf(typed)).toBe(tokyo);
	});
});

interface Payload {
	days: string[];
	board: {
		day: string;
		events: { id: string; end_day: string | null; end_city_id: string | null }[];
	}[];
}

describe('reading a span back', () => {
	it('is on every day it covers, on the board and in the agenda', async () => {
		const f = fixture();
		const id = await hike(f);
		const res = await board(f, `?day=${D2}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Payload;
		for (const day of [D1, D2, D3]) {
			const entry = body.board.find((b) => b.day === day)!;
			expect(entry.events.map((e) => e.id)).toEqual([id]);
		}
		const row = body.board.find((b) => b.day === D3)!.events[0];
		expect(row).toMatchObject({ end_day: D3, end_city_id: null });

		for (const day of [D1, D2, D3]) {
			const agenda = (await (await board(f, `?view=agenda&day=${day}`)).json()) as Payload;
			expect(agenda.board.find((b) => b.day === day)!.events.map((e) => e.id)).toEqual([id]);
		}
		const after = (await (await board(f, `?view=agenda&day=2026-10-05`)).json()) as Payload;
		expect(after.board.find((b) => b.day === '2026-10-05')!.events).toEqual([]);
	});

	it('keeps every covered day reachable when the trip is shortened under it', async () => {
		const f = fixture();
		await hike(f);
		// The trip now ends on the hike's first day, so its other two are stranded.
		db.prepare(`UPDATE trips SET end_date = ? WHERE id = ?`).run(D1, f.tripId);
		const res = await board(f, `?day=${D2}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Payload & {
			lastDay: string;
			dayCount: number;
			prevDay: string | null;
			nextDay: string | null;
		};
		expect(body.days).toEqual([START, D1, D2, D3]);
		expect(body.lastDay).toBe(D3);
		expect(body.dayCount).toBe(4);
		expect(body.prevDay).toBe(D1);
		expect(body.nextDay).toBe(D3);
		const past = await board(f, `?day=2026-10-05`);
		expect(past.status).toBe(400);
	});
});
