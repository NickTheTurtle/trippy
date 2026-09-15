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
let lodging: typeof import('../src/persistence/lodging.ts');
let pois: typeof import('../src/persistence/pois.ts');
let events: typeof import('../src/events.ts');

beforeAll(async () => {
	[{ db }, auth, trips, members, expenses, tasks, lodging, pois, events] = await Promise.all([
		import('../src/db.ts'),
		import('../src/infra/auth.ts'),
		import('../src/persistence/trips.ts'),
		import('../src/persistence/members.ts'),
		import('../src/persistence/expenses.ts'),
		import('../src/persistence/tasks.ts'),
		import('../src/persistence/lodging.ts'),
		import('../src/persistence/pois.ts'),
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
		expect(members.addPerson(tripId, alice, 'Guest', auth.findUserById(id)!.email)).toBe('added');
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

	it('keeps an invited member who owes money, instead of deleting their expenses with them', () => {
		const p = party();
		expect(members.addPerson(p.tripId, p.alice, 'Guest', 'invited@example.test')).toBe('invited');
		const placeholder = members.listPeople(p.tripId).find((x) => x.placeholder)!;

		// Alice paid, and the invitee was charged a stated amount. Deleting the
		// placeholder user would cascade that share away and silently hand it to
		// whoever is left, so removal has to take the tombstone path instead.
		expenses.addExpense(
			p.tripId,
			p.alice,
			p.alice,
			'Their museum ticket',
			5000,
			'USD',
			[
				{ userId: p.alice, weight: 2000 },
				{ userId: placeholder.id, weight: 3000 }
			],
			'exact'
		);

		expect(members.removeMember(p.tripId, p.alice, placeholder.id)).toBe(true);

		const row = expenses.listExpenses(p.tripId).find((e) => e.description === 'Their museum ticket');
		expect(row).toBeTruthy();
		expect(row!.amount_cents).toBe(5000);
		// The point of keeping them: the row can say a human needs to look at it.
		expect(row!.needsReview).toBe(true);
		expect(members.listPeople(p.tripId).some((x) => x.id === placeholder.id)).toBe(false);
		expect(netsToZero(p.tripId)).toBe(0);
	});

	it('keeps an expense an invited member paid for, rather than deleting it outright', () => {
		const p = party();
		expect(members.addPerson(p.tripId, p.alice, 'Guest', 'payer@example.test')).toBe('invited');
		const placeholder = members.listPeople(p.tripId).find((x) => x.placeholder)!;

		expenses.addExpense(p.tripId, p.alice, placeholder.id, 'They paid the deposit', 9000, 'USD', [
			{ userId: p.alice, weight: 1 },
			{ userId: p.bob, weight: 1 }
		]);

		members.removeMember(p.tripId, p.alice, placeholder.id);

		const row = expenses.listExpenses(p.tripId).find((e) => e.description === 'They paid the deposit');
		expect(row).toBeTruthy();
		expect(row!.needsReview).toBe(true);
		expect(netsToZero(p.tripId)).toBe(0);
	});

	it('still deletes an invited member who never touched the money', () => {
		const p = party();
		expect(members.addPerson(p.tripId, p.alice, 'Guest', 'nobody@example.test')).toBe('invited');
		const placeholder = members.listPeople(p.tripId).find((x) => x.placeholder)!;

		expect(members.removeMember(p.tripId, p.alice, placeholder.id)).toBe(true);

		// Nothing references them, so there is nothing to preserve and no reason to
		// leave a row behind. Re-inviting the same address must also still work.
		expect(auth.findUserById(placeholder.id)).toBeFalsy();
		expect(members.addPerson(p.tripId, p.alice, 'Guest', 'nobody@example.test')).toBe('invited');
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
		expect(members.addPerson(p.tripId, p.alice, 'Guest', auth.findUserById(p.bob)!.email)).toBe('exists');
	});

	it('refuses a write from somebody who is not a member', () => {
		const p = party();
		const outsider = user('outsider');
		expect(tasks.addTask(p.tripId, outsider, 'task', 'Sneaky', [], null)).toBeNull();
	});
});

/**
 * One person, two devices.
 *
 * This is the case people assume is safe because there is no disagreement to
 * resolve: it is the same human, so surely they meant the last thing they did.
 * They did not. A phone left on a stale screen in a pocket is a copy of the row
 * from ten minutes ago, and saving from it is a lost update exactly like
 * somebody else's would be. The guards are per row and per version, never per
 * user, and these pin that they stay that way.
 */
describe('one person with the app open twice', () => {
	it('refuses the stale device rather than letting it overwrite the fresh one', () => {
		const p = party();
		const taskId = tasks.addTask(p.tripId, p.alice, 'task', 'Original', [], null)!;
		// Both devices loaded the same row, so both hold the same version.
		const onPhone = tasks.listTasks(p.tripId, 'task').find((t) => t.id === taskId)!.version;
		const onLaptop = onPhone;

		const laptop = tasks.updateTask(p.tripId, p.alice, taskId, 'Typed on the laptop', [], onLaptop);
		const phone = tasks.updateTask(p.tripId, p.alice, taskId, 'Typed on the phone', [], onPhone);

		expect(laptop.ok).toBe(true);
		expect(phone).toEqual({ ok: false, reason: 'conflict' });
		expect(tasks.listTasks(p.tripId, 'task').find((t) => t.id === taskId)?.label).toBe(
			'Typed on the laptop'
		);
	});

	it('refuses the stale device on an expense too, and leaves the amount alone', () => {
		const p = party();
		const id = spend(p, 'Dinner', 90)!;
		const opened = expenses.listExpenses(p.tripId).find((e) => e.id === id)!.version;

		const parts = p.all.map((u) => ({ userId: u, weight: 1 }));
		expenses.updateExpense(p.tripId, p.alice, id, p.alice, 'Dinner', 12000, 'USD', parts, 'even', opened);
		const stale = expenses.updateExpense(
			p.tripId,
			p.alice,
			id,
			p.alice,
			'Dinner',
			500,
			'USD',
			parts,
			'even',
			opened
		);

		expect(stale).toEqual({ ok: false, reason: 'conflict' });
		expect(expenses.listExpenses(p.tripId).find((e) => e.id === id)?.amount_cents).toBe(12000);
	});

	it('lets the winning device keep writing without refetching, using the version it got back', () => {
		const p = party();
		const taskId = tasks.addTask(p.tripId, p.alice, 'task', 'First', [], null)!;
		const opened = tasks.listTasks(p.tripId, 'task').find((t) => t.id === taskId)!.version;

		// This is why a successful write returns the new version: a member typing
		// two corrections in a row should not have to reload between them.
		const first = tasks.updateTask(p.tripId, p.alice, taskId, 'Second', [], opened);
		expect(first.ok).toBe(true);
		const second = tasks.updateTask(
			p.tripId,
			p.alice,
			taskId,
			'Third',
			[],
			first.ok ? first.version : null
		);

		expect(second.ok).toBe(true);
		expect(tasks.listTasks(p.tripId, 'task').find((t) => t.id === taskId)?.label).toBe('Third');
	});

	it('does not let a refused save apply half of itself', () => {
		const p = party();
		const id = spend(p, 'Taxi', 60)!;
		const opened = expenses.listExpenses(p.tripId).find((e) => e.id === id)!.version;

		expenses.updateExpense(
			p.tripId,
			p.alice,
			id,
			p.alice,
			'Taxi',
			6000,
			'USD',
			[
				{ userId: p.alice, weight: 1 },
				{ userId: p.bob, weight: 1 }
			],
			'even',
			opened
		);
		// The row and its participants are rewritten together in one transaction.
		// A conflict must stop before either, or the amount and the people it is
		// divided between end up describing different edits.
		const refused = expenses.updateExpense(
			p.tripId,
			p.alice,
			id,
			p.alice,
			'Taxi',
			9900,
			'USD',
			[{ userId: p.cara, weight: 1 }],
			'even',
			opened
		);

		expect(refused).toEqual({ ok: false, reason: 'conflict' });
		const after = expenses.expenseShares(p.tripId).get(id)!;
		expect(after.totalCents).toBe(6000);
		expect(Object.keys(after.shares).sort()).toEqual([p.alice, p.bob].sort());
		expect(netsToZero(p.tripId)).toBe(0);
	});

	it('treats the same person ticking from both devices as one tick', () => {
		const p = party();
		const taskId = tasks.addTask(p.tripId, p.alice, 'task', 'Check in online', [], null)!;

		// Both devices send the state they want rather than "flip it", so the
		// second one is a no-op instead of undoing the first.
		expect(tasks.toggleTask(p.tripId, p.alice, taskId, undefined, true)).toEqual({
			ok: true,
			done: true
		});
		expect(tasks.toggleTask(p.tripId, p.alice, taskId, undefined, true)).toEqual({
			ok: true,
			done: true
		});
	});
});

/**
 * Two different members, both mid-edit.
 *
 * The cases that matter are not the ones where the app says no. They are the
 * ones where it says yes twice: two adds that should both survive, two votes
 * that should both count, and one payment that must not be recorded twice.
 */
describe('two members working at the same time', () => {
	it('keeps both expenses when two people add one at the same moment', () => {
		const p = party();
		const parts = p.all.map((u) => ({ userId: u, weight: 1 }));

		const a = expenses.addExpense(p.tripId, p.alice, p.alice, 'Museum', 3000, 'USD', parts, 'even');
		const b = expenses.addExpense(p.tripId, p.bob, p.bob, 'Ferry', 4500, 'USD', parts, 'even');

		expect(a).toBeTruthy();
		expect(b).toBeTruthy();
		// Adds have no version to conflict on, and must not: two people spending
		// money at once is the normal case, not a race to resolve.
		const rows = expenses.listExpenses(p.tripId);
		expect(rows).toHaveLength(2);
		const total = [...expenses.expenseShares(p.tripId).values()].reduce(
			(n, s) => n + s.totalCents,
			0
		);
		expect(total).toBe(7500);
		expect(netsToZero(p.tripId)).toBe(0);
	});

	it('refuses a save against a row the other person has just deleted', () => {
		const p = party();
		const id = spend(p, 'Cancelled tour', 80)!;
		const opened = expenses.listExpenses(p.tripId).find((e) => e.id === id)!.version;

		expect(expenses.deleteExpense(p.tripId, p.bob, id)).toBe(true);

		// Deleted is 'missing', not 'conflict': the caller needs to be told the row
		// is gone, not that they are behind on it. A 409 here would send them to
		// reload a row that no longer exists.
		const saved = expenses.updateExpense(
			p.tripId,
			p.alice,
			id,
			p.alice,
			'Cancelled tour',
			8000,
			'USD',
			p.all.map((u) => ({ userId: u, weight: 1 })),
			'even',
			opened
		);
		expect(saved).toEqual({ ok: false, reason: 'missing' });
		expect(expenses.listExpenses(p.tripId)).toHaveLength(0);
	});

	it('does not resurrect a deleted task as a new row when the other person saves', () => {
		const p = party();
		const taskId = tasks.addTask(p.tripId, p.alice, 'task', 'Book the ferry', [], null)!;
		const opened = tasks.listTasks(p.tripId, 'task').find((t) => t.id === taskId)!.version;

		tasks.removeTask(p.tripId, p.bob, taskId);

		expect(tasks.updateTask(p.tripId, p.alice, taskId, 'Renamed', [], opened)).toEqual({
			ok: false,
			reason: 'missing'
		});
		expect(tasks.listTasks(p.tripId, 'task')).toHaveLength(0);
	});

	it('stops accepting writes from a member the moment they are removed', () => {
		const p = party();
		const taskId = tasks.addTask(p.tripId, p.alice, 'task', 'Something', [], null)!;
		const opened = tasks.listTasks(p.tripId, 'task').find((t) => t.id === taskId)!.version;

		members.removeMember(p.tripId, p.alice, p.cara);

		// Membership is the authorization, so losing it has to take effect on the
		// next write and not at the next page load. Reported as missing rather than
		// as a refusal, for the same reason `requireMember` answers 404: telling
		// somebody a trip exists but is not theirs is itself information.
		expect(tasks.updateTask(p.tripId, p.cara, taskId, 'Sneaked in', [], opened)).toEqual({
			ok: false,
			reason: 'missing'
		});
		expect(
			expenses.addExpense(p.tripId, p.cara, p.cara, 'After leaving', 1000, 'USD', [
				{ userId: p.alice, weight: 1 }
			])
		).toBeNull();
	});

	it('counts both votes when two members vote on lodging at once', () => {
		const p = party();
		const cityId = trips.addCity(p.tripId, p.alice, {
			name: 'Athens',
			country: 'Greece',
			tz: 'Europe/Athens',
			lat: 37.98,
			lng: 23.73
		})!;
		const first = lodging.addOption(p.tripId, p.alice, cityId, 'Hotel A')!;
		const second = lodging.addOption(p.tripId, p.alice, cityId, 'Hotel B')!;

		expect(lodging.vote(p.tripId, p.alice, first)).toBe(true);
		expect(lodging.vote(p.tripId, p.bob, first)).toBe(true);
		expect(lodging.vote(p.tripId, p.cara, second)).toBe(true);

		const city = lodging.cityLodging(p.tripId, p.alice).find((c) => c.id === cityId)!;
		const tally = new Map(city.options.map((o) => [o.id, o.votes]));
		expect(tally.get(first)).toBe(2);
		expect(tally.get(second)).toBe(1);
	});

	it('moves a vote rather than adding a second one when somebody changes their mind', () => {
		const p = party();
		const cityId = trips.addCity(p.tripId, p.alice, {
			name: 'Split',
			country: 'Croatia',
			tz: 'Europe/Zagreb',
			lat: 43.51,
			lng: 16.44
		})!;
		const first = lodging.addOption(p.tripId, p.alice, cityId, 'Apartment')!;
		const second = lodging.addOption(p.tripId, p.alice, cityId, 'Guesthouse')!;

		lodging.vote(p.tripId, p.alice, first);
		lodging.vote(p.tripId, p.alice, second);

		// One vote per person per city, so switching must not leave the old one
		// behind and inflate the tally.
		const city = lodging.cityLodging(p.tripId, p.alice).find((c) => c.id === cityId)!;
		expect(city.options.reduce((n, o) => n + o.votes, 0)).toBe(1);
		expect(city.options.find((o) => o.id === second)?.votes).toBe(1);
	});

	it('keeps the ledger whole when the home currency changes under a foreign expense', () => {
		const p = party();
		const parts = p.all.map((u) => ({ userId: u, weight: 1 }));
		const id = expenses.addExpense(p.tripId, p.alice, p.alice, 'Taverna', 6000, 'EUR', parts, 'even')!;
		const before = expenses.expenseShares(p.tripId).get(id)!.totalCents;

		trips.updateTrip(p.tripId, p.alice, {
			name: 'Concurrency Trip',
			startDate: '2026-10-01',
			endDate: '2026-10-05',
			currency: 'EUR'
		});

		// The rate stored on the expense targets the old home currency, so it is no
		// longer trusted and the reader converts live. What must not change is that
		// the shares still add up to the expense and the balances still net out:
		// a currency switch may revalue the trip, it may never unbalance it.
		const after = expenses.expenseShares(p.tripId).get(id)!;
		expect(Object.values(after.shares).reduce((a, c) => a + c, 0)).toBe(after.totalCents);
		expect(after.totalCents).not.toBe(0);
		expect(before).not.toBe(0);
		expect(netsToZero(p.tripId)).toBe(0);
		// EUR is now home, so the expense is worth its face value.
		expect(after.totalCents).toBe(6000);
	});

	it('keeps a settlement idempotent even when two people answer the same suggestion', () => {
		const p = party();
		expenses.addExpense(p.tripId, p.alice, p.alice, 'Villa', 30000, 'USD', [
			{ userId: p.bob, weight: 1 }
		]);

		const suggested = expenses.settlement(p.tripId)[0]!;
		const byBob = expenses.recordSettlement(
			p.tripId,
			p.bob,
			suggested.fromId,
			suggested.toId,
			suggested.amountCents,
			suggested.token
		);
		// Alice is looking at the same screen, so she derives the same token from
		// the same ledger. Her press must resolve to Bob's row.
		const byAlice = expenses.recordSettlement(
			p.tripId,
			p.alice,
			suggested.fromId,
			suggested.toId,
			suggested.amountCents,
			suggested.token
		);

		expect(byBob?.duplicate).toBe(false);
		expect(byAlice).toEqual({ id: byBob!.id, duplicate: true });
		// Asserted on the row count, not just the balances: two payments would move
		// the balance past zero and start suggesting the money be paid back, which
		// a balance check alone can read as success.
		expect(expenses.listExpenses(p.tripId).filter((e) => e.settlement === 1)).toHaveLength(1);
		expect(netsToZero(p.tripId)).toBe(0);
	});
});

/**
 * Where the app currently has no protection, written down honestly.
 *
 * `pois`, `lodging_options` and `cost_items` carry no version column, so two
 * people editing one of them is last-write-wins and the loser is never told.
 * These are not assertions that the behaviour is right. They exist so the gap
 * is visible in the suite rather than discovered by a member whose note
 * vanished, and so that adding versioning later fails loudly here first.
 */
describe('rows with no conflict detection yet', () => {
	it('lets the second edit of a place overwrite the first silently', () => {
		const p = party();
		const cityId = trips.addCity(p.tripId, p.alice, {
			name: 'Naxos',
			country: 'Greece',
			tz: 'Europe/Athens',
			lat: 37.1,
			lng: 25.38
		})!;
		const poiId = pois.addPoi(p.tripId, p.alice, cityId, 'Portara', 'attraction', null, null, null, null)!;

		const byAlice = pois.updatePoi(p.tripId, p.alice, poiId, {
			name: 'Portara',
			notes: 'Go at sunset',
			url: null
		});
		const byBob = pois.updatePoi(p.tripId, p.bob, poiId, {
			name: 'Portara',
			notes: 'Go early, it gets busy',
			url: null
		});

		expect(byAlice).toBe(true);
		// No version is carried, so there is nothing to compare and nothing to
		// refuse. Alice's note is gone and she was told her edit saved.
		expect(byBob).toBe(true);
		const city = pois.cityPois(p.tripId, p.alice).find((c) => c.id === cityId)!;
		expect(city.pois.find((x) => x.id === poiId)?.notes).toBe('Go early, it gets busy');
	});

	it('lets the second edit of a lodging option overwrite the first silently', () => {
		const p = party();
		const cityId = trips.addCity(p.tripId, p.alice, {
			name: 'Paros',
			country: 'Greece',
			tz: 'Europe/Athens',
			lat: 37.08,
			lng: 25.15
		})!;
		const optionId = lodging.addOption(p.tripId, p.alice, cityId, 'Sea View Rooms')!;
		const base = {
			name: 'Sea View Rooms',
			priceCents: null,
			currency: 'EUR',
			url: null,
			checkIn: null,
			checkOut: null
		};

		lodging.updateOption(p.tripId, p.alice, optionId, { ...base, tag: 'quiet' });
		lodging.updateOption(p.tripId, p.bob, optionId, { ...base, tag: 'central' });

		expect(lodging.lodgingOptionById(p.tripId, optionId)?.tag).toBe('central');
	});
});


/**
 * How many ways an expense was split, as the row label reports it.
 *
 * A person can be named on a shares or exact split and enter nothing: they are
 * stored at weight 0 and charged nothing, which is deliberate. Counting them
 * anyway made a bill that had plainly been halved describe itself as "3 ways".
 */
describe('the split count a row reports', () => {
	it('counts only the people actually charged', () => {
		const p = party();
		const id = expenses.addExpense(
			p.tripId,
			p.alice,
			p.alice,
			'Dinner',
			6000,
			'USD',
			[
				{ userId: p.alice, weight: 1 },
				{ userId: p.bob, weight: 1 },
				{ userId: p.cara, weight: 0 }
			],
			'shares'
		)!;
		expect(expenses.listExpenses(p.tripId).find((e) => e.id === id)!.participants).toBe(2);

		// And the label is not lying about the money: Cara is charged nothing, so
		// she has no balance to appear in at all.
		const owed = expenses.balances(p.tripId).find((b) => b.userId === p.cara);
		expect(owed?.netCents ?? 0).toBe(0);
	});

	it('falls back to everyone named when every stake is zero, as the split does', () => {
		const p = party();
		const id = expenses.addExpense(
			p.tripId,
			p.alice,
			p.alice,
			'Taxi',
			3000,
			'USD',
			p.all.map((userId) => ({ userId, weight: 0 })),
			'shares'
		)!;
		expect(expenses.listExpenses(p.tripId).find((e) => e.id === id)!.participants).toBe(3);
	});
});
