import { randomUUID } from 'node:crypto';
import { db } from './db';
import { settle, type Balance, type Transaction } from '@trippy/core/settlement';
import { splitByWeight, type SplitMode } from '@trippy/core/split';
import { convertCents } from './fx';

export interface Member {
	id: string;
	name: string;
	role: string;
}

export interface ExpenseRow {
	id: string;
	description: string;
	amount_cents: number;
	currency: string;
	payer_id: string;
	payer_name: string;
	split_mode: SplitMode;
	participants: number;
	created_at: number;
}

/** One participant's stake in an expense. `weight` means shares or cents depending on the mode. */
export interface SplitPart {
	userId: string;
	weight: number;
}

export interface BalanceRow {
	id: string;
	name: string;
	net: number; // home-currency units, paid - owed
}

export interface SettlementRow {
	from: string; // name
	to: string; // name
	amount: number;
}

function isMember(tripId: string, userId: string): boolean {
	return !!db
		.prepare(`SELECT 1 FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.get(tripId, userId);
}

export function tripMembers(tripId: string): Member[] {
	return db
		.prepare(
			`SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
			 WHERE m.trip_id = ? ORDER BY m.role DESC, u.name`
		)
		.all(tripId) as unknown as Member[];
}

export function listExpenses(tripId: string): ExpenseRow[] {
	return db
		.prepare(
			`SELECT e.id, e.description, e.amount_cents, e.currency, e.payer_id, e.split_mode,
			        u.name AS payer_name, e.created_at,
			        (SELECT COUNT(*) FROM expense_participants p WHERE p.expense_id = e.id) AS participants
			 FROM expenses e JOIN users u ON u.id = e.payer_id
			 WHERE e.trip_id = ? ORDER BY e.created_at DESC`
		)
		.all(tripId) as unknown as ExpenseRow[];
}

/**
 * Add an expense and divide it between the given participants.
 *
 * `parts` carries a weight per person whose meaning depends on `splitMode`
 * (see `@trippy/core/split`): 1 each for `even`, a share count for `shares`, or the
 * stated amount in cents for `exact`. Storing all three as weights means the
 * division is always proportional, so it stays exact after the expense is
 * converted into the trip's home currency for balances.
 *
 * `amountCents` may be negative: that records income (a refund, a deposit
 * returned, someone paying the group back) and credits the participants
 * instead of charging them.
 *
 * Returns the new expense id, or null if the actor, payer, or every
 * participant is not a member, or the amount is zero.
 */
export function addExpense(
	tripId: string,
	actorId: string,
	payerId: string,
	description: string,
	amountCents: number,
	currency: string,
	parts: SplitPart[],
	splitMode: SplitMode = 'even'
): string | null {
	if (!isMember(tripId, actorId)) return null;
	if (!isMember(tripId, payerId)) return null;

	const seen = new Set<string>();
	const clean = parts.filter((p) => {
		if (seen.has(p.userId) || !isMember(tripId, p.userId)) return false;
		seen.add(p.userId);
		return true;
	});
	if (clean.length === 0 || !Number.isFinite(amountCents) || amountCents === 0) return null;

	const id = randomUUID();
	db.prepare(
		`INSERT INTO expenses (id, trip_id, payer_id, description, amount_cents, currency, split_mode, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	).run(id, tripId, payerId, description, amountCents, currency, splitMode, Date.now());
	const insertPart = db.prepare(
		`INSERT INTO expense_participants (expense_id, user_id, weight) VALUES (?, ?, ?)`
	);
	for (const p of clean) {
		insertPart.run(id, p.userId, Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1);
	}
	return id;
}

export function deleteExpense(tripId: string, actorId: string, expenseId: string): boolean {
	if (!isMember(tripId, actorId)) return false;
	const res = db
		.prepare(`DELETE FROM expenses WHERE id = ? AND trip_id = ?`)
		.run(expenseId, tripId);
	return res.changes > 0;
}

/** Net balance per member in home-currency units (positive = is owed money). */
export function balances(tripId: string): BalanceRow[] {
	const members = tripMembers(tripId);
	const net = new Map<string, number>(members.map((m) => [m.id, 0]));

	const home =
		(db.prepare(`SELECT home_currency FROM trips WHERE id = ?`).get(tripId) as
			| { home_currency: string }
			| undefined)?.home_currency ?? 'USD';

	const rows = db
		.prepare(
			`SELECT e.id, e.payer_id, e.amount_cents, e.currency FROM expenses e WHERE e.trip_id = ?`
		)
		.all(tripId) as unknown as {
		id: string;
		payer_id: string;
		amount_cents: number;
		currency: string;
	}[];

	const partsOf = db.prepare(
		`SELECT user_id, weight FROM expense_participants WHERE expense_id = ? ORDER BY user_id`
	);

	for (const e of rows) {
		const parts = partsOf.all(e.id) as unknown as { user_id: string; weight: number }[];
		if (parts.length === 0) continue;

		// Convert first, then split. Splitting the converted total keeps the
		// shares summing to it exactly, so every balance set nets to zero.
		const totalCents = convertCents(e.amount_cents, e.currency ?? home, home);
		const shares = splitByWeight(
			totalCents,
			parts.map((p) => p.weight ?? 1)
		);

		net.set(e.payer_id, (net.get(e.payer_id) ?? 0) + totalCents / 100);
		parts.forEach((p, i) => {
			net.set(p.user_id, (net.get(p.user_id) ?? 0) - shares[i] / 100);
		});
	}

	return members.map((m) => ({
		id: m.id,
		name: m.name,
		net: Math.round((net.get(m.id) ?? 0) * 100) / 100
	}));
}

/** Minimal transfers to clear all balances, with names resolved for display. */
export function settlement(tripId: string): SettlementRow[] {
	const bals = balances(tripId);
	const nameById = new Map(bals.map((b) => [b.id, b.name]));
	const input: Balance[] = bals.map((b) => ({ userId: b.id, net: b.net }));
	return settle(input).map((t: Transaction) => ({
		from: nameById.get(t.from) ?? t.from,
		to: nameById.get(t.to) ?? t.to,
		amount: t.amount
	}));
}
