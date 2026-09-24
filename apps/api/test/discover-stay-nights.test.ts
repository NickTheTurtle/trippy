import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The nights a stay can claim, over HTTP.
 *
 * Persistence already refuses a range that runs backwards or covers no nights.
 * What it cannot see is the trip: May 8 to May 9 is a perfectly ordered
 * one-night stay, and it was accepted onto a trip running May 10 to May 15,
 * where it then drew a band on days the board does not have. The trip's own
 * dates are known here, so the refusal belongs here.
 */

const tempRoot = join(tmpdir(), `trippy-api-stay-nights-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'api.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let app: Hono;

const OUTSIDE = 'Those nights fall outside the trip.';

interface Fixture {
	organizer: string;
	cookie: string;
	tripId: string;
	cityId: string;
}

beforeAll(async () => {
	const [dbMod, authMod, tripsMod, middleware, routes] = await Promise.all([
		import('@trippy/server/db'),
		import('@trippy/server/auth'),
		import('@trippy/server/trips'),
		import('../src/middleware.ts'),
		import('../src/routes/discover.ts')
	]);
	db = dbMod.db;
	auth = authMod;
	trips = tripsMod;

	app = new Hono();
	app.use('*', middleware.session);
	app.route('/trips/:tripId/discover', routes.discover as unknown as Hono);
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

// The trip runs 2026-10-10 to 2026-10-15, so the 9th is a day before it and the
// 16th a day after it. Both are real dates in a sensible order.
function fixture(label = 'stay-nights'): Fixture {
	const organizer = auth.createUser(
		`${label}-${crypto.randomUUID()}@example.test`,
		label,
		'password123'
	).id;
	const tripId = trips.createTrip(organizer, {
		name: 'ZZ Nights Trip',
		startDate: '2026-10-10',
		endDate: '2026-10-15',
		homeCurrency: 'USD'
	}).id!;
	const cityId = trips.addCity(tripId, organizer, {
		name: 'Athens',
		country: 'Greece',
		tz: 'Europe/Athens',
		lat: 37.98,
		lng: 23.73
	})!;
	return { organizer, cookie: `session=${auth.createSession(organizer)}`, tripId, cityId };
}

function addStay(f: Fixture, body: Record<string, unknown>) {
	return app.request(`/trips/${f.tripId}/discover/stays`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: f.cookie },
		body: JSON.stringify({ name: 'ZZ Ryokan', cityId: f.cityId, ...body })
	});
}

async function stayId(f: Fixture): Promise<string> {
	const res = await addStay(f, {});
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

describe('stay nights against the trip', () => {
	it('refuses a check-in before the trip starts', async () => {
		const f = fixture();
		const res = await addStay(f, { checkIn: '2026-10-09', checkOut: '2026-10-11' });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: OUTSIDE });
	});

	it('refuses a check-out after the trip ends', async () => {
		const f = fixture();
		const res = await addStay(f, { checkIn: '2026-10-14', checkOut: '2026-10-16' });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: OUTSIDE });
	});

	// The last night runs into the final day, so a checkout on it is the latest
	// thing a traveller can mean and has to stay allowed.
	it('takes a checkout on the last day of the trip', async () => {
		const f = fixture();
		const res = await addStay(f, { checkIn: '2026-10-14', checkOut: '2026-10-15' });
		expect(res.status).toBe(201);
	});

	it('leaves an undated stay undated', async () => {
		const f = fixture();
		const res = await addStay(f, { checkIn: '', checkOut: '' });
		expect(res.status).toBe(201);
	});

	// The editor no longer carries the nights, so an edit must not move them: a
	// range sent to it is ignored, and the one the calendar set survives.
	it('leaves the night range alone on an edit', async () => {
		const f = fixture();
		const id = await stayId(f);
		const dated = await app.request(`/trips/${f.tripId}/discover/stays/${id}/dates`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json', cookie: f.cookie },
			body: JSON.stringify({ checkIn: '2026-10-11', checkOut: '2026-10-13' })
		});
		expect(dated.status).toBe(200);

		const res = await app.request(`/trips/${f.tripId}/discover/stays/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json', cookie: f.cookie },
			body: JSON.stringify({ name: 'ZZ Ryokan Annex', checkIn: '2026-10-08', checkOut: '2026-10-09' })
		});
		expect(res.status).toBe(200);

		const row = db
			.prepare(`SELECT name, check_in, check_out FROM lodging_options WHERE id = ?`)
			.get(id) as { name: string; check_in: string; check_out: string };
		expect(row.name).toBe('ZZ Ryokan Annex');
		expect(row.check_in).toBe('2026-10-11');
		expect(row.check_out).toBe('2026-10-13');
	});

	// The dates-only path is the one the lodging card uses, and it was the one
	// the tester got a stray May 8 stay through.
	it('holds the dates-only path to the same range', async () => {
		const f = fixture();
		const id = await stayId(f);
		const res = await app.request(`/trips/${f.tripId}/discover/stays/${id}/dates`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json', cookie: f.cookie },
			body: JSON.stringify({ checkIn: '2026-10-08', checkOut: '2026-10-09' })
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: OUTSIDE });
	});
});
