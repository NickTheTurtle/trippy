import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * What a schedule op does with a payload it cannot read.
 *
 * Two behaviours are pinned here, and the second is the reason for the first.
 *
 * A drag whose minute was unreadable used to reach the store as `NaN`, which
 * SQLite binds as NULL, which `events.end_min` refuses: the member was shown a
 * 500 and "Something went wrong" for a request only they could fix. Every op
 * branch now answers a payload it cannot read with a 400 and a sentence.
 *
 * The rest failed the other way, which is worse to diagnose: an unreadable
 * time, an unknown type, a misspelt travel mode and a malformed day were all
 * dropped on the way to the store, so the save answered 200 and the board came
 * back with the old value. Those are 400s now too.
 *
 * What must keep working is the other half: absent still means "leave this
 * alone", and empty still means "clear it". Those are the two requests the
 * dialog makes on every save, and a validation pass that refused either would
 * be worse than the bug it fixed.
 */

const tempRoot = join(tmpdir(), `trippy-api-schedule-op-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'api.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let app: Hono;

interface Fixture {
	organizer: string;
	cookie: string;
	tripId: string;
}

const DAY = '2026-10-02';
const NEXT_DAY = '2026-10-03';

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

function fixture(): Fixture {
	const organizer = auth.createUser(
		`op-${crypto.randomUUID()}@example.test`,
		'ZZ Organizer',
		'password123'
	).id;
	const tripId = trips.createTrip(organizer, {
		name: 'ZZ Op Trip',
		startDate: '2026-10-01',
		endDate: '2026-10-03',
		homeCurrency: 'USD'
	}).id!;
	return { organizer, cookie: `session=${auth.createSession(organizer)}`, tripId };
}

function post(f: Fixture, body: Record<string, unknown>) {
	return app.request(`/trips/${f.tripId}/schedule/events`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: f.cookie },
		body: JSON.stringify({ day: DAY, start: 9 * 60, duration: 60, title: 'ZZ Museum', ...body })
	});
}

function op(f: Fixture, eventId: string, body: Record<string, unknown>) {
	return app.request(`/trips/${f.tripId}/schedule/events/${eventId}/op`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: f.cookie },
		body: JSON.stringify(body)
	});
}

async function created(res: Response): Promise<string> {
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

/** An event with a name, a place on the clock and a version to quote back. */
async function event(f: Fixture, body: Record<string, unknown> = {}): Promise<string> {
	return created(await post(f, body));
}

interface Row {
	day: string;
	end_day: string | null;
	title: string;
	type: string;
	start_min: number;
	end_min: number;
	notes: string | null;
	travel_mode: string | null;
	version: number;
}

function stored(eventId: string): Row {
	return db
		.prepare(
			`SELECT day, end_day, title, type, start_min, end_min, notes, travel_mode, version
			 FROM events WHERE id = ?`
		)
		.get(eventId) as unknown as Row;
}

/** The refusal envelope every route answers with, so the toast reads it unchanged. */
async function refusal(res: Response): Promise<string> {
	expect(res.status).toBe(400);
	return ((await res.json()) as { error: string }).error;
}

describe('a drag the server cannot read', () => {
	it('answers a null start with a 400, not the old 500', async () => {
		const f = fixture();
		const id = await event(f);
		const before = stored(id);

		// Exactly the shape the dialog and the board produce from an empty or
		// mistyped number field: `JSON.stringify` writes NaN as null.
		const res = await op(f, id, { op: 'move', startMin: null });
		expect(await refusal(res)).toBe('Pick a start time.');
		// The old path wrote NULL into a NOT NULL column, so the proof that this is
		// fixed is as much that nothing moved as that the status changed.
		expect(stored(id)).toEqual(before);
	});

	it('answers a start that is not a number with a 400', async () => {
		const f = fixture();
		const id = await event(f);
		expect(await refusal(await op(f, id, { op: 'move', startMin: 'half nine' }))).toBe(
			'Pick a start time.'
		);
	});

	it('answers a missing start with a 400', async () => {
		const f = fixture();
		const id = await event(f);
		expect(await refusal(await op(f, id, { op: 'move' }))).toBe('Pick a start time.');
	});

	it('refuses a start outside the day', async () => {
		const f = fixture();
		const id = await event(f);
		expect(await refusal(await op(f, id, { op: 'move', startMin: -30 }))).toBe(
			'Pick a start time within the day.'
		);
		expect(await refusal(await op(f, id, { op: 'move', startMin: 24 * 60 }))).toBe(
			'Pick a start time within the day.'
		);
	});

	it('refuses a day that is not a day rather than dropping it', async () => {
		const f = fixture();
		const id = await event(f);
		// Silently ignored before, so the block stayed where it was and the drag
		// reported success.
		expect(await refusal(await op(f, id, { op: 'move', startMin: 600, day: '2026-13-40' }))).toBe(
			'Pick a day.'
		);
		expect(stored(id).day).toBe(DAY);
	});

	it('still moves on a payload it can read', async () => {
		const f = fixture();
		const id = await event(f);
		const res = await op(f, id, { op: 'move', startMin: 11 * 60, day: NEXT_DAY });
		expect(res.status).toBe(200);
		const row = stored(id);
		expect(row.start_min).toBe(11 * 60);
		expect(row.end_min).toBe(12 * 60);
		expect(row.day).toBe(NEXT_DAY);
	});
});

describe('a resize the server cannot read', () => {
	it('answers a null end with a 400, not the old 500', async () => {
		const f = fixture();
		const id = await event(f);
		const before = stored(id);

		const res = await op(f, id, { op: 'resize', endMin: null });
		expect(await refusal(res)).toBe('Pick an end time.');
		expect(stored(id)).toEqual(before);
	});

	it('refuses an end outside the day', async () => {
		const f = fixture();
		const id = await event(f);
		expect(await refusal(await op(f, id, { op: 'resize', endMin: 25 * 60 }))).toBe(
			'Pick an end time within the day.'
		);
		expect(await refusal(await op(f, id, { op: 'resize', endMin: 0 }))).toBe(
			'Pick an end time within the day.'
		);
	});

	it('still resizes on a payload it can read', async () => {
		const f = fixture();
		const id = await event(f);
		const res = await op(f, id, { op: 'resize', endMin: 11 * 60 });
		expect(res.status).toBe(200);
		expect(stored(id).end_min).toBe(11 * 60);
	});
});

describe('a dialog save the server cannot read', () => {
	it('refuses a sent start that is not a number instead of ignoring it', async () => {
		const f = fixture();
		const id = await event(f);
		const res = await op(f, id, { op: 'edit', startMin: null, endMin: 11 * 60 });
		expect(await refusal(res)).toBe('Pick a start time.');
		expect(stored(id).start_min).toBe(9 * 60);
	});

	it('refuses a sent end that is not a number instead of ignoring it', async () => {
		const f = fixture();
		const id = await event(f);
		expect(await refusal(await op(f, id, { op: 'edit', endMin: 'noon' }))).toBe(
			'Pick an end time.'
		);
	});

	it('still refuses a pair that ends before it begins', async () => {
		const f = fixture();
		const id = await event(f);
		expect(await refusal(await op(f, id, { op: 'edit', startMin: 600, endMin: 605 }))).toBe(
			'An event needs to run at least 15 minutes.'
		);
	});

	it('refuses a type outside the five', async () => {
		const f = fixture();
		const id = await event(f);
		// Dropped by the store before, so the block stayed an activity and the
		// save reported success.
		expect(await refusal(await op(f, id, { op: 'edit', type: 'brunch' }))).toBe(
			'Pick an event type.'
		);
		expect(stored(id).type).toBe('activity');
	});

	it('refuses a travel mode that is not one', async () => {
		const f = fixture();
		const id = await event(f, { type: 'travel', travelMode: 'transit' });
		expect(await refusal(await op(f, id, { op: 'edit', travelMode: 'teleport' }))).toBe(
			'Pick a travel mode.'
		);
		// The misspelling used to unpin the journey, which is the opposite of what
		// somebody typing a mode is asking for.
		expect(stored(id).travel_mode).toBe('transit');
	});

	it('refuses a version that is not a whole number', async () => {
		const f = fixture();
		const id = await event(f);
		// A version that cannot be read turned the conflict check off entirely.
		expect(await refusal(await op(f, id, { op: 'edit', notes: 'ZZ', version: 'latest' }))).toBe(
			'Reload the page and try again.'
		);
		expect(stored(id).notes).toBe(null);
	});

	it('refuses a checkout on or before the check-in', async () => {
		const f = fixture();
		const id = await event(f, { type: 'stay', endDay: NEXT_DAY });
		expect(await refusal(await op(f, id, { op: 'edit', day: NEXT_DAY, endDay: DAY }))).toBe(
			'Check out after you check in.'
		);
	});

	it('derives a name again rather than ignoring a blank title', async () => {
		const f = fixture();
		const id = await event(f);
		// It used to be dropped, and the old name came back on the next load looking
		// like the save had not happened. Refusing it was one answer; deriving is
		// the one create already gives, so clearing the field names the block after
		// what it carries rather than after nothing.
		const res = await op(f, id, { op: 'edit', title: '   ' });
		expect(res.status).toBe(200);
		expect(stored(id).title).toBe('Activity');
	});

	it('refuses a title too long to store', async () => {
		const f = fixture();
		const id = await event(f);
		expect(await refusal(await op(f, id, { op: 'edit', title: 'z'.repeat(201) }))).toBe(
			'Keep it under 200 characters.'
		);
	});
});

describe('absent and empty stay different requests', () => {
	it('leaves the notes alone when the body is silent, and clears them when it is not', async () => {
		const f = fixture();
		const id = await event(f, { notes: 'ZZ bring tickets' });

		expect((await op(f, id, { op: 'edit', startMin: 600, endMin: 660 })).status).toBe(200);
		expect(stored(id).notes).toBe('ZZ bring tickets');

		expect((await op(f, id, { op: 'edit', notes: '' })).status).toBe(200);
		expect(stored(id).notes).toBe(null);
	});

	it('leaves a pinned travel mode alone when absent, and unpins it when empty', async () => {
		const f = fixture();
		const id = await event(f, { type: 'travel', travelMode: 'transit' });

		expect((await op(f, id, { op: 'edit', notes: 'ZZ' })).status).toBe(200);
		expect(stored(id).travel_mode).toBe('transit');

		expect((await op(f, id, { op: 'edit', travelMode: '' })).status).toBe(200);
		expect(stored(id).travel_mode).toBe(null);
	});

	it('leaves the title alone when the body never mentions it', async () => {
		const f = fixture();
		const id = await event(f);
		expect((await op(f, id, { op: 'edit', startMin: 600, endMin: 660 })).status).toBe(200);
		expect(stored(id).title).toBe('ZZ Museum');
	});

	it('still deletes, and still refuses an op it does not know', async () => {
		const f = fixture();
		const id = await event(f);
		expect(await refusal(await op(f, id, { op: 'reschedule' }))).toBe('Unknown op.');
		expect((await op(f, id, { op: 'delete' })).status).toBe(200);
		expect(stored(id)).toBe(undefined);
	});
});

describe('the travel mode a block is created with', () => {
	it('is stored by create, so a journey does not have to be saved and reopened', async () => {
		const f = fixture();
		// The API has always taken this on create. The add dialog is what does not
		// send it yet, which is why a mode can only be set on a second visit.
		const id = await event(f, { type: 'travel', travelMode: 'ferry', title: 'ZZ Crossing' });
		expect(stored(id).travel_mode).toBe('ferry');
	});

	it('is ignored on a type that does not travel', async () => {
		const f = fixture();
		const id = await event(f, { travelMode: 'ferry' });
		expect(stored(id).travel_mode).toBe(null);
	});
});
