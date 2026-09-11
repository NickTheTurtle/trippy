import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * What a foreign-currency expense is worth, and when that is allowed to change.
 *
 * Balances used to be rebuilt from today's rates on every read, so a euro
 * dinner was a different number of dollars each time the page loaded and a
 * settled trip could drift back out of balance on its own. Every expense tool
 * locks the rate to the transaction instead. These cases pin that: the rate an
 * expense was entered at survives a rate move, and only a real change to the
 * expense's currency re-locks it.
 *
 * The rate move is driven through the actual refresh path, with `fetch` stubbed,
 * rather than by reaching into the module's state: the thing under test is what
 * the ledger does after a refresh lands.
 */

const tempRoot = join(tmpdir(), `trippy-fx-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'fx.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let auth: typeof import('../src/infra/auth.ts');
let trips: typeof import('../src/persistence/trips.ts');
let members: typeof import('../src/persistence/members.ts');
let expenses: typeof import('../src/persistence/expenses.ts');
let fx: typeof import('../src/providers/fx.ts');
let events: typeof import('../src/events.ts');

beforeAll(async () => {
	[{ db }, auth, trips, members, expenses, fx, events] = await Promise.all([
		import('../src/db.ts'),
		import('../src/infra/auth.ts'),
		import('../src/persistence/trips.ts'),
		import('../src/persistence/members.ts'),
		import('../src/persistence/expenses.ts'),
		import('../src/providers/fx.ts'),
		import('../src/events.ts')
	]);
});

beforeEach(() => {
	events.closeAll();
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
});

afterAll(() => {
	events.closeAll();
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

/**
 * Land a new rate table through the real refresh path.
 *
 * The clock is pushed past the 12-hour cache window first, because that gate is
 * what decides a refresh happens at all and a second call inside the window is
 * meant to be a no-op. The offset accumulates so that every call in the file
 * lands beyond the window the previous one left behind.
 */
const clockStart = Date.now();
let clockOffset = 0;

async function moveRates(eurPerUsd: number): Promise<void> {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ result: 'success', rates: { USD: 1, EUR: eurPerUsd } }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		})) as typeof fetch;
	vi.useFakeTimers({ shouldAdvanceTime: true });
	try {
		clockOffset += 13 * 60 * 60 * 1000;
		vi.setSystemTime(clockStart + clockOffset);
		fx.ensureRatesFresh();
		// The refresh is fire-and-forget; let its microtasks drain.
		await new Promise((r) => setTimeout(r, 5));
		expect(fx.rateTo('EUR', 'USD')).toBeCloseTo(1 / eurPerUsd, 10);
	} finally {
		vi.useRealTimers();
		globalThis.fetch = original;
	}
}

function tripWithEuroDinner(): { tripId: string; expenseId: string } {
	const alice = auth.createUser(
		`alice-${crypto.randomUUID()}@example.test`,
		'Alice',
		'password123'
	).id;
	const bob = auth.createUser(`bob-${crypto.randomUUID()}@example.test`, 'Bob', 'password123').id;
	const tripId = trips.createTrip(alice, {
		name: 'FX Trip',
		startDate: '2026-10-01',
		endDate: '2026-10-05',
		homeCurrency: 'USD'
	}).id!;
	expect(members.addPerson(tripId, alice, 'Guest', auth.findUserById(bob)!.email)).toBe('added');

	const expenseId = expenses.addExpense(
		tripId,
		alice,
		alice,
		'Dinner in Athens',
		10_000, // €100.00
		'EUR',
		[
			{ userId: alice, weight: 1 },
			{ userId: bob, weight: 1 }
		],
		'even'
	)!;
	return { tripId, expenseId };
}

function homeTotal(tripId: string, expenseId: string): number {
	return expenses.expenseShares(tripId).get(expenseId)!.totalCents;
}

describe('a foreign-currency expense', () => {
	it('keeps the rate it was entered at when the market moves', async () => {
		const { tripId, expenseId } = tripWithEuroDinner();
		const entered = homeTotal(tripId, expenseId);
		expect(entered).toBeGreaterThan(0);

		// The euro halves against the dollar. A live conversion would now call
		// the same dinner worth twice as much.
		await moveRates(0.46);

		expect(homeTotal(tripId, expenseId)).toBe(entered);
	});

	it('converts at today rate when the row carries no stored rate', async () => {
		const { tripId, expenseId } = tripWithEuroDinner();

		// A row written before the column existed.
		db.prepare(`UPDATE expenses SET fx_rate = NULL, fx_home = NULL WHERE id = ?`).run(expenseId);

		await moveRates(0.5);
		expect(homeTotal(tripId, expenseId)).toBe(20_000); // €100 at 2 USD/EUR
	});

	it('re-locks only when the expense currency actually changes', async () => {
		const { tripId, expenseId } = tripWithEuroDinner();
		const alice = expenses.expenseShares(tripId).get(expenseId)!.payerId;
		const entered = homeTotal(tripId, expenseId);

		await moveRates(0.5);

		const parts = [{ userId: alice, weight: 1 }];
		// Correcting the description must not revalue the expense.
		expect(
			expenses.updateExpense(
				tripId,
				alice,
				expenseId,
				alice,
				'Dinner in Plaka',
				10_000,
				'EUR',
				parts,
				'even'
			).ok
		).toBe(true);
		expect(homeTotal(tripId, expenseId)).toBe(entered);

		// Saying it was actually dollars all along is a new fact, so it re-locks.
		expect(
			expenses.updateExpense(
				tripId,
				alice,
				expenseId,
				alice,
				'Dinner in Plaka',
				10_000,
				'USD',
				parts,
				'even'
			).ok
		).toBe(true);
		expect(homeTotal(tripId, expenseId)).toBe(10_000);
	});

	it('leaves a settled trip settled after a rate move', async () => {
		const { tripId } = tripWithEuroDinner();
		const before = expenses.balances(tripId).map((b) => b.netCents);

		await moveRates(0.7);

		expect(expenses.balances(tripId).map((b) => b.netCents)).toEqual(before);
		expect(before.reduce((n, c) => n + c, 0)).toBe(0);
	});
});
