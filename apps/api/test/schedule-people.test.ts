import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Who is on an event, over HTTP.
 *
 * One rule is pinned here, and it is as much about what is still allowed as
 * about what is refused. An empty `people` list means everyone, on the wire and
 * in storage, and it has to keep meaning that: the people picker sends `[]`
 * every time the whole group is on a block, and an event stored with no
 * `event_people` rows is how a member who joins later is included. Refusing it
 * would refuse the commonest save in the product.
 *
 * What is refused is the one genuinely mistaken payload the model can express:
 * a list that names people and names nobody this trip has. Those ids used to be
 * dropped on the way to the database, leaving an event on everyone, which is
 * the opposite of what was asked for. A partial list is not that mistake and
 * still saves the members it names, which is the boundary these cases exist to
 * hold.
 */

const tempRoot = join(tmpdir(), `trippy-api-event-people-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'api.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

/** Verbatim, because the web layer shows this sentence to a human. */
const STRANGERS = "Nobody in that list is on this trip. Pick from the trip's members.";

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let app: Hono;

interface Fixture {
	organizer: string;
	member: string;
	cookie: string;
	tripId: string;
}

const DAY = '2026-10-02';

beforeAll(async () => {
	const [dbMod, authMod, tripsMod, middleware, routes] = await Promise.all([
		import('@trippy/server/db'),
		import('@trippy/server/auth'),
		import('@trippy/server/trips'),
		import('../src/middleware.ts'),
		import('../src/routes/schedule.ts')
	]);
	db = dbMod.db;
	auth = authMod;
	trips = tripsMod;

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

/** A trip of two: the organizer who writes, and one other member to name. */
function fixture(): Fixture {
	const organizer = auth.createUser(
		`people-${crypto.randomUUID()}@example.test`,
		'ZZ Organizer',
		'password123'
	).id;
	const member = auth.createUser(
		`people-${crypto.randomUUID()}@example.test`,
		'ZZ Member',
		'password123'
	).id;
	const tripId = trips.createTrip(organizer, {
		name: 'ZZ People Trip',
		startDate: '2026-10-01',
		endDate: '2026-10-03',
		homeCurrency: 'USD'
	}).id!;
	db.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'member')`).run(
		tripId,
		member
	);
	return { organizer, member, cookie: `session=${auth.createSession(organizer)}`, tripId };
}

function post(f: Fixture, body: Record<string, unknown>) {
	return app.request(`/trips/${f.tripId}/schedule/events`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: f.cookie },
		body: JSON.stringify({ day: DAY, start: 9 * 60, duration: 60, title: 'ZZ Museum', ...body })
	});
}

function put(f: Fixture, eventId: string, body: Record<string, unknown>) {
	return app.request(`/trips/${f.tripId}/schedule/events/${eventId}/people`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json', cookie: f.cookie },
		body: JSON.stringify(body)
	});
}

/** Who the database says is on the event, which is empty for "everyone". */
function storedPeople(eventId: string): string[] {
	return (
		db
			.prepare(`SELECT user_id FROM event_people WHERE event_id = ? ORDER BY user_id`)
			.all(eventId) as unknown as { user_id: string }[]
	).map((r) => r.user_id);
}

async function created(res: Response): Promise<string> {
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

/** The event as the board hands it back, which is what a client reads. */
async function loaded(f: Fixture, eventId: string): Promise<{ people: string[] }> {
	const res = await app.request(`/trips/${f.tripId}/schedule?day=${DAY}`, {
		headers: { cookie: f.cookie }
	});
	expect(res.status).toBe(200);
	const payload = (await res.json()) as {
		board: { events: { id: string; people: string[] }[] }[];
	};
	const event = payload.board[0].events.find((e) => e.id === eventId);
	expect(event).toBeTruthy();
	return event!;
}

describe('who is on an event', () => {
	it('refuses a create naming nobody on this trip', async () => {
		const f = fixture();
		const res = await post(f, { people: ['ghost-one', 'ghost-two'] });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: STRANGERS });
	});

	it('refuses a people save naming nobody on this trip, and changes nothing', async () => {
		const f = fixture();
		const id = await created(await post(f, { people: [f.organizer] }));

		const res = await put(f, id, { people: ['ghost-one'] });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: STRANGERS });
		// The refusal is not a half-write: who was on it before is who is on it now.
		expect(storedPeople(id)).toEqual([f.organizer]);
	});

	it('keeps the members of a partly stale list on create', async () => {
		const f = fixture();
		// One id that has left the trip, or never was on it, alongside two that
		// are. This is not the mistake above and must still save the two.
		const id = await created(await post(f, { people: [f.organizer, 'ghost-one', f.member] }));
		expect(storedPeople(id)).toEqual([f.organizer, f.member].sort());
	});

	it('keeps the members of a partly stale list on a people save', async () => {
		const f = fixture();
		const id = await created(await post(f, { people: [f.organizer] }));

		const res = await put(f, id, { people: [f.organizer, 'ghost-one', f.member] });
		expect(res.status).toBe(200);
		expect(storedPeople(id)).toEqual([f.organizer, f.member].sort());
	});

	it('takes an empty list on create as everyone, storing no rows', async () => {
		const f = fixture();
		const id = await created(await post(f, { people: [] }));
		expect(storedPeople(id)).toEqual([]);
		expect((await loaded(f, id)).people).toEqual([]);
	});

	it('takes an empty list on a people save as everyone, clearing the rows', async () => {
		const f = fixture();
		const id = await created(await post(f, { people: [f.organizer] }));

		const res = await put(f, id, { people: [] });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(storedPeople(id)).toEqual([]);
		expect((await loaded(f, id)).people).toEqual([]);
	});

	it('takes an absent list on create as everyone too', async () => {
		const f = fixture();
		// The add dialog omits the field for a block nobody has been picked for,
		// and that is the same request as an empty one.
		const id = await created(await post(f, {}));
		expect(storedPeople(id)).toEqual([]);
	});

	it('still loads an event stored with no rows, and still reads it as everyone', async () => {
		const f = fixture();
		const id = await created(await post(f, { people: [] }));
		// The shape real rows in the live database are in: the event exists, the
		// join table has nothing for it, and the board hands back an empty list.
		expect(storedPeople(id)).toEqual([]);
		expect((await loaded(f, id)).people).toEqual([]);
	});

	it('saves the whole roster when it is named outright', async () => {
		const f = fixture();
		const id = await created(await post(f, { people: [f.organizer, f.member] }));
		expect(storedPeople(id)).toEqual([f.organizer, f.member].sort());

		const res = await put(f, id, { people: [f.organizer, f.member] });
		expect(res.status).toBe(200);
		expect(storedPeople(id)).toEqual([f.organizer, f.member].sort());
	});
});
