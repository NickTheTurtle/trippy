import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The weights on a split, over HTTP.
 *
 * The sign lives on the total, not on the weights: a negative total is income,
 * and that is the only place a minus means something. A negative weight was
 * passing the "at least one of these is positive" check and then dividing as
 * though that person had asked for nothing, so somebody named in a split was
 * silently dropped out of it and the row went on to call itself "2 ways".
 */

const tempRoot = join(tmpdir(), `trippy-api-weights-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'api.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let members: typeof import('@trippy/server/members');
let app: Hono;

interface Fixture {
	organizer: string;
	other: string;
	cookie: string;
	tripId: string;
}

beforeAll(async () => {
	const [dbMod, authMod, tripsMod, membersMod, middleware, routes] = await Promise.all([
		import('@trippy/server/db'),
		import('@trippy/server/auth'),
		import('@trippy/server/trips'),
		import('@trippy/server/members'),
		import('../src/middleware.ts'),
		import('../src/routes/expenses.ts')
	]);
	db = dbMod.db;
	auth = authMod;
	trips = tripsMod;
	members = membersMod;

	app = new Hono();
	app.use('*', middleware.session);
	app.route('/trips/:tripId/expenses', routes.expenses as unknown as Hono);
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

function fixture(label = 'weights'): Fixture {
	const organizer = auth.createUser(
		`${label}-${crypto.randomUUID()}@example.test`,
		label,
		'password123'
	).id;
	const tripId = trips.createTrip(organizer, {
		name: 'ZZ Weights Trip',
		startDate: '2026-10-01',
		endDate: '2026-10-03',
		homeCurrency: 'USD'
	}).id!;
	members.addPerson(tripId, organizer, 'ZZ Second', '');
	const other = members
		.listPeople(tripId)
		.map((m) => m.id)
		.find((id) => id !== organizer)!;
	return { organizer, other, cookie: `session=${auth.createSession(organizer)}`, tripId };
}

function post(f: Fixture, body: Record<string, unknown>) {
	return app.request(`/trips/${f.tripId}/expenses`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: f.cookie },
		body: JSON.stringify({
			description: 'ZZ Dinner',
			amount: 10,
			payerId: f.organizer,
			participantIds: [f.organizer, f.other],
			...body
		})
	});
}

describe('split weights', () => {
	it('refuses a negative share rather than treating it as none', async () => {
		const f = fixture();
		const res = await post(f, {
			splitMode: 'shares',
			weights: { [f.organizer]: -1, [f.other]: 2 }
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: 'Enter a share of zero or more for everyone.'
		});
	});

	it('refuses a negative exact amount', async () => {
		const f = fixture();
		const res = await post(f, {
			splitMode: 'exact',
			weights: { [f.organizer]: -5, [f.other]: 15 }
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: 'Enter an amount of zero or more for everyone.'
		});
	});

	it('still takes a zero share, which is a real thing to mean', async () => {
		const f = fixture();
		const res = await post(f, {
			splitMode: 'shares',
			weights: { [f.organizer]: 0, [f.other]: 3 }
		});
		expect(res.status).toBe(201);
	});

	// The sign an expense can carry is on the total. Income still splits.
	it('leaves income alone', async () => {
		const f = fixture();
		const res = await post(f, {
			amount: -10,
			splitMode: 'shares',
			weights: { [f.organizer]: 1, [f.other]: 3 }
		});
		expect(res.status).toBe(201);
	});

	// An exact split that adds up is measured on the amounts as entered, not on
	// a floor at zero, which used to hide a negative part inside a valid sum.
	it('adds up an exact split from the amounts as entered', async () => {
		const f = fixture();
		const res = await post(f, {
			splitMode: 'exact',
			weights: { [f.organizer]: 4, [f.other]: 6 }
		});
		expect(res.status).toBe(201);
	});
});
