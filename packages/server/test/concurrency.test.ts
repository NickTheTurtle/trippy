import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * What two people doing the same thing at the same time does to the ledger and
 * the checklist.
 *
 * Every case here is one that was reproduced against a running server before it
 * was fixed. They are pinned at the persistence layer rather than over HTTP
 * because that is where the decisions live, and because a test that has to bind
 * a port is a test people stop running.
 *
 * The API is single-threaded over one synchronous SQLite connection, so none of
 * these are torn writes. They are *logical* races: two well-formed requests that
 * are each correct alone and wrong together. Calling the functions in sequence
 * reproduces all of them, which is the point: several were never races at all,
 * only bugs that concurrency made easy to hit.
 */

const tempRoot = join(tmpdir(), `trippy-concurrency-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'concurrency.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let auth: typeof import('../src/infra/auth.ts');
let trips: typeof import('../src/persistence/trips.ts');
let members: typeof import('../src/persistence/members.ts');
let expenses: typeof import('../src/persistence/expenses.ts');
let tasks: typeof import('../src/persistence/tasks.ts');
let events: typeof import('../src/events.ts');

beforeAll(async () => {
	[{ db }, auth, trips, members, expenses, tasks, events] = await Promise.all([
		import('../src/db.ts'),
		import('../src/infra/auth.ts'),
		import('../src/persistence/trips.ts'),
		import('../src/persistence/members.ts'),
		import('../src/persistence/expenses.ts'),
		import('../src/persistence/tasks.ts'),
		import('../src/events.ts')
	]);
});

beforeEach(() => {
	events.closeAll();
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
});

afterEach(() => {
	events.closeAll();
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

interface Party {
	tripId: string;
	alice: string;
	bob: string;
	cara: string;
	all: string[];
}

function user(label: string): string {
	return auth.createUser(`${label}-${crypto.randomUUID()}@example.test`, label, 'password123').id;
}

function party(): Party {
	const alice = user('alice');
	const bob = user('bob');
	const cara = user('cara');
	const tripId = trips.createTrip(alice, {
		name: 'Concurrency Trip',
		startDate: '2026-10-01',
		endDate: '2026-10-05',
		homeCurrency: 'USD'
	}).id!;
	for (const id of [bob, cara]) {
		expect(members.inviteToTrip(tripId, alice, auth.findUserById(id)!.email)).toBe('added');
	}
	return { tripId, alice, bob, cara, all: [alice, bob, cara] };
}

/** The ledger must always sum to zero, whoever has come and gone. */
function netsToZero(tripId: string): number {
	return expenses.balances(tripId).reduce((n, b) => n + b.netCents, 0);
}

function spend(p: Party, description: string, major: number, mode: 'even' | 'exact' = 'even') {
	const parts = p.all.map((id) => ({ userId: id, weight: mode === 'even' ? 1 : major / 3 }));
	return expenses.addExpense(
		p.tripId,
		p.alice,
		p.alice,
		description,
		major * 100,
		'USD',
		parts,
		mode
	);
}

describe('ticking a shared box', () => {
	it('settles on the state both people asked for, not on who went second', () => {
		const p = party();
		const taskId = tasks.addTask(p.tripId, p.alice, 'task', 'Book the ferry', [], null)!;

		// Both see an unticked box and both tick it. Under a flip this ends
		// unticked and neither of them is told, which is the failure that started
		// all of this.
		tasks.toggleTask(p.tripId, p.alice, taskId, undefined, true);
		tasks.toggleTask(p.tripId, p.bob, taskId, undefined, true);

		const row = tasks.listTasks(p.tripId, 'task').find((t) => t.id === taskId);
		expect(row?.done).toBe(true);
	});

	it('treats a double tap as one tick', () => {
		const p = party();
		const taskId = tasks.addTask(p.tripId, p.alice, 'task', 'Print the tickets', [], null)!;

		const first = tasks.toggleTask(p.tripId, p.alice, taskId, undefined, true);
		const second = tasks.toggleTask(p.tripId, p.alice, taskId, undefined, true);

		expect(first).toEqual({ ok: true, done: true });
		expect(second).toEqual({ ok: true, done: true });
	});

	it('still flips when no state is given, so an older client keeps working', () => {
		const p = party();
		const taskId = tasks.addTask(p.tripId, p.alice, 'task', 'Pack the charger', [], null)!;

		expect(tasks.toggleTask(p.tripId, p.alice, taskId)).toEqual({ ok: true, done: true });
		expect(tasks.toggleTask(p.tripId, p.alice, taskId)).toEqual({ ok: true, done: false });
	});

	it('unticks when asked to', () => {
		const p = party();
		const taskId = tasks.addTask(p.tripId, p.alice, 'task', 'Confirm the hotel', [], null)!;

		tasks.toggleTask(p.tripId, p.alice, taskId, undefined, true);
		expect(tasks.toggleTask(p.tripId, p.bob, taskId, undefined, false)).toEqual({
			ok: true,
			done: false
		});
	});
});

describe('two people editing the same row', () => {
	it('refuses the second save of a task rather than losing the first', () => {
		const p = party();
		const taskId = tasks.addTask(p.tripId, p.alice, 'task', 'Original', [], null)!;
		const opened = tasks.listTasks(p.tripId, 'task').find((t) => t.id === taskId)!.version;

		const first = tasks.updateTask(p.tripId, p.alice, taskId, 'Alice wrote this', [], opened);
		const second = tasks.updateTask(p.tripId, p.bob, taskId, 'Bob wrote this', [], opened);

		expect(first.ok).toBe(true);
		expect(second).toEqual({ ok: false, reason: 'conflict' });
		expect(tasks.listTasks(p.tripId, 'task').find((t) => t.id === taskId)?.label).toBe(
			'Alice wrote this'
		);
	});

	it('refuses the second save of an expense', () => {
		const p = party();
		const id = spend(p, 'Dinner', 60)!;
		const opened = expenses.listExpenses(p.tripId).find((e) => e.id === id)!.version;
		const parts = p.all.map((u) => ({ userId: u, weight: 1 }));

		const first = expenses.updateExpense(
			p.tripId,
			p.alice,
			id,
			p.alice,
			'Dinner (Alice)',
			6000,
			'USD',
			parts,
			'even',
			opened
		);
		const second = expenses.updateExpense(
			p.tripId,
			p.bob,
			id,
			p.bob,
			'Dinner (Bob)',
			9000,
			'USD',
			parts,
			'even',
			opened
		);

		expect(first.ok).toBe(true);
		expect(second).toEqual({ ok: false, reason: 'conflict' });
		expect(expenses.listExpenses(p.tripId).find((e) => e.id === id)?.description).toBe(
			'Dinner (Alice)'
		);
	});

	it('lets a client that sends no version through, so protection is opt-in', () => {
		const p = party();
		const taskId = tasks.addTask(p.tripId, p.alice, 'task', 'Original', [], null)!;

		tasks.updateTask(p.tripId, p.alice, taskId, 'Changed once', []);
		expect(tasks.updateTask(p.tripId, p.bob, taskId, 'Changed twice', []).ok).toBe(true);
	});

	it('reports a missing row as missing, not as a conflict', () => {
		const p = party();
		expect(tasks.updateTask(p.tripId, p.alice, 'no-such-task', 'x', [], 1)).toEqual({
			ok: false,
			reason: 'missing'
		});
	});
});

describe('marking a transfer paid', () => {
	it('records one payment however many times the button is pressed', () => {
		const p = party();
		spend(p, 'Dinner', 60);
		const transfer = expenses.settlement(p.tripId)[0];
		expect(transfer.token).toBeTruthy();

		const first = expenses.recordSettlement(
			p.tripId,
			p.alice,
			transfer.fromId,
			transfer.toId,
			transfer.amountCents,
			transfer.token
		);
		const second = expenses.recordSettlement(
			p.tripId,
			p.bob,
			transfer.fromId,
			transfer.toId,
			transfer.amountCents,
			transfer.token
		);

		expect(first?.duplicate).toBe(false);
		expect(second?.duplicate).toBe(true);
		expect(second?.id).toBe(first?.id);
		expect(expenses.listExpenses(p.tripId).filter((e) => e.settlement === 1)).toHaveLength(1);
	});

	it('does not invert the debt when pressed twice', () => {
		const p = party();
		spend(p, 'Dinner', 60);
		const transfer = expenses.settlement(p.tripId)[0];
		const before = expenses.balances(p.tripId).find((b) => b.id === transfer.fromId)!.netCents;

		expenses.recordSettlement(
			p.tripId,
			p.alice,
			transfer.fromId,
			transfer.toId,
			transfer.amountCents,
			transfer.token
		);
		expenses.recordSettlement(
			p.tripId,
			p.bob,
			transfer.fromId,
			transfer.toId,
			transfer.amountCents,
			transfer.token
		);

		const after = expenses.balances(p.tripId).find((b) => b.id === transfer.fromId)!.netCents;
		expect(before).toBeLessThan(0);
		expect(after).toBe(0);
		expect(netsToZero(p.tripId)).toBe(0);
	});

	it('records a genuinely repeated payment, because the balances moved under it', () => {
		const p = party();
		spend(p, 'Dinner', 60);
		const first = expenses.settlement(p.tripId)[0];
		expenses.recordSettlement(
			p.tripId,
			p.alice,
			first.fromId,
			first.toId,
			first.amountCents,
			first.token
		);

		// Same two people, same amount, but the ledger is in a different state, so
		// the token differs and this is a second real payment rather than a
		// duplicate press.
		spend(p, 'Lunch', 60);
		const next = expenses.settlement(p.tripId).find((t) => t.fromId === first.fromId)!;
		expect(next.token).not.toBe(first.token);

		const again = expenses.recordSettlement(
			p.tripId,
			p.alice,
			next.fromId,
			next.toId,
			next.amountCents,
			next.token
		);
		expect(again?.duplicate).toBe(false);
		expect(expenses.listExpenses(p.tripId).filter((e) => e.settlement === 1)).toHaveLength(2);
	});

	it('still records a payment sent without a token', () => {
		const p = party();
		spend(p, 'Dinner', 60);
		const transfer = expenses.settlement(p.tripId)[0];

		const result = expenses.recordSettlement(
			p.tripId,
			p.alice,
			transfer.fromId,
			transfer.toId,
			transfer.amountCents
		);
		expect(result?.duplicate).toBe(false);
	});
});

describe('removing someone who still has money in the trip', () => {
	it('re-divides an even split across the people who remain', () => {
		const p = party();
		spend(p, 'Taxi', 30);

		expect(members.removeMember(p.tripId, p.alice, p.cara)).toBe(true);

		const row = expenses.listExpenses(p.tripId).find((e) => e.description === 'Taxi')!;
		expect(row.participants).toBe(2);
		expect(row.needsReview).toBe(false);
		expect(netsToZero(p.tripId)).toBe(0);
	});

	it('leaves a stated amount alone and flags it instead of guessing', () => {
		const p = party();
		spend(p, 'Set menu', 30, 'exact');

		members.removeMember(p.tripId, p.alice, p.cara);

		const row = expenses.listExpenses(p.tripId).find((e) => e.description === 'Set menu')!;
		expect(row.participants).toBe(3);
		expect(row.needsReview).toBe(true);
	});

	it('keeps the ledger summing to zero by carrying the departed balance', () => {
		const p = party();
		spend(p, 'Set menu', 30, 'exact');

		members.removeMember(p.tripId, p.alice, p.cara);

		const ledger = expenses.balances(p.tripId);
		expect(ledger.filter((b) => b.former)).toHaveLength(1);
		expect(netsToZero(p.tripId)).toBe(0);
	});

	it('does not flag an expense the departed member was never on', () => {
		const p = party();
		expenses.addExpense(
			p.tripId,
			p.alice,
			p.alice,
			'Just us two',
			4000,
			'USD',
			[
				{ userId: p.alice, weight: 1 },
				{ userId: p.bob, weight: 1 }
			],
			'even'
		);

		members.removeMember(p.tripId, p.alice, p.cara);

		const row = expenses.listExpenses(p.tripId).find((e) => e.description === 'Just us two')!;
		expect(row.needsReview).toBe(false);
	});
});

describe('guards that already held', () => {
	it('refuses a duplicate city', () => {
		const p = party();
		const city = {
			name: 'Athens',
			country: 'Greece',
			tz: 'Europe/Athens',
			lat: 37.98,
			lng: 23.73
		};
		expect(trips.addCity(p.tripId, p.alice, city)).toBeTruthy();
		expect(trips.addCity(p.tripId, p.alice, city)).toBeNull();
	});

	it('refuses to invite somebody who is already on the trip', () => {
		const p = party();
		expect(members.inviteToTrip(p.tripId, p.alice, auth.findUserById(p.bob)!.email)).toBe('exists');
	});

	it('refuses a write from somebody who is not a member', () => {
		const p = party();
		const outsider = user('outsider');
		expect(tasks.addTask(p.tripId, outsider, 'task', 'Sneaky', [], null)).toBeNull();
	});
});
