import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * A board load routes only what it does not already know.
 *
 * Every load used to send every planned journey to `routeLegs`, and the route
 * cache is in memory, so each restart of the API (every saved file, under
 * `tsx watch`) re-bought the same Google Routes answers. The load now skips a
 * journey whose stored answer is a real route in the mode it wants. These
 * cases stand in for the router and count what it is asked, so nothing here
 * can reach a provider.
 */

const tempRoot = join(tmpdir(), `trippy-api-schedule-routing-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'api.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

/** What the stand-in router says next: a real route, or the fallback guess. */
let answerRouted = true;
const asked: string[][] = [];

vi.mock('@trippy/server/routing', () => ({
	routeLegs: vi.fn(
		async (legs: { key: string }[], modeFor: (leg: { key: string }) => string | undefined) => {
			asked.push(legs.map((l) => l.key));
			return new Map(
				legs.map((l) => [l.key, { mode: modeFor(l) ?? 'transit', mins: 17, routed: answerRouted }])
			);
		}
	)
}));

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let schedule: typeof import('@trippy/server/schedule');
let app: Hono;

const DAY = '2026-10-02';

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
	asked.length = 0;
	answerRouted = true;
});

afterAll(() => {
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

/** A trip whose day holds one journey, between two places a couple of km apart. */
function fixture(): { cookie: string; tripId: string; organizer: string; events: string[] } {
	const organizer = auth.createUser(
		`routing-${crypto.randomUUID()}@example.test`,
		'ZZ Organizer',
		'password123'
	).id;
	const tripId = trips.createTrip(organizer, {
		name: 'ZZ Routing Trip',
		startDate: '2026-10-01',
		endDate: '2026-10-03',
		homeCurrency: 'EUR'
	}).id!;
	const events: string[] = [];
	for (const [start, lat, lng] of [
		[540, 37.975, 23.734],
		[660, 37.99, 23.742]
	]) {
		events.push(
			schedule.createEvent(tripId, organizer, {
				day: DAY,
				title: 'ZZ Stop',
				type: 'activity',
				startMin: start,
				endMin: start + 60,
				lat,
				lng,
				people: []
			})!
		);
	}
	return { cookie: `session=${auth.createSession(organizer)}`, tripId, organizer, events };
}

async function load(f: { cookie: string; tripId: string }) {
	const res = await app.request(`/trips/${f.tripId}/schedule?day=${DAY}&view=agenda`, {
		headers: { cookie: f.cookie }
	});
	expect(res.status).toBe(200);
	return (await res.json()) as {
		board: { legs: { id: string; key: string; autoMins: number | null }[] }[];
	};
}

describe('routing on a board load', () => {
	it('routes a journey once, then reads the stored answer', async () => {
		const f = fixture();
		const first = await load(f);
		expect(asked).toEqual([[first.board[0].legs[0].key]]);
		expect(first.board[0].legs[0].autoMins).toBe(17);

		await load(f);
		await load(f);
		// Nothing asked on the later loads: the stored answer is a real route.
		expect(asked).toHaveLength(1);
	});

	it('asks again about a journey whose stored minutes are only the fallback guess', async () => {
		const f = fixture();
		answerRouted = false;
		await load(f);
		answerRouted = true;
		await load(f);
		expect(asked).toHaveLength(2);
		await load(f);
		expect(asked).toHaveLength(2);
	});

	it('asks again when somebody pins a different mode', async () => {
		const f = fixture();
		const leg = (await load(f)).board[0].legs[0];
		expect(schedule.editLeg(leg.id, f.tripId, f.organizer, 'walk', null)).toBe(true);
		await load(f);
		expect(asked).toHaveLength(2);
		await load(f);
		expect(asked).toHaveLength(2);
	});

	it('asks again when one end of the journey is moved somewhere else', async () => {
		const f = fixture();
		const before = (await load(f)).board[0].legs[0];
		expect(asked).toHaveLength(1);

		// Same two events, so the same leg key, and still a transit-length hop so
		// the mode alone would not notice; but the second one is somewhere else,
		// and the route bought for the old place is not an answer for it.
		const moved = schedule.editEvent(
			f.events[1],
			f.organizer,
			{ place: { lat: 37.955, lng: 23.715 } },
			f.tripId
		);
		expect(moved.ok).toBe(true);

		const after = (await load(f)).board[0].legs[0];
		expect(after.id).toBe(before.id);
		expect(asked).toHaveLength(2);
		expect(asked[1]).toEqual([after.key]);
		// And the fresh answer is kept, so the move costs one route, not one per load.
		await load(f);
		expect(asked).toHaveLength(2);
	});
});
