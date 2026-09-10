import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db';
import { settle, type Balance, type Transaction } from '@trippy/core/settlement';
import { splitByWeight, type SplitMode } from '@trippy/core/split';
import { convertCents } from '../providers/fx';
import { publish } from '../events';
import { conflict, isStale, missing, written, type WriteResult } from './versioning';

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
	settlement: number; // 1 when this row records a transfer, not a shared cost
	created_at: number;
	/** Bumped by every edit. Send it back with a PUT to detect a lost update. */
	version: number;
	/**
	 * Set when this expense still refers to somebody who has left the trip, so
	 * the ledger cannot balance until a person decides what to do with it. See
	 * `settleRemovedMember`.
	 */
	needsReview: boolean;
}

/** One participant's stake in an expense. `weight` means shares or cents depending on the mode. */
export interface SplitPart {
	userId: string;
	weight: number;
}

/** One expense's home-currency division: who paid it and what each person owes on it. */
export interface ExpenseSplit {
	payerId: string;
	/** The whole expense in home-currency minor units. */
	totalCents: number;
	/** Home-currency minor units per participant, summing to `totalCents`. */
	shares: Record<string, number>;
	/** The stored stakes, as typed: what an edit form has to prefill from. */
	parts: SplitPart[];
}

export interface BalanceRow {
	id: string;
	name: string;
	/** Home-currency minor units, paid - owed. The exact figure; nets to zero. */
	netCents: number;
	/**
	 * The same balance in home-currency major units, kept for the existing API
	 * and UI contract. Derived from `netCents`, never accumulated, so it cannot
	 * drift; new consumers should read `netCents`.
	 */
	net: number;
	/**
	 * True when this person has left the trip but still has money tied up in it.
	 *
	 * They are listed anyway, because the alternative is worse: dropping them
	 * drops their share out of the sum, the balances stop netting to zero, and
	 * settle-up can never reach a cleared state. A row nobody can explain is a
	 * better failure than a total that is quietly wrong.
	 */
	former: boolean;
}

export interface SettlementRow {
	fromId: string;
	toId: string;
	from: string; // name
	to: string; // name
	/** Transfer amount in home-currency minor units. Always positive. */
	amountCents: number;
	/** The same amount in major units, for the existing API and UI contract. */
	amount: number;
	/**
	 * Identifies this suggestion. Send it back when recording the payment and
	 * the write becomes idempotent: see `recordSettlement`.
	 */
	token: string;
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
	const rows = db
		.prepare(
			`SELECT e.id, e.description, e.amount_cents, e.currency, e.payer_id, e.split_mode,
			        u.name AS payer_name, e.created_at, COALESCE(e.settlement, 0) AS settlement,
			        e.version,
			        (SELECT COUNT(*) FROM expense_participants p WHERE p.expense_id = e.id) AS participants,
			        -- Anyone this row names who is no longer on the trip. Derived rather
			        -- than stored: a flag written at removal time would go stale the
			        -- moment somebody edits the expense or the person is re-invited.
			        (e.payer_id NOT IN (SELECT user_id FROM memberships WHERE trip_id = e.trip_id)
			         OR EXISTS (SELECT 1 FROM expense_participants p
			                     WHERE p.expense_id = e.id
			                       AND p.user_id NOT IN (SELECT user_id FROM memberships WHERE trip_id = e.trip_id))
			        ) AS needs_review
			 FROM expenses e JOIN users u ON u.id = e.payer_id
			 WHERE e.trip_id = ? ORDER BY e.created_at DESC`
		)
		.all(tripId) as unknown as (Omit<ExpenseRow, 'needsReview'> & { needs_review: number })[];
	return rows.map(({ needs_review, ...r }) => ({ ...r, needsReview: !!needs_review }));
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
		// Zero is a legitimate stake of nothing: in `shares` a selected person who
		// entered no shares, in `exact` one who entered 0.00. Persist it as 0 so the
		// ledger matches the `splitByWeight` preview the dialog shows. Only genuinely
		// unusable input (NaN, Infinity, negative) is normalized, and it normalizes to
		// 0 as well, never to a silent 1 that would charge someone who owes nothing.
		// `even` needs no fallback here: its weights are always 1 by construction.
		insertPart.run(id, p.userId, Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 0);
	}
	publish(tripId, 'expenses');
	return id;
}

