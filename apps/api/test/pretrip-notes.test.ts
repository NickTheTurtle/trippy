import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_NOTES_BODY, notesBodyTooLong } from '@trippy/core/notes';
import { copy } from '@trippy/copy';

/**
 * The trip's shared notepad, over HTTP, through the same mount the app uses.
 *
 * The contract the web and native clients are built against: GET answers the
 * notes (empty at version 0 before the first save), PUT is a compare-and-set on
 * the version that answers 409 with the current notes when it lost the race,
 * and every successful save publishes `notes`.
 */

const tempRoot = join(tmpdir(), `trippy-api-pretrip-notes-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'api.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let members: typeof import('@trippy/server/members');
let bus: typeof import('@trippy/server/events');
let CONFLICT: string;
let app: Hono;

interface Fixture {
	organizer: string;
	member: string;
	cookie: string;
	memberCookie: string;
	strangerCookie: string;
	tripId: string;
}

beforeAll(async () => {
	const [dbMod, authMod, tripsMod, membersMod, busMod, mw, tripRoutes, pretripRoutes] =
		await Promise.all([
			import('@trippy/server/db'),
			import('@trippy/server/auth'),
			import('@trippy/server/trips'),
			import('@trippy/server/members'),
			import('@trippy/server/events'),
			import('../src/middleware.ts'),
			import('../src/routes/trips.ts'),
			import('../src/routes/pretrip.ts')
		]);
	db = dbMod.db;
	auth = authMod;
	trips = tripsMod;
	members = membersMod;
	bus = busMod;
	CONFLICT = pretripRoutes.NOTES_CONFLICT;

	app = new Hono();
	app.use('*', mw.session);
	app.route('/trips', tripRoutes.trips as unknown as Hono);
});

beforeEach(() => {
	bus.closeAll();
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
});

afterAll(() => {
	bus.closeAll();
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

function fixture(): Fixture {
	const organizer = auth.createUser(
		`org-${crypto.randomUUID()}@example.test`,
		'ZZ Org',
		'pw123456'
	);
	const member = auth.createUser(`mem-${crypto.randomUUID()}@example.test`, 'ZZ Mem', 'pw123456');
	const stranger = auth.createUser(`str-${crypto.randomUUID()}@example.test`, 'ZZ Str', 'pw123456');
	const tripId = trips.createTrip(organizer.id, {
		name: 'ZZ Notes Trip',
		startDate: '2026-10-10',
		endDate: '2026-10-15',
		homeCurrency: 'USD'
	}).id!;
	expect(members.addPerson(tripId, organizer.id, 'ZZ Mem', member.email)).toBe('added');
	return {
		organizer: organizer.id,
		member: member.id,
		cookie: `session=${auth.createSession(organizer.id)}`,
		memberCookie: `session=${auth.createSession(member.id)}`,
		strangerCookie: `session=${auth.createSession(stranger.id)}`,
		tripId
	};
}

function send(cookie: string, method: string, path: string, body?: unknown) {
	return app.request(path, {
		method,
		headers: { 'content-type': 'application/json', cookie },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
}

const notesPath = (f: Fixture) => `/trips/${f.tripId}/pretrip/notes`;

async function error(res: Response, status: number): Promise<string> {
	expect(res.status, await res.clone().text()).toBe(status);
	return ((await res.json()) as { error: string }).error;
}

describe('GET /pretrip/notes', () => {
	it('answers empty notes at version 0 before the first save', async () => {
		const f = fixture();
		const res = await send(f.memberCookie, 'GET', notesPath(f));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ body: '', version: 0, updatedAt: null, updatedBy: null });
	});

	it('answers a stranger the way every pretrip route does', async () => {
		const f = fixture();
		const page = await send(f.strangerCookie, 'GET', `/trips/${f.tripId}/pretrip`);
		const res = await send(f.strangerCookie, 'GET', notesPath(f));
		expect(res.status).toBe(page.status);
		expect(await error(res, 404)).toBe('Not found.');
	});

	it('answers 401 with no session', async () => {
		const f = fixture();
		expect((await send('', 'GET', notesPath(f))).status).toBe(401);
	});
});

describe('PUT /pretrip/notes', () => {
	it('saves, bumps the version and says who and when', async () => {
		const f = fixture();
		const before = Date.now();
		const res = await send(f.memberCookie, 'PUT', notesPath(f), {
			body: '  Door code 4417\n\nBring adapters\n',
			version: 0
		});
		expect(res.status).toBe(200);
		const saved = (await res.json()) as {
			body: string;
			version: number;
			updatedAt: number;
			updatedBy: { id: string; name: string };
		};
		// Stored exactly as typed: no trimming of the leading spaces or blank lines.
		expect(saved).toMatchObject({
			body: '  Door code 4417\n\nBring adapters\n',
			version: 1,
			updatedBy: { id: f.member, name: 'ZZ Mem' }
		});
		expect(saved.updatedAt).toBeGreaterThanOrEqual(before);

		const read = await send(f.cookie, 'GET', notesPath(f));
		expect(await read.json()).toEqual(saved);

		const next = await send(f.cookie, 'PUT', notesPath(f), { body: 'v2', version: 1 });
		expect(await next.json()).toMatchObject({
			body: 'v2',
			version: 2,
			updatedBy: { id: f.organizer, name: 'ZZ Org' }
		});
	});

	it('saves an identical body as a normal write', async () => {
		const f = fixture();
		await send(f.cookie, 'PUT', notesPath(f), { body: 'same', version: 0 });
		const res = await send(f.memberCookie, 'PUT', notesPath(f), { body: 'same', version: 1 });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ version: 2, updatedBy: { id: f.member } });
	});

	it('lets a member empty the notes', async () => {
		const f = fixture();
		await send(f.cookie, 'PUT', notesPath(f), { body: 'x', version: 0 });
		const res = await send(f.memberCookie, 'PUT', notesPath(f), { body: '', version: 1 });
		expect(await res.json()).toMatchObject({ body: '', version: 2 });
	});

	it('answers a stale version 409 with the current notes', async () => {
		const f = fixture();
		const won = await (
			await send(f.cookie, 'PUT', notesPath(f), { body: 'organizer was first', version: 0 })
		).json();
		const res = await send(f.memberCookie, 'PUT', notesPath(f), {
			body: 'member typed this',
			version: 0
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: CONFLICT, notes: won });
		expect(CONFLICT).toBe('Someone else changed the notes.');
		// Nothing was written by the loser.
		const read = await send(f.cookie, 'GET', notesPath(f));
		expect(await read.json()).toEqual(won);
	});

	it('refuses a body over the limit with the copy sentence', async () => {
		const f = fixture();
		expect(notesBodyTooLong()).toBe(copy.preparation.notes.tooLong);
		const over = await send(f.cookie, 'PUT', notesPath(f), {
			body: 'n'.repeat(MAX_NOTES_BODY + 1),
			version: 0
		});
		expect(await error(over, 400)).toBe(copy.preparation.notes.tooLong);
		const at = await send(f.cookie, 'PUT', notesPath(f), {
			body: 'n'.repeat(MAX_NOTES_BODY),
			version: 0
		});
		expect(at.status).toBe(200);
	});

	it('refuses a body that is not a string or a version that is not a whole count', async () => {
		const f = fixture();
		for (const bad of [
			{ version: 0 },
			{ body: null, version: 0 },
			{ body: 42, version: 0 },
			{ body: ['x'], version: 0 },
			{ body: 'x' },
			{ body: 'x', version: '0' },
			{ body: 'x', version: 1.5 },
			{ body: 'x', version: -1 },
			{ body: 'x', version: null }
		]) {
			const res = await send(f.cookie, 'PUT', notesPath(f), bad);
			expect(await error(res, 400)).toBe(copy.preparation.notes.saveFallback);
		}
		const notJson = await app.request(notesPath(f), {
			method: 'PUT',
			headers: { 'content-type': 'application/json', cookie: f.cookie },
			body: '{nope'
		});
		expect(notJson.status).toBe(400);
		expect(await (await send(f.cookie, 'GET', notesPath(f))).json()).toMatchObject({
			body: '',
			version: 0
		});
	});

	it('refuses a stranger the way every pretrip route does', async () => {
		const f = fixture();
		const task = await send(f.strangerCookie, 'POST', `/trips/${f.tripId}/pretrip/tasks`, {
			label: 'ZZ Task'
		});
		const res = await send(f.strangerCookie, 'PUT', notesPath(f), { body: 'x', version: 0 });
		expect(res.status).toBe(task.status);
		expect(await error(res, 404)).toBe('Not found.');
		expect(await (await send(f.cookie, 'GET', notesPath(f))).json()).toMatchObject({
			body: '',
			version: 0
		});
	});

	it('is not refused by the schedule lock', async () => {
		const f = fixture();
		expect(
			trips.updateTrip(f.tripId, f.organizer, {
				name: 'ZZ Notes Trip',
				startDate: '2026-10-10',
				endDate: '2026-10-15',
				currency: 'USD',
				scheduleLocked: true
			})
		).toBeNull();
		const locked = await send(f.memberCookie, 'POST', `/trips/${f.tripId}/schedule/events`, {
			day: '2026-10-11',
			start: 600,
			end: 660,
			type: 'activity',
			title: 'ZZ Event'
		});
		expect(locked.status).toBe(403);
		const res = await send(f.memberCookie, 'PUT', notesPath(f), { body: 'x', version: 0 });
		expect(res.status).toBe(200);
	});

	it('publishes notes on a save, and nothing on a refusal', async () => {
		const f = fixture();
		const seen: string[] = [];
		const sub = bus.subscribe(f.tripId, f.organizer, (e) => seen.push(e.topic));
		expect(sub.ok).toBe(true);
		await send(f.memberCookie, 'PUT', notesPath(f), { body: 'x', version: 0 });
		expect(seen).toEqual(['notes']);
		await send(f.memberCookie, 'PUT', notesPath(f), { body: 'y', version: 0 });
		await send(f.memberCookie, 'PUT', notesPath(f), {
			body: 'n'.repeat(MAX_NOTES_BODY + 1),
			version: 1
		});
		await send(f.memberCookie, 'PUT', notesPath(f), { body: 7, version: 1 });
		expect(seen).toEqual(['notes']);
		expect(bus.TRIP_TOPICS).toContain('notes');
	});
});

describe('PUT /pretrip/notes with a base', () => {
	/** The organizer saves twice; the member's copy is from the first save. */
	async function raced(f: Fixture) {
		await send(f.cookie, 'PUT', notesPath(f), { body: 'shared\n', version: 0 });
		await send(f.cookie, 'PUT', notesPath(f), { body: 'shared\norganizer line\n', version: 1 });
	}

	it('merges a stale save into what is stored instead of refusing it', async () => {
		const f = fixture();
		await raced(f);
		const seen: string[] = [];
		const sub = bus.subscribe(f.tripId, f.organizer, (e) => seen.push(e.topic));
		expect(sub.ok).toBe(true);

		const res = await send(f.memberCookie, 'PUT', notesPath(f), {
			body: 'member line\nshared\n',
			version: 1,
			base: 'shared\n'
		});
		expect(res.status, await res.clone().text()).toBe(200);
		const saved = (await res.json()) as Record<string, unknown>;
		expect(saved).toMatchObject({
			body: 'member line\nshared\norganizer line\n',
			version: 3,
			updatedBy: { id: f.member, name: 'ZZ Mem' },
			merged: true
		});
		expect(seen).toEqual(['notes']);

		// What is stored is the GET shape, with no `merged` on it.
		const read = await (await send(f.cookie, 'GET', notesPath(f))).json();
		const { merged, ...shape } = saved;
		expect(merged).toBe(true);
		expect(read).toEqual(shape);
	});

	it('keeps both sides of a line both changed', async () => {
		const f = fixture();
		await send(f.cookie, 'PUT', notesPath(f), { body: 'meet at 9', version: 0 });
		await send(f.cookie, 'PUT', notesPath(f), { body: 'meet at 10', version: 1 });
		const res = await send(f.memberCookie, 'PUT', notesPath(f), {
			body: 'meet at 9 sharp',
			version: 1,
			base: 'meet at 9'
		});
		expect(await res.json()).toMatchObject({
			body: 'meet at 9 sharp\nmeet at 10',
			version: 3,
			merged: true
		});
	});

	it('still answers a stale save without a base 409', async () => {
		const f = fixture();
		await raced(f);
		const res = await send(f.memberCookie, 'PUT', notesPath(f), {
			body: 'member line\nshared\n',
			version: 1
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: CONFLICT,
			notes: { body: 'shared\norganizer line\n', version: 2 }
		});
	});

	it('refuses a merge that comes out over the limit, and writes nothing', async () => {
		const f = fixture();
		const stored = 'o'.repeat(15000);
		await send(f.cookie, 'PUT', notesPath(f), { body: stored, version: 0 });
		const seen: string[] = [];
		const sub = bus.subscribe(f.tripId, f.organizer, (e) => seen.push(e.topic));
		expect(sub.ok).toBe(true);

		const res = await send(f.memberCookie, 'PUT', notesPath(f), {
			body: 'm'.repeat(10000),
			version: 0,
			base: ''
		});
		expect(res.status).toBe(400);
		const answer = (await res.json()) as { error: string; notes: { body: string } };
		expect(answer.error).toBe(copy.preparation.notes.tooLong);
		expect(answer.notes).toMatchObject({ body: stored, version: 1 });
		expect(await (await send(f.cookie, 'GET', notesPath(f))).json()).toMatchObject({
			body: stored,
			version: 1
		});
		expect(seen).toEqual([]);
	});

	it('merges a save whose version matches but whose base is not what is stored', async () => {
		const f = fixture();
		// The member's first save (base '', v0 -> v1) is in flight; their unload
		// save goes out optimistically at v1. The organizer's save took v1 first.
		await send(f.cookie, 'PUT', notesPath(f), { body: 'organizer line', version: 0 });
		const res = await send(f.memberCookie, 'PUT', notesPath(f), {
			body: 'member line',
			version: 1,
			base: 'first draft'
		});
		expect(res.status, await res.clone().text()).toBe(200);
		expect(await res.json()).toMatchObject({
			body: 'member line\norganizer line',
			version: 2,
			updatedBy: { id: f.member },
			merged: true
		});
	});

	it('is a normal write when the version is current and the stored body is the base', async () => {
		const f = fixture();
		await send(f.cookie, 'PUT', notesPath(f), { body: 'a', version: 0 });
		const res = await send(f.memberCookie, 'PUT', notesPath(f), {
			body: 'a\nb',
			version: 1,
			base: 'a'
		});
		expect(res.status).toBe(200);
		const saved = (await res.json()) as Record<string, unknown>;
		expect(saved).toEqual({
			body: 'a\nb',
			version: 2,
			updatedAt: expect.any(Number),
			updatedBy: { id: f.member, name: 'ZZ Mem' }
		});
		expect('merged' in saved).toBe(false);
	});

	it('refuses a base that is not a string or is over the limit', async () => {
		const f = fixture();
		for (const base of [42, null, ['a'], { a: 1 }, 'n'.repeat(MAX_NOTES_BODY + 1)]) {
			const res = await send(f.cookie, 'PUT', notesPath(f), { body: 'x', version: 0, base });
			expect(await error(res, 400)).toBe(copy.preparation.notes.saveFallback);
		}
		expect(await (await send(f.cookie, 'GET', notesPath(f))).json()).toMatchObject({
			body: '',
			version: 0
		});
	});
});

describe('PUT /pretrip/notes with a priorBase (a speculative save)', () => {
	// The reviewer's case. The store holds B0 at version 1. The member's save of
	// L1 (base B0, version 1) is in flight when the tab hides, so a speculative
	// save of L2 goes out with base L1, priorBase B0 and version 2.
	const B0 = 'Packing';
	const L1 = 'Packing\nmilk\neggs';
	const L2 = 'Packing\nmilk\neggs\nbread';

	async function stored(f: Fixture) {
		return (await (await send(f.cookie, 'GET', notesPath(f))).json()) as {
			body: string;
			version: number;
		};
	}

	async function speculative(f: Fixture) {
		return send(f.memberCookie, 'PUT', notesPath(f), {
			body: L2,
			version: 2,
			base: L1,
			priorBase: B0
		});
	}

	async function start(f: Fixture) {
		await send(f.cookie, 'PUT', notesPath(f), { body: B0, version: 0 });
	}

	it('keeps every line when the in-flight save never landed', async () => {
		const f = fixture();
		await start(f);
		const res = await speculative(f);
		expect(res.status, await res.clone().text()).toBe(200);
		const saved = (await res.json()) as Record<string, unknown>;
		expect(saved).toMatchObject({ body: L2, version: 2, updatedBy: { id: f.member } });
		expect('merged' in saved).toBe(false);
	});

	it('is a plain write when the in-flight save landed', async () => {
		const f = fixture();
		await start(f);
		await send(f.memberCookie, 'PUT', notesPath(f), { body: L1, version: 1, base: B0 });
		const res = await speculative(f);
		const saved = (await res.json()) as Record<string, unknown>;
		expect(saved).toMatchObject({ body: L2, version: 3 });
		expect('merged' in saved).toBe(false);
	});

	it('merges from the older base when someone saved after the in-flight save', async () => {
		const f = fixture();
		await start(f);
		await send(f.memberCookie, 'PUT', notesPath(f), { body: L1, version: 1, base: B0 });
		await send(f.cookie, 'PUT', notesPath(f), { body: `${L1}\nhat`, version: 2 });
		const res = await speculative(f);
		expect(res.status).toBe(200);
		const saved = (await res.json()) as { body: string; version: number; merged?: boolean };
		expect(saved).toMatchObject({
			body: 'Packing\nmilk\neggs\nbread\nhat',
			version: 4,
			merged: true
		});
		// The in-flight lines are on both sides of the merge and appear once.
		expect(saved.body.match(/milk/g)).toHaveLength(1);
		expect(saved.body.match(/eggs/g)).toHaveLength(1);
	});

	it('merges from the older base when someone else saved over B0 instead', async () => {
		const f = fixture();
		await start(f);
		await send(f.cookie, 'PUT', notesPath(f), { body: 'Packing\nhat', version: 1 });
		const res = await speculative(f);
		expect(await res.json()).toMatchObject({
			body: 'Packing\nmilk\neggs\nbread\nhat',
			version: 3,
			merged: true
		});
	});

	it('is why the field exists: without it the in-flight lines are lost', async () => {
		const f = fixture();
		await start(f);
		const res = await send(f.memberCookie, 'PUT', notesPath(f), {
			body: L2,
			version: 2,
			base: L1
		});
		expect(await res.json()).toMatchObject({ body: 'Packing\nbread', merged: true });
	});

	it('writes no duplicate when the in-flight save lands after the speculative one', async () => {
		// The mobile probe's case: the in-flight save turned a line into
		// "LONE ONE", the speculative save carried on typing to "LONE ONE TWO",
		// and the network delivered them in the opposite order.
		const f = fixture();
		const b0 = 'Title\nline one';
		const l1 = 'Title\nLONE ONE';
		const l2 = 'Title\nLONE ONE TWO';
		await send(f.cookie, 'PUT', notesPath(f), { body: b0, version: 0 });
		const speculativeFirst = await send(f.memberCookie, 'PUT', notesPath(f), {
			body: l2,
			version: 2,
			base: l1,
			priorBase: b0
		});
		expect(await speculativeFirst.json()).toMatchObject({ body: l2, version: 2 });

		const lateInFlight = await send(f.memberCookie, 'PUT', notesPath(f), {
			body: l1,
			version: 1,
			base: b0
		});
		expect(lateInFlight.status).toBe(200);
		const saved = (await lateInFlight.json()) as { body: string };
		expect(saved).toMatchObject({ body: l2, version: 3, merged: true });
		expect(saved.body.match(/LONE ONE/g)).toHaveLength(1);
		expect(await stored(f)).toMatchObject({ body: l2, version: 3 });
	});

	it('refuses a priorBase that is not a string, is over the limit, or has no base', async () => {
		const f = fixture();
		await start(f);
		for (const extra of [
			{ base: B0, priorBase: null },
			{ base: B0, priorBase: 42 },
			{ base: B0, priorBase: ['a'] },
			{ base: B0, priorBase: 'n'.repeat(MAX_NOTES_BODY + 1) },
			{ priorBase: B0 }
		]) {
			const res = await send(f.memberCookie, 'PUT', notesPath(f), {
				body: L2,
				version: 1,
				...extra
			});
			expect(await error(res, 400)).toBe(copy.preparation.notes.saveFallback);
		}
		expect(await stored(f)).toMatchObject({ body: B0, version: 1 });
	});
});
