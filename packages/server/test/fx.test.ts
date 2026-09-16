import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CURRENCY_CODES } from '@trippy/core/currency';

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

	/**
	 * The date an expense carries is descriptive. The rate provider serves only
	 * current rates and has no historical lookup, so a backdated expense cannot
	 * be honoured with the rate of the day it names; and a rate that moved
	 * retroactively would shift every member's settled balance without anybody
	 * touching a number. So the date orders the ledger and does nothing else.
	 */
	it('is worth the same whatever day it is dated, before and after a rate move', async () => {
		const { tripId, expenseId } = tripWithEuroDinner();
		const alice = expenses.expenseShares(tripId).get(expenseId)!.payerId;
		const entered = homeTotal(tripId, expenseId);
		const lockedRate = (
			db.prepare(`SELECT fx_rate FROM expenses WHERE id = ?`).get(expenseId) as { fx_rate: number }
		).fx_rate;
		const parts = [{ userId: alice, weight: 1 }];

		const backdate = (day: string) =>
			expenses.updateExpense(
				tripId,
				alice,
				expenseId,
				alice,
				'Dinner in Athens',
				10_000,
				'EUR',
				parts,
				'even',
				null,
				day
			);

		// A year back, before the rate moves at all.
		expect(backdate('2025-01-15').ok).toBe(true);
		expect(homeTotal(tripId, expenseId)).toBe(entered);

		await moveRates(0.25);

		// And a year forward, after it has. Neither date revalues the dinner.
		expect(backdate('2027-12-31').ok).toBe(true);
		expect(homeTotal(tripId, expenseId)).toBe(entered);
		expect(expenses.balances(tripId).reduce((n, b) => n + b.netCents, 0)).toBe(0);

		// The stored rate is untouched, not merely re-derived to the same number.
		const row = db
			.prepare(`SELECT fx_rate, fx_home, spent_on FROM expenses WHERE id = ?`)
			.get(expenseId) as { fx_rate: number | null; fx_home: string | null; spent_on: string };
		expect(row.spent_on).toBe('2027-12-31');
		expect(row.fx_home).toBe('USD');
		expect(row.fx_rate).toBe(lockedRate);
	});

	it('records today when no date is supplied, and is convertible either way', () => {
		const { tripId, expenseId } = tripWithEuroDinner();
		const stored = db.prepare(`SELECT spent_on FROM expenses WHERE id = ?`).get(expenseId) as {
			spent_on: string;
		};
		expect(stored.spent_on).toBe(new Date().toISOString().slice(0, 10));
		expect(homeTotal(tripId, expenseId)).toBeGreaterThan(0);
	});
});

/**
 * A currency the app offers but cannot convert used to be worth exactly as much
 * as the dollar.
 *
 * `perUsd` defaulted to 1 for an unknown code, which is indistinguishable from
 * a correct conversion, so a trip in a currency missing from the rate table
 * folded every foreign expense into its total at par with nothing on screen
 * saying so. The picker offered two such codes. The list now lives beside the
 * table it is converted with, and an unconvertible code throws.
 */
describe('the currency list', () => {
	it('offers only currencies that convert without the network', () => {
		for (const code of CURRENCY_CODES) {
			expect(() => fx.rateTo(code, 'USD')).not.toThrow();
			expect(fx.rateTo(code, code)).toBe(1);
			expect(fx.rateTo(code, 'USD')).toBeGreaterThan(0);
		}
	});

	it('refuses a code it has no rate for rather than treating it as a dollar', () => {
		expect(() => fx.rateTo('XYZ', 'USD')).toThrow(/XYZ/);
		expect(() => fx.rateTo('USD', 'XYZ')).toThrow(/XYZ/);
	});

	it('still converts a code the live feed adds but the fallback lacks', async () => {
		// The feed is the authority once it lands; the fallback is only a floor.
		await moveRates(0.5);
		expect(fx.rateTo('EUR', 'USD')).toBeCloseTo(2, 10);
	});
});