/**
 * Rewrite one expense: its description, amount, currency, payer and division.
 *
 * Any member may edit any expense, the same rule deletion already follows: a
 * shared ledger is corrected by whoever spots the mistake, and every change is
 * visible to everyone on the same screen.
 *
 * A settlement is refused. It is not a cost anybody divided but a record that
 * money moved between two people, and the dialog that would edit it has no
 * concept of that; it is deleted and re-recorded instead.
 *
 * The row and its participants are replaced together in one transaction, so no
 * reader can catch an amount that has been updated while the stakes it is
 * divided between still belong to the old one.
 *
 * `expectedVersion` is the version the editor had on screen. Money is the worst
 * place for a silent last-write-wins: one member correcting a total while
 * another adds a sharer used to end with the correction gone and both of them
 * told it had saved. A stale version is refused instead.
 */
export function updateExpense(
	tripId: string,
	actorId: string,
	expenseId: string,
	payerId: string,
	description: string,
	amountCents: number,
	currency: string,
	parts: SplitPart[],
	splitMode: SplitMode = 'even',
	expectedVersion?: number | null
): WriteResult {
	if (!isMember(tripId, actorId)) return missing;
	if (!isMember(tripId, payerId)) return missing;

	const existing = db
		.prepare(
			`SELECT COALESCE(settlement, 0) AS settlement, version FROM expenses WHERE id = ? AND trip_id = ?`
		)
		.get(expenseId, tripId) as { settlement: number; version: number } | undefined;
	if (!existing || existing.settlement === 1) return missing;
	if (isStale(expectedVersion, existing.version)) return conflict;

	const seen = new Set<string>();
	const clean = parts.filter((p) => {
		if (seen.has(p.userId) || !isMember(tripId, p.userId)) return false;
		seen.add(p.userId);
		return true;
	});
	if (clean.length === 0 || !Number.isFinite(amountCents) || amountCents === 0) return missing;

	const next = existing.version + 1;
	db.exec('BEGIN');
	try {
		db.prepare(
			`UPDATE expenses SET payer_id = ?, description = ?, amount_cents = ?, currency = ?, split_mode = ?, version = ?
			 WHERE id = ? AND trip_id = ?`
		).run(payerId, description, amountCents, currency, splitMode, next, expenseId, tripId);
		db.prepare(`DELETE FROM expense_participants WHERE expense_id = ?`).run(expenseId);
		const insertPart = db.prepare(
			`INSERT INTO expense_participants (expense_id, user_id, weight) VALUES (?, ?, ?)`
		);
		for (const p of clean) {
			insertPart.run(expenseId, p.userId, Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 0);
		}
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}

	publish(tripId, 'expenses'); // after COMMIT
	return written(next);
}

/**
 * Detach a departing member from the ledger, as far as that can be done safely.
 *
 * Removing somebody who has money in the trip is not a bookkeeping detail: it
 * decides who ends up paying their share. The rule differs by split mode
 * because only some modes carry enough information to answer that.
 *
 *  - `even` and `shares` are *proportional*: what each person owes is derived
 *    from the weights of whoever is on the expense. Dropping the leaver's row
 *    re-divides the same total across the people who remain, which is what
 *    "they left, we cover it" means, and the arithmetic stays exact because
 *    `splitByWeight` re-runs over the survivors.
 *  - `exact` is *stated*: each person owes a number a human typed. There is no
 *    honest way to reassign 40.00 of a 100.00 dinner without someone deciding
 *    who eats it, so the expense is left alone and reported as needing review.
 *    Guessing here would silently move real money between real people.
 *
 * An expense the leaver *paid* is untouched whatever its mode: the debt is owed
 * to them, and only the group can decide whether to pay it or write it off.
 *
 * Removing the last participant would leave an expense divided between nobody,
 * so that one is left for review too rather than being quietly orphaned.
 *
 * Returns how many rows were re-divided and how many still need a person to
 * look at them.
 */
export function detachMemberFromLedger(
	tripId: string,
	userId: string
): { redistributed: number; needsReview: number } {
	const rows = db
		.prepare(
			`SELECT e.id, e.split_mode, e.payer_id,
			        (SELECT COUNT(*) FROM expense_participants p WHERE p.expense_id = e.id) AS participants
			   FROM expenses e
			   JOIN expense_participants ep ON ep.expense_id = e.id AND ep.user_id = ?
			  WHERE e.trip_id = ?`
		)
		.all(userId, tripId) as unknown as {
		id: string;
		split_mode: SplitMode;
		payer_id: string;
		participants: number;
	}[];

	const paid = db
		.prepare(`SELECT COUNT(*) AS n FROM expenses WHERE trip_id = ? AND payer_id = ?`)
		.get(tripId, userId) as { n: number } | undefined;

	let redistributed = 0;
	let needsReview = paid?.n ?? 0;

	const drop = db.prepare(`DELETE FROM expense_participants WHERE expense_id = ? AND user_id = ?`);
	const bump = db.prepare(`UPDATE expenses SET version = version + 1 WHERE id = ?`);

	db.exec('BEGIN');
	try {
		for (const e of rows) {
			const proportional = e.split_mode === 'even' || e.split_mode === 'shares';
			if (!proportional || e.payer_id === userId || e.participants <= 1) {
				needsReview++;
				continue;
			}
			drop.run(e.id, userId);
			bump.run(e.id);
			redistributed++;
		}
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}

	return { redistributed, needsReview };
}

