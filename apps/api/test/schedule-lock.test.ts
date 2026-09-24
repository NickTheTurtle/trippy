import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The frozen board, over HTTP.
 *
 * Hiding the drag handles is a courtesy, not a rule: the board is a live page
 * with other people's sessions open on it, and one of them may have loaded it
 * before the lock went on. So the refusal is tested where it is enforced, on
 * one `use('*')` guard rather than per route, which is also why a route added
 * later cannot forget it.
 *
 * Reads are never refused. A locked trip is one everybody is meant to be
 * reading, so a lock that hid the plan would be the opposite of the point.
 */

const tempRoot = join(tmpdir(), `trippy-api-schedule-lock-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'api.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let app: Hono;
let LOCKED: string;

interface Fixture {
	cookie: string;
	tripId: string;
	eventId: string;
}

beforeAll(async () => {
	const [dbMod, authMod, tripsMod, middleware, tripRoutes, scheduleRoutes] = await Promise.all([
		import('@trippy/server/db'),
		import('@trippy/server/auth'),
		import('@trippy/server/trips'),
		import('../src/middleware.ts'),
		import('../src/routes/trips.ts'),
		import('../src/routes/schedule.ts')
	]);
	db = dbMod.db;
	auth = authMod;
	trips = tripsMod;
	LOCKED = scheduleRoutes.SCHEDULE_LOCKED;

	app = new Hono();
	app.use('*', middleware.session);
	app.route('/trips/:tripId/schedule', scheduleRoutes.schedule as unknown as Hono);
	app.route('/trips', tripRoutes.trips as unknown as Hono);
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

function send(cookie: string, path: string, body?: Record<string, unknown>, method = 'POST') {
	return app.request(path, {
		method,
		headers: { 'content-type': 'application/json', cookie },
		body: body ? JSON.stringify(body) : undefined
	});
}

async function fixture(): Promise<Fixture> {
	const organizer = auth.createUser(
		`schedule-lock-${crypto.randomUUID()}@example.test`,
		'schedule-lock',
		'password123'
	).id;
	const tripId = trips.createTrip(organizer, {
		name: 'ZZ Locked Trip',
		startDate: '2026-10-10',
		endDate: '2026-10-15',
		homeCurrency: 'USD'
	}).id!;
	const cookie = `session=${auth.createSession(organizer)}`;
	const res = await send(cookie, `/trips/${tripId}/schedule/events`, {
		day: '2026-10-11',
		start: 600,
		end: 660,
		type: 'activity',
		title: 'ZZ Event'
	});
	const { id } = (await res.json()) as { id: string };
	return { cookie, tripId, eventId: id };
}

function setLock(f: Fixture, scheduleLocked: boolean) {
	return send(
		f.cookie,
		`/trips/${f.tripId}`,
		{
			name: 'ZZ Locked Trip',
			startDate: '2026-10-10',
			endDate: '2026-10-15',
			currency: 'USD',
			scheduleLocked
		},
		'PATCH'
	);
}

async function locked(): Promise<Fixture> {
	const f = await fixture();
	expect((await setLock(f, true)).status).toBe(200);
	return f;
}

describe('a locked schedule', () => {
	it('still reads', async () => {
		const f = await locked();
		const res = await send(
			f.cookie,
			`/trips/${f.tripId}/schedule?day=2026-10-11`,
			undefined,
			'GET'
		);
		expect(res.status).toBe(200);
	});

	it('refuses a new event', async () => {
		const f = await locked();
		const res = await send(f.cookie, `/trips/${f.tripId}/schedule/events`, {
			day: '2026-10-12',
			start: 600,
			end: 660,
			type: 'activity',
			title: 'ZZ Late Addition'
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: LOCKED });
	});

	it('refuses a move', async () => {
		const f = await locked();
		const res = await send(f.cookie, `/trips/${f.tripId}/schedule/events/${f.eventId}/op`, {
			op: 'move',
			startMin: 700
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: LOCKED });
	});

	it('refuses a delete', async () => {
		const f = await locked();
		const res = await send(f.cookie, `/trips/${f.tripId}/schedule/events/${f.eventId}/op`, {
			op: 'delete'
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: LOCKED });
	});

	it('refuses a change to who is going', async () => {
		const f = await locked();
		const res = await send(
			f.cookie,
			`/trips/${f.tripId}/schedule/events/${f.eventId}/people`,
			{ userIds: [] },
			'PUT'
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: LOCKED });
	});

	// The lock holds against the organizer too. The accident it is there to stop
	// is a drag by whoever happens to be looking at the board, and that is as
	// often the person who set the plan as anyone else.
	it('holds against the organizer who set it', async () => {
		const f = await locked();
		const res = await send(f.cookie, `/trips/${f.tripId}/schedule/events`, {
			day: '2026-10-12',
			start: 600,
			end: 660,
			type: 'activity',
			title: 'ZZ Organizer Addition'
		});
		expect(res.status).toBe(403);
	});

	it('takes changes again once unlocked', async () => {
		const f = await locked();
		expect((await setLock(f, false)).status).toBe(200);
		const res = await send(f.cookie, `/trips/${f.tripId}/schedule/events`, {
			day: '2026-10-12',
			start: 600,
			end: 660,
			type: 'activity',
			title: 'ZZ After Unlock'
		});
		expect(res.status).toBe(201);
	});
});
