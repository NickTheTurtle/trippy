import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The day an expense happened, over HTTP.
 *
 * Persistence already knows how to store and default `spent_on`; what these
 * cases pin is the part that only exists at this layer: the wire field, the
 * refusal of a date nobody meant to type, and the create-versus-update
 * asymmetry, which is easy to break by turning "the body said nothing" into
 * "the body said today". The FX case is here too, because "the date never
 * touches the rate" is a rule a route could break by re-recording an expense.
 */

const tempRoot = join(tmpdir(), `trippy-api-spent-on-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'api.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let app: Hono;

const today = () => new Date().toISOString().slice(0, 10);

interface Fixture {
	organizer: string;
	cookie: string;
	tripId: string;
}

beforeAll(async () => {
	const [dbMod, authMod, tripsMod, middleware, routes] = await Promise.all([
		import('@trippy/server/db'),
		import('@trippy/server/auth'),
		import('@trippy/server/trips'),
		import('../src/middleware.ts'),
		import('../src/routes/expenses.ts')
	]);
	db = dbMod.db;
	auth = authMod;
	trips = tripsMod;

	// The same mount `routes/trips.ts` uses, so `requireMember` sees the same
	// `:tripId` parameter it does in the real app.
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

function fixture(label = 'spent-on'): Fixture {
	const organizer = auth.createUser(
		`${label}-${crypto.randomUUID()}@example.test`,
		label,
		'password123'
	).id;
	const tripId = trips.createTrip(organizer, {
		name: 'ZZ Spent On Trip',
		startDate: '2026-10-01',
		endDate: '2026-10-03',
		homeCurrency: 'USD'
	}).id!;
	return { organizer, cookie: `session=${auth.createSession(organizer)}`, tripId };
}

function post(f: Fixture, body: Record<string, unknown>) {
	return app.request(`/trips/${f.tripId}/expenses`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: f.cookie },
		body: JSON.stringify({
			description: 'ZZ Dinner',
			amount: 20,
			payerId: f.organizer,
			participantIds: [f.organizer],
			...body
		})
	});
}

function put(f: Fixture, expenseId: string, body: Record<string, unknown>) {
	return app.request(`/trips/${f.tripId}/expenses/${expenseId}`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json', cookie: f.cookie },
		body: JSON.stringify({
			description: 'ZZ Dinner',
			amount: 20,
			payerId: f.organizer,
			participantIds: [f.organizer],
			...body
		})
	});
}

/** The expense as the list route serves it, which is what the client renders. */
async function listed(f: Fixture, expenseId: string) {
	const res = await app.request(`/trips/${f.tripId}/expenses`, { headers: { cookie: f.cookie } });
	expect(res.status).toBe(200);
	const json = (await res.json()) as { expenses: { id: string; spent_on: string }[] };
	return json.expenses.find((e) => e.id === expenseId)!;
}

function fxRate(expenseId: string): number | null {
	const row = db.prepare(`SELECT fx_rate FROM expenses WHERE id = ?`).get(expenseId) as {
		fx_rate: number | null;
	};
	return row.fx_rate;
}

async function created(res: Response): Promise<string> {
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

describe('the day an expense happened', () => {
	it('round-trips a date sent on create', async () => {
		const f = fixture();
		const id = await created(await post(f, { spentOn: '2026-10-02' }));
		expect((await listed(f, id)).spent_on).toBe('2026-10-02');
	});

	it('falls back to today when create says nothing about the date', async () => {
		const f = fixture();
		const id = await created(await post(f, {}));
		expect((await listed(f, id)).spent_on).toBe(today());
	});

	it('treats a blank date on create the same as an absent one', async () => {
		const f = fixture();
		const id = await created(await post(f, { spentOn: '   ' }));
		expect((await listed(f, id)).spent_on).toBe(today());
	});

	it('keeps the stored date when an edit says nothing about it', async () => {
		const f = fixture();
		const id = await created(await post(f, { spentOn: '2026-10-02' }));
		// The field is absent, not blank and not today: an edit that is silent
		// about the date must not drag a backdated expense forward.
		const res = await put(f, id, { description: 'ZZ Dinner, renamed' });
		expect(res.status).toBe(200);
		expect((await listed(f, id)).spent_on).toBe('2026-10-02');
	});

	it('keeps the stored date when an edit sends a blank one', async () => {
		const f = fixture();
		const id = await created(await post(f, { spentOn: '2026-10-02' }));
		expect((await put(f, id, { spentOn: '' })).status).toBe(200);
		expect((await listed(f, id)).spent_on).toBe('2026-10-02');
	});

	it('moves the date when an edit sends one', async () => {
		const f = fixture();
		const id = await created(await post(f, { spentOn: '2026-10-02' }));
		expect((await put(f, id, { spentOn: '2026-10-03' })).status).toBe(200);
		expect((await listed(f, id)).spent_on).toBe('2026-10-03');
	});

	it('refuses a year outside the window, on create and on edit', async () => {
		const f = fixture();
		for (const day of ['1200-01-01', '3000-01-01']) {
			const res = await post(f, { spentOn: day });
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'Pick a date between 2000 and 2100.' });
		}

		const id = await created(await post(f, { spentOn: '2026-10-02' }));
		const edit = await put(f, id, { spentOn: '3000-01-01' });
		expect(edit.status).toBe(400);
		expect(await edit.json()).toEqual({ error: 'Pick a date between 2000 and 2100.' });
		// The refusal is total: nothing about the expense changed.
		expect((await listed(f, id)).spent_on).toBe('2026-10-02');
	});

	it('refuses a malformed date rather than quietly dating it today', async () => {
		const f = fixture();
		for (const day of ['2026-13-45', 'not-a-date', '2026-2-3', 20261002]) {
			const res = await post(f, { spentOn: day });
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'Pick a valid date.' });
		}
	});

	it('locks the rate to when the expense was entered, whatever date it carries', async () => {
		const f = fixture();
		// Two euro expenses on the same home currency, one backdated, one not.
		const backdated = await created(await post(f, { currency: 'EUR', spentOn: '2001-01-01' }));
		const current = await created(await post(f, { currency: 'EUR', spentOn: today() }));
		expect(fxRate(backdated)).not.toBeNull();
		expect(fxRate(backdated)).toBe(fxRate(current));

		// Moving an expense's date is not a reason to re-price it either.
		const before = fxRate(current);
		expect((await put(f, current, { currency: 'EUR', spentOn: '2001-01-01' })).status).toBe(200);
		expect(fxRate(current)).toBe(before);
	});
});