export function deleteExpense(tripId: string, actorId: string, expenseId: string): boolean {
	if (!isMember(tripId, actorId)) return false;
	const res = db
		.prepare(`DELETE FROM expenses WHERE id = ? AND trip_id = ?`)
		.run(expenseId, tripId);
	if (res.changes > 0) publish(tripId, 'expenses');
	return res.changes > 0;
}

/**
 * What each expense charges each of its participants, in home-currency cents.
 *
 * Convert first, then split. Splitting the converted total keeps the shares
 * summing to it exactly, so every balance set nets to zero. Everything stays in
 * whole cents: no division into major units happens on the way. `balances` and
 * the ledger's per-person view both read from here, so what a row says a member
 * owes and what their balance is built from can never be two different numbers.
 */
export function expenseShares(tripId: string): Map<string, ExpenseSplit> {
	const home =
		(
			db.prepare(`SELECT home_currency FROM trips WHERE id = ?`).get(tripId) as
				{ home_currency: string } | undefined
		)?.home_currency ?? 'USD';

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

	const out = new Map<string, ExpenseSplit>();
	for (const e of rows) {
		const parts = partsOf.all(e.id) as unknown as { user_id: string; weight: number }[];
		if (parts.length === 0) continue;

		const totalCents = convertCents(e.amount_cents, e.currency ?? home, home);
		const cents = splitByWeight(
			totalCents,
			parts.map((p) => p.weight ?? 1)
		);

		const shares: Record<string, number> = {};
		parts.forEach((p, i) => {
			shares[p.user_id] = cents[i];
		});
		out.set(e.id, {
			payerId: e.payer_id,
			totalCents,
			shares,
			parts: parts.map((p) => ({ userId: p.user_id, weight: p.weight ?? 1 }))
		});
	}
	return out;
}

/**
 * Net balance per member, in home-currency cents (positive = is owed money).
 *
 * Includes anyone who has left the trip but still appears in its ledger. Their
 * share is real money that someone else fronted or is owed, and leaving it out
 * of the sum was what let the totals stop netting to zero: the group would see
 * a settle-up screen that could never be cleared, with no indication why. They
 * are marked `former` so the UI can say what they are rather than showing a
 * stranger.
 */
export function balances(tripId: string): BalanceRow[] {
	const members = tripMembers(tripId);
	const net = new Map<string, number>(members.map((m) => [m.id, 0]));
	const current = new Set(members.map((m) => m.id));

	for (const split of expenseShares(tripId).values()) {
		net.set(split.payerId, (net.get(split.payerId) ?? 0) + split.totalCents);
		for (const [userId, cents] of Object.entries(split.shares)) {
			net.set(userId, (net.get(userId) ?? 0) - cents);
		}
	}

	const strays = [...net.keys()].filter((id) => !current.has(id) && net.get(id) !== 0);
	const strayNames = new Map<string, string>();
	if (strays.length) {
		const rows = db
			.prepare(`SELECT id, name FROM users WHERE id IN (${strays.map(() => '?').join(',')})`)
			.all(...strays) as unknown as { id: string; name: string }[];
		for (const r of rows) strayNames.set(r.id, r.name);
	}

	const rows: BalanceRow[] = members.map((m) => {
		const netCents = net.get(m.id) ?? 0;
		return { id: m.id, name: m.name, netCents, net: netCents / 100, former: false };
	});
	for (const id of strays) {
		const netCents = net.get(id) ?? 0;
		rows.push({
			id,
			name: strayNames.get(id) ?? 'Former member',
			netCents,
			net: netCents / 100,
			former: true
		});
	}
	return rows;
}

/**
 * Names one suggested transfer, and the ledger it was suggested from.
 *
 * The balances are part of the input on purpose. Two members looking at the
 * same settle-up screen derive the same token, so their two presses of the same
 * button collapse into one payment. Once that payment lands the balances move,
 * so a genuine second transfer of the same amount between the same pair is
 * quoted against a different ledger, gets a different token, and is recorded
 * normally. A key that covered only (from, to, amount) could not tell those two
 * cases apart and would swallow the real one.
 */
