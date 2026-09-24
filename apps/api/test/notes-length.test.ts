import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_NOTES_LENGTH, notesTooLong } from '@trippy/core/validate';

/**
 * The ceiling on free text, over HTTP.
 *
 * Names have been capped since the cards were built, because a long one wrecks
 * a column. Notes never were, on the reasoning that prose in a body area cannot
 * do that. It still cannot, but a row with no ceiling is a row with no ceiling,
 * and the client's own textareas stop at the same number, so anything arriving
 * over it came from something other than the app.
 *
 * The join case is the one worth pinning: a place with an activity keeps the
 * place name in its notes, so name plus notes is what has to fit, not notes.
 */

const tempRoot = join(tmpdir(), `trippy-api-notes-length-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'api.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let app: Hono;

const TOO_LONG = notesTooLong();
const atLimit = 'n'.repeat(MAX_NOTES_LENGTH);
const overLimit = 'n'.repeat(MAX_NOTES_LENGTH + 1);

interface Fixture {
	cookie: string;
	tripId: string;
	cityId: string;
}

beforeAll(async () => {
	const [dbMod, authMod, tripsMod, middleware, discoverRoutes, scheduleRoutes] = await Promise.all([
		import('@trippy/server/db'),
		import('@trippy/server/auth'),
		import('@trippy/server/trips'),
		import('../src/middleware.ts'),
		import('../src/routes/discover.ts'),
		import('../src/routes/schedule.ts')
	]);
	db = dbMod.db;
	auth = authMod;
	trips = tripsMod;

	app = new Hono();
	app.use('*', middleware.session);
	app.route('/trips/:tripId/discover', discoverRoutes.discover as unknown as Hono);
	app.route('/trips/:tripId/schedule', scheduleRoutes.schedule as unknown as Hono);
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
		`notes-length-${crypto.randomUUID()}@example.test`,
		'notes-length',
		'password123'
	).id;
	const tripId = trips.createTrip(organizer, {
		name: 'ZZ Notes Trip',
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
	return { cookie: `session=${auth.createSession(organizer)}`, tripId, cityId };
}

function send(f: Fixture, path: string, body: Record<string, unknown>, method = 'POST') {
	return app.request(`/trips/${f.tripId}${path}`, {
		method,
		headers: { 'content-type': 'application/json', cookie: f.cookie },
		body: JSON.stringify(body)
	});
}

const addPoi = (f: Fixture, body: Record<string, unknown>) =>
	send(f, '/discover/pois', { name: `ZZ Place ${crypto.randomUUID()}`, cityId: f.cityId, ...body });

describe('notes length on a place', () => {
	it('takes notes at the limit', async () => {
		const res = await addPoi(fixture(), { notes: atLimit });
		expect(res.status).toBe(201);
	});

	it('refuses notes over the limit', async () => {
		const res = await addPoi(fixture(), { notes: overLimit });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: TOO_LONG });
	});

	// The activity moves the place name into the notes, so notes that fit on
	// their own can stop fitting once the name is in front of them.
	it('counts the place name the activity pushes into the notes', async () => {
		const f = fixture();
		const res = await send(f, '/discover/pois', {
			name: 'Acropolis',
			activity: 'Sunset photos',
			cityId: f.cityId,
			notes: atLimit
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: TOO_LONG });
	});

	it('refuses an edit that puts the notes over the limit', async () => {
		const f = fixture();
		const created = await addPoi(f, {});
		const { id } = (await created.json()) as { id: string };
		const res = await send(
			f,
			`/discover/pois/${id}`,
			{ name: 'ZZ Place', notes: overLimit },
			'PATCH'
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: TOO_LONG });
	});
});

describe('notes length on a stay', () => {
	// A stay's one free-text line is stored as its tag, and the add popup calls
	// it notes, so both names have to land on the same limit.
	it('refuses a tag over the limit', async () => {
		const f = fixture();
		const res = await send(f, '/discover/stays', {
			name: 'ZZ Ryokan',
			cityId: f.cityId,
			tag: overLimit
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: TOO_LONG });
	});

	it('refuses notes over the limit under either name', async () => {
		const f = fixture();
		const res = await send(f, '/discover/stays', {
			name: 'ZZ Ryokan',
			cityId: f.cityId,
			notes: overLimit
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: TOO_LONG });
	});
});

describe('notes length on an event', () => {
	const event = (f: Fixture, notes: string) =>
		send(f, '/schedule/events', {
			day: '2026-10-11',
			start: 600,
			end: 660,
			type: 'activity',
			title: 'ZZ Event',
			notes
		});

	it('takes notes at the limit', async () => {
		const res = await event(fixture(), atLimit);
		expect(res.status).toBe(201);
	});

	it('refuses notes over the limit', async () => {
		const res = await event(fixture(), overLimit);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: TOO_LONG });
	});
});
