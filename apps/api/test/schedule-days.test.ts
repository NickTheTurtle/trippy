import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Which days the board serves, over HTTP.
 *
 * The read used to build the day list by walking the calendar with
 * `i < 400` as its stopping rule, and then clamp the requested day into that
 * list. A two-year trip therefore served 400 days and answered every request
 * past 2025-10-13 with 2025-10-13, at 200, with nothing in the payload to say
 * it had done so: the url said one day and the board drew another.
 *
 * These cases pin the two halves of the fix. A trip longer than the old cap
 * serves its own last day, and a day the trip does not have is refused rather
 * than swapped for one it does. The long trip here is deliberately over 400
 * days, which is the whole point.
 */

const tempRoot = join(tmpdir(), `trippy-api-schedule-days-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'api.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let schedule: typeof import('@trippy/server/schedule');
let app: Hono;

interface Fixture {
	organizer: string;
	cookie: string;
	tripId: string;
}

interface DayPayload {
	day: string;
	days: string[];
	firstDay: string;
	lastDay: string;
	dayCount: number;
	prevDay: string | null;
	nextDay: string | null;
	board: { day: string; events: { id: string }[] }[];
}

interface Refusal {
	error: string;
	code: string;
	firstDay: string | null;
	lastDay: string | null;
}

beforeAll(async () => {
	const [dbMod, authMod, tripsMod, scheduleMod, middleware, routes] = await Promise.all([
		import('@trippy/server/db'),
		import('@trippy/server/auth'),
		import('@trippy/server/trips'),
		import('@trippy/server/schedule'),
		import('../src/middleware.ts'),
		import('../src/routes/schedule.ts')
	]);
	db = dbMod.db;
	auth = authMod;
	trips = tripsMod;
	schedule = scheduleMod;

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

function fixture(startDate: string, endDate: string): Fixture {
	const organizer = auth.createUser(
		`schedule-days-${crypto.randomUUID()}@example.test`,
		'ZZ Days',
		'password123'
	).id;
	const tripId = trips.createTrip(organizer, {
		name: 'ZZ Days Trip',
		startDate,
		endDate,
		homeCurrency: 'USD'
	}).id!;
	return { organizer, cookie: `session=${auth.createSession(organizer)}`, tripId };
}

function get(f: Fixture, query = '') {
	return app.request(`/trips/${f.tripId}/schedule${query}`, { headers: { cookie: f.cookie } });
}

async function payload(res: Response): Promise<DayPayload> {
	expect(res.status).toBe(200);
	return (await res.json()) as DayPayload;
}

/**
 * The entry for the day the payload says it is drawing.
 *
 * The board carries a window of days now, so its first entry is the day before
 * the one asked for on any day that has one. Everything here is about which day
 * was served, so it looks the day up rather than trusting a position.
 */
function drawn(body: DayPayload) {
	const entry = body.board.find((b) => b.day === body.day);
	expect(entry, `board has no entry for ${body.day}`).toBeTruthy();
	return entry!;
}

/** The Montreal trip's shape: two years and three days, well past the old cap. */
const LONG = { start: '2024-09-09', end: '2026-09-12' };

describe('the days a long trip serves', () => {
	it('serves a day past the old 400-day cap as itself, not as the 400th day', async () => {
		const f = fixture(LONG.start, LONG.end);
		const body = await payload(await get(f, '?day=2026-05-01'));
		expect(body.day).toBe('2026-05-01');
		expect(drawn(body).day).toBe('2026-05-01');
		expect(body.prevDay).toBe('2026-04-30');
		expect(body.nextDay).toBe('2026-05-02');
	});

	it('serves the trip s own last day, and offers nothing after it', async () => {
		const f = fixture(LONG.start, LONG.end);
		const body = await payload(await get(f, `?day=${LONG.end}`));
		expect(body.day).toBe(LONG.end);
		expect(body.lastDay).toBe(LONG.end);
		expect(body.nextDay).toBeNull();
	});

	it('reports the whole range it reaches, and counts every day of it', async () => {
		const f = fixture(LONG.start, LONG.end);
		const body = await payload(await get(f));
		expect(body.firstDay).toBe(LONG.start);
		expect(body.lastDay).toBe(LONG.end);
		expect(body.dayCount).toBe(734);
		expect(body.days.length).toBe(734);
		expect(body.days[body.days.length - 1]).toBe(LONG.end);
	});

	it('opens on the trip s first day when no day is asked for', async () => {
		const f = fixture(LONG.start, LONG.end);
		const body = await payload(await get(f));
		expect(body.day).toBe(LONG.start);
		expect(body.prevDay).toBeNull();
	});
});

describe('a day the trip does not have', () => {
	it('refuses a day after the end rather than quietly serving the last one', async () => {
		const f = fixture('2026-04-16', '2026-04-20');
		const res = await get(f, '?day=2026-04-21');
		expect(res.status).toBe(400);
		const body = (await res.json()) as Refusal;
		expect(body.code).toBe('outside_trip');
		expect(body.firstDay).toBe('2026-04-16');
		expect(body.lastDay).toBe('2026-04-20');
	});

	it('refuses a day before the start the same way', async () => {
		const f = fixture('2026-04-16', '2026-04-20');
		const res = await get(f, '?day=2026-04-15');
		expect(res.status).toBe(400);
		expect(((await res.json()) as Refusal).code).toBe('outside_trip');
	});

	it('refuses something that is not a date at all', async () => {
		const f = fixture('2026-04-16', '2026-04-20');
		const res = await get(f, '?day=tomorrow');
		expect(res.status).toBe(400);
		expect(((await res.json()) as Refusal).code).toBe('not_a_date');
	});

	it('still serves every day inside a short trip', async () => {
		const f = fixture('2026-04-16', '2026-04-20');
		for (const day of ['2026-04-16', '2026-04-17', '2026-04-18', '2026-04-19', '2026-04-20']) {
			const body = await payload(await get(f, `?day=${day}`));
			expect(body.day).toBe(day);
		}
	});
});

describe('a trip past the day-list window', () => {
	/**
	 * Fourteen years, which no real trip is and the trip form will not create.
	 * It exists to exercise the only regime where the window binds at all: the
	 * bar for every real trip is that the list is untouched, and the bar here is
	 * that the window never decides which day is served.
	 */
	const WIDE = { start: '2000-01-01', end: '2013-12-31', days: 5114 };
	const WINDOW = 4000;

	it('serves the far end of it, and still names the real first and last day', async () => {
		const f = fixture(WIDE.start, WIDE.end);
		const body = await payload(await get(f, `?day=${WIDE.end}`));
		expect(body.day).toBe(WIDE.end);
		expect(drawn(body).day).toBe(WIDE.end);
		expect(body.firstDay).toBe(WIDE.start);
		expect(body.lastDay).toBe(WIDE.end);
		expect(body.dayCount).toBe(WIDE.days);
		expect(body.nextDay).toBeNull();
		expect(body.prevDay).toBe('2013-12-30');
	});

	it('takes the same size window wherever in the trip it is taken', async () => {
		const f = fixture(WIDE.start, WIDE.end);
		for (const day of [WIDE.start, '2007-01-01', WIDE.end]) {
			const body = await payload(await get(f, `?day=${day}`));
			expect(body.days.length).toBe(WINDOW);
			expect(body.days).toContain(day);
		}
	});

	it('never lets the window decide which day the board draws', async () => {
		const f = fixture(WIDE.start, WIDE.end);
		const body = await payload(await get(f, '?day=2013-06-15'));
		expect(body.day).toBe('2013-06-15');
		expect(body.days[0] > WIDE.start).toBe(true);
	});
});

describe('a trip shortened under an event', () => {
	/** The stranded day is still reachable; the gap it left behind is not. */
	function stranded(): Fixture {
		const f = fixture('2026-03-01', '2026-03-05');
		schedule.createEvent(f.tripId, f.organizer, {
			day: '2026-03-05',
			title: 'ZZ stranded',
			type: 'activity',
			startMin: 600,
			endMin: 660
		});
		trips.updateTrip(f.tripId, f.organizer, {
			name: 'ZZ Days Trip',
			startDate: '2026-03-01',
			endDate: '2026-03-02',
			currency: 'USD'
		});
		return f;
	}

	it('still serves the stranded day, and steps to it across the gap', async () => {
		const f = stranded();
		const edge = await payload(await get(f, '?day=2026-03-02'));
		expect(edge.nextDay).toBe('2026-03-05');
		const body = await payload(await get(f, '?day=2026-03-05'));
		expect(body.day).toBe('2026-03-05');
		expect(drawn(body).events.length).toBe(1);
		expect(body.prevDay).toBe('2026-03-02');
	});

	it('refuses a gap day, and says so differently from a day off the end', async () => {
		const f = stranded();
		const gap = await get(f, '?day=2026-03-03');
		expect(gap.status).toBe(400);
		expect(((await gap.json()) as Refusal).code).toBe('day_not_offered');
		const past = await get(f, '?day=2026-03-06');
		expect(past.status).toBe(400);
		expect(((await past.json()) as Refusal).code).toBe('outside_trip');
	});
});