function settlementToken(
	tripId: string,
	ledger: readonly BalanceRow[],
	fromId: string,
	toId: string,
	amountCents: number
): string {
	const state = [...ledger]
		.map((b) => `${b.id}:${b.netCents}`)
		.sort()
		.join('|');
	return createHash('sha256')
		.update(`${tripId}\n${state}\n${fromId}>${toId}:${amountCents}`)
		.digest('hex')
		.slice(0, 32);
}

/** Minimal transfers to clear all balances, with names resolved for display. */
export function settlement(tripId: string): SettlementRow[] {
	const bals = balances(tripId);
	const nameById = new Map(bals.map((b) => [b.id, b.name]));
	const input: Balance[] = bals.map((b) => ({ userId: b.id, netCents: b.netCents }));
	return settle(input).map((t: Transaction) => ({
		fromId: t.from,
		toId: t.to,
		from: nameById.get(t.from) ?? t.from,
		to: nameById.get(t.to) ?? t.to,
		amountCents: t.amountCents,
		amount: t.amountCents / 100,
		token: settlementToken(tripId, bals, t.from, t.to, t.amountCents)
	}));
}

/**
 * Records a transfer that actually happened, as an ordinary expense.
 *
 * A settlement is exactly an expense the payer covered on one other person's
 * behalf: `from` paid `amount`, `to` is the only participant, so `from` is
 * credited and `to` is charged and the pair's balances move to zero. Writing it
 * as an expense rather than as a second kind of record means balances,
 * settlement, currency conversion and deletion all keep working with no special
 * case, and undoing a payment is just deleting the row.
 *
 * The amount is always in the trip's home currency, because that is the
 * currency the suggested transfers are computed and displayed in.
 *
 * `token` is the one from the suggestion being answered, and makes the call
 * idempotent. Recording a payment used to be an unconditional insert, so a
 * second press of "Mark paid", which is exactly what someone does when the
 * first press looks like it did nothing, wrote the transfer twice and inverted
 * the debt it was meant to clear: the app then cheerfully suggested paying the
 * money back. With a token, the repeat resolves to the row that already exists
 * and reports itself as a duplicate rather than writing anything.
 *
 * Returns the expense id and whether it already existed, or null if either side
 * is not a member, they are the same person, or the amount is not positive.
 */
export function recordSettlement(
	tripId: string,
	actorId: string,
	fromId: string,
	toId: string,
	amountCents: number,
	token?: string | null
): { id: string; duplicate: boolean } | null {
	if (fromId === toId) return null;
	if (!isMember(tripId, fromId) || !isMember(tripId, toId)) return null;
	if (!Number.isFinite(amountCents) || amountCents <= 0) return null;

	if (token) {
		const existing = db
			.prepare(`SELECT id FROM expenses WHERE trip_id = ? AND settle_token = ?`)
			.get(tripId, token) as { id: string } | undefined;
		if (existing) return { id: existing.id, duplicate: true };
	}

	const home =
		(
			db.prepare(`SELECT home_currency FROM trips WHERE id = ?`).get(tripId) as
				{ home_currency: string } | undefined
		)?.home_currency ?? 'USD';
	const names = new Map(tripMembers(tripId).map((m) => [m.id, m.name]));

	const id = addExpense(
		tripId,
		actorId,
		fromId,
		`Payment from ${names.get(fromId)} to ${names.get(toId)}`,
		amountCents,
		home,
		[{ userId: toId, weight: amountCents }],
		'exact'
	);
	if (!id) return null;
	// `addExpense` has already published, but that event describes the row before
	// this flag was set, so a client that refetched instantly would label it a
	// plain expense forever. A second invalidation after the update settles it.
	try {
		db.prepare(`UPDATE expenses SET settlement = 1, settle_token = ? WHERE id = ?`).run(
			token ?? null,
			id
		);
	} catch {
		// The unique index caught a duplicate this function's own lookup did not.
		// That needs an await to appear between the two, which there is not today,
		// so this is a guard against a future refactor rather than a live path.
		// Either way the honest answer is the row that won, not a 500.
		db.prepare(`DELETE FROM expenses WHERE id = ?`).run(id);
		const winner = db
			.prepare(`SELECT id FROM expenses WHERE trip_id = ? AND settle_token = ?`)
			.get(tripId, token ?? null) as { id: string } | undefined;
		publish(tripId, 'expenses');
		return winner ? { id: winner.id, duplicate: true } : null;
	}
	publish(tripId, 'expenses');
	return { id, duplicate: false };
}
