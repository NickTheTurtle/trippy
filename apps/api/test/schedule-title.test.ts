import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** `MAX_NAME_LENGTH` from `@trippy/core/validate`, restated so the cases read as
 * the numbers a client would see. */
const MAX_NAME_LENGTH = 200;

/**
 * The name of a scheduled block, over HTTP.
 *
 * The dialog leads with the place picker, so the name is optional on the wire
 * and the route derives one: the place, then the first line of the notes, then
 * the type's own noun. What these cases pin is the part that only exists at
 * this layer - the derivation order, the fact that no missing name earns a 400
 * any more, the shortening of a long note rather than a refusal of it, and the
 * absent-versus-blank distinction on edit, which is the one that can silently
 * rename an event somebody deliberately named.
 */

const tempRoot = join(tmpdir(), `trippy-api-event-title-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'api.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let pois: typeof import('@trippy/server/pois');
let app: Hono;

interface Fixture {
	organizer: string;
	cookie: string;
	tripId: string;
	cityId: string;
}

beforeAll(async () => {
	const [dbMod, authMod, tripsMod, poisMod, middleware, routes] = await Promise.all([
		import('@trippy/server/db'),
		import('@trippy/server/auth'),
		import('@trippy/server/trips'),
		import('@trippy/server/pois'),
		import('../src/middleware.ts'),
		import('../src/routes/schedule.ts')
	]);
	db = dbMod.db;
	auth = authMod;
	trips = tripsMod;
	pois = poisMod;

	// The same mount `routes/trips.ts` uses, so `requireMember` sees the same
	// `:tripId` parameter it does in the real app.
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

function fixture(label = 'event-title'): Fixture {
	const organizer = auth.createUser(
		`${label}-${crypto.randomUUID()}@example.test`,
		label,
		'password123'
	).id;
	const tripId = trips.createTrip(organizer, {
		name: 'ZZ Title Trip',
		startDate: '2026-10-01',
		endDate: '2026-10-03',
		homeCurrency: 'USD'
	}).id!;
	const cityId = trips.addCity(tripId, organizer, {
		name: 'ZZ Kyoto',
		country: 'Japan',
		tz: 'Asia/Tokyo',
		lat: 35,
		lng: 135
	})!;
	return { organizer, cookie: `session=${auth.createSession(organizer)}`, tripId, cityId };
}

function savedPoi(f: Fixture, name: string): string {
	return pois.addPoi(f.tripId, f.organizer, f.cityId, name, 'Attraction', null, null, 35, 135)!;
}

function post(f: Fixture, body: Record<string, unknown>) {
	return app.request(`/trips/${f.tripId}/schedule/events`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: f.cookie },
		body: JSON.stringify({ day: '2026-10-02', start: 9 * 60, duration: 60, ...body })
	});
}

function op(f: Fixture, eventId: string, body: Record<string, unknown>) {
	return app.request(`/trips/${f.tripId}/schedule/events/${eventId}/op`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: f.cookie },
		body: JSON.stringify({ op: 'edit', ...body })
	});
}

/** The stored name, read straight out of the row the route wrote. */
function titleOf(eventId: string): string {
	return (db.prepare(`SELECT title FROM events WHERE id = ?`).get(eventId) as { title: string })
		.title;
}

async function created(res: Response): Promise<string> {
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

describe('the name of a scheduled block', () => {
	it('keeps the name that was typed, whatever else the body carries', async () => {
		const f = fixture();
		const poiId = savedPoi(f, 'ZZ Fushimi Inari');
		const id = await created(
			await post(f, { title: 'ZZ Shrine morning', poiId, notes: 'ZZ take the early train' })
		);
		expect(titleOf(id)).toBe('ZZ Shrine morning');
	});

	it('names an unnamed block after the place that was picked', async () => {
		const f = fixture();
		const poiId = savedPoi(f, 'ZZ Fushimi Inari');
		const id = await created(await post(f, { poiId, notes: 'ZZ take the early train' }));
		expect(titleOf(id)).toBe('ZZ Fushimi Inari');
	});

	it('falls back to the first line of the notes when no place was picked', async () => {
		const f = fixture();
		const id = await created(await post(f, { notes: 'ZZ Ramen with Ana\nbring cash' }));
		expect(titleOf(id)).toBe('ZZ Ramen with Ana');
	});

	it('reads the first line on either line ending', async () => {
		const f = fixture();
		const id = await created(await post(f, { notes: 'ZZ Ramen with Ana\r\nbring cash' }));
		expect(titleOf(id)).toBe('ZZ Ramen with Ana');
	});

	it('skips blank opening lines rather than giving up on the notes', async () => {
		const f = fixture();
		// A paste out of a document routinely opens with blank lines; the block
		// should still be named after the first real sentence.
		const id = await created(await post(f, { notes: '\n   \nZZ Ramen with Ana\nbring cash' }));
		expect(titleOf(id)).toBe('ZZ Ramen with Ana');
	});

	it('shortens a very long first line instead of refusing it', async () => {
		const f = fixture();
		const line = `ZZ ${'word '.repeat(80)}end`;
		expect(line.length).toBeGreaterThan(MAX_NAME_LENGTH);
		const id = await created(await post(f, { notes: `${line}\nsecond line` }));

		const stored = titleOf(id);
		expect(stored.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
		// Cut on a word boundary, and marked as a summary rather than the line.
		expect(stored.startsWith('ZZ word word')).toBe(true);
		expect(stored.endsWith('word…')).toBe(true);
	});

	it('shortens a single unbroken word too, rather than cutting it to nothing', async () => {
		const f = fixture();
		const id = await created(await post(f, { notes: `ZZ${'x'.repeat(MAX_NAME_LENGTH * 2)}` }));
		const stored = titleOf(id);
		expect(stored.length).toBe(MAX_NAME_LENGTH);
		expect(stored.endsWith('…')).toBe(true);
	});

	it('still refuses a name the organiser typed and can see is too long', async () => {
		const f = fixture();
		const res = await post(f, { title: 'Z'.repeat(MAX_NAME_LENGTH + 1) });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'Keep it under 200 characters.' });
	});

	it("falls back to the type's own noun, per type", async () => {
		const f = fixture();
		for (const [type, expected] of [
			['travel', 'Travel'],
			['freetime', 'Free time'],
			['activity', 'Activity'],
			['food', 'Food']
		] as const) {
			const id = await created(await post(f, { type }));
			expect(titleOf(id)).toBe(expected);
		}
	});

	it('never refuses a block for having no name at all', async () => {
		const f = fixture();
		// Nothing to derive from: no place, no notes, no type. This used to be the
		// 400 "Enter a title.", and the field is optional now.
		const id = await created(await post(f, {}));
		expect(titleOf(id)).toBe('Activity');
	});

	it('ignores a place on free time, which is nowhere by definition', async () => {
		const f = fixture();
		const poiId = savedPoi(f, 'ZZ Fushimi Inari');
		const id = await created(await post(f, { type: 'freetime', poiId, notes: '' }));
		expect(titleOf(id)).toBe('Free time');
	});

	it('leaves the stored name alone when an edit is silent about it', async () => {
		const f = fixture();
		const id = await created(await post(f, { title: 'ZZ Shrine morning' }));
		// The field is absent, not blank: an edit that only moves the clock must
		// not rename an event somebody deliberately named.
		expect((await op(f, id, { startMin: 10 * 60, endMin: 11 * 60 })).status).toBe(200);
		expect(titleOf(id)).toBe('ZZ Shrine morning');
	});

	it('derives again when an edit clears the name', async () => {
		const f = fixture();
		const id = await created(await post(f, { title: 'ZZ Shrine morning' }));
		expect((await op(f, id, { title: '', notes: 'ZZ Ramen with Ana\nbring cash' })).status).toBe(
			200
		);
		expect(titleOf(id)).toBe('ZZ Ramen with Ana');
	});

	it('prefers the place over the notes when an edit clears the name', async () => {
		const f = fixture();
		const poiId = savedPoi(f, 'ZZ Fushimi Inari');
		const id = await created(await post(f, { title: 'ZZ Shrine morning' }));
		const res = await op(f, id, { title: '  ', poiId, notes: 'ZZ Ramen with Ana' });
		expect(res.status).toBe(200);
		expect(titleOf(id)).toBe('ZZ Fushimi Inari');
	});

	it("falls back to the type's noun when a cleared name has nothing to derive from", async () => {
		const f = fixture();
		const id = await created(await post(f, { title: 'ZZ Shrine morning' }));
		expect((await op(f, id, { title: '', type: 'travel' })).status).toBe(200);
		expect(titleOf(id)).toBe('Travel');
	});

	it('treats a null name on edit as silence, not as a clear', async () => {
		const f = fixture();
		const id = await created(await post(f, { title: 'ZZ Shrine morning' }));
		expect((await op(f, id, { title: null, notes: 'ZZ Ramen with Ana' })).status).toBe(200);
		expect(titleOf(id)).toBe('ZZ Shrine morning');
	});
});
