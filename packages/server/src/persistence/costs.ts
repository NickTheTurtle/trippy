import { randomUUID } from 'node:crypto';
import { isCurrencyCode } from '@trippy/core/currency';
import { isNameLength } from '@trippy/core/validate';
import { db } from '../db';
import { publish } from '../events';
import { convertCents } from '../providers/fx';
import { homeCurrency, isMember } from './membership';

/** The trip's home currency, which an estimate with no currency of its own is in. */

/**
 * Stored as typed or not at all: blank stays blank, and blank means home.
 *
 * Null for a code nothing can convert. Every read of the budget converts every
 * item, so one row in an unknown currency made `perUsd` throw and took the
 * Preparation page down for the whole trip. The writers refuse on null.
 */
function cleanCurrency(currency: string | undefined): string | null {
	const code = (currency ?? '').trim().toUpperCase();
	if (!code) return '';
	return isCurrencyCode(code) ? code : null;
}

export const COST_CATEGORIES = ['lodging', 'activities', 'food', 'travel'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

// ---- Itemized cost breakdown -------------------------------------------------

export interface CostPerson {
	id: string;
	name: string;
}

/**
 * One line of the estimate.
 *
 * `people` is who the line is for. Empty means the whole trip: an estimate is
 * usually written before anyone has worked out who is doing what, and a line
 * that had to name someone would make the common case the laborious one.
 *
 * There is no city. An estimate is a guess at a number, and pinning each guess
 * to a city asked for a decision that changed nothing on the screen.
 */
export interface CostItem {
	id: string;
	category: string;
	label: string;
	amountCents: number;
	/**
	 * The currency `amountCents` is in. Empty means the trip's home currency,
	 * which is what every estimate written before currencies were askable is in.
	 */
	currency: string;
	sort: number;
	people: CostPerson[];
}

export interface ItemizedBudget {
	items: BudgetLine[];
	/** Home-currency minor units. */
	grandTotal: number;
}

/** A cost item with its home-currency equivalent worked out. */
export interface BudgetLine extends CostItem {
	/** `amountCents` converted into the trip's home currency. */
	homeCents: number;
}

export function listCostItems(tripId: string): CostItem[] {
	const rows = db
		.prepare(
			`SELECT id, category, label, amount_cents, currency, sort FROM cost_items
			 WHERE trip_id = ? ORDER BY sort, created_at`
		)
		.all(tripId) as unknown as {
		id: string;
		category: string;
		label: string;
		amount_cents: number;
		currency: string;
		sort: number;
	}[];
	if (rows.length === 0) return [];

	// Joining memberships, not just users, keeps a removed member off the line:
	// the row itself outlives the removal (the user row is still there), but the
	// person is no longer one of the heads the amount divides between.
	const people = db
		.prepare(
			`SELECT p.item_id AS item_id, u.id AS id, u.name AS name
			   FROM cost_item_people p
			   JOIN cost_items ci ON ci.id = p.item_id
			   JOIN users u ON u.id = p.user_id
			   JOIN memberships m ON m.trip_id = ci.trip_id AND m.user_id = p.user_id
			  WHERE ci.trip_id = ?
			  ORDER BY u.name`
		)
		.all(tripId) as unknown as { item_id: string; id: string; name: string }[];

	const byItem = new Map<string, CostPerson[]>();
	for (const p of people) {
		const list = byItem.get(p.item_id) ?? [];
		list.push({ id: p.id, name: p.name });
		byItem.set(p.item_id, list);
	}

	return rows.map((r) => ({
		id: r.id,
		category: r.category,
		label: r.label,
		amountCents: r.amount_cents,
		currency: r.currency ?? '',
		sort: r.sort,
		people: byItem.get(r.id) ?? []
	}));
}

/**
 * The itemized budget, with every line converted to the trip's home currency.
 *
 * `grandTotal` is in home currency, because adding a yen line to a euro line
 * any other way produces a number that means nothing. Each item keeps
 * `amountCents` as it was typed so the edit form can round-trip it, and gains
 * `homeCents` for the arithmetic. Same shape the expense ledger uses.
 */
export function getItemizedBudget(tripId: string): ItemizedBudget {
	const home = homeCurrency(tripId);
	const items = listCostItems(tripId).map((it) => ({
		...it,
		homeCents: convertCents(it.amountCents, it.currency || home, home)
	}));
	let grandTotal = 0;
	for (const it of items) grandTotal += it.homeCents;
	return { items, grandTotal };
}

function validItem(
	label: string,
	category: string,
	cents: number
): { label: string; category: string; cents: number } | null {
	const l = label.trim();
	// The same ceiling as every other name, rather than a private 120: the route
	// now refuses an over-long label with the shared message, and a store that
	// refused a shorter one would answer that with "Could not add that item."
	if (!l || !isNameLength(l)) return null;
	if (!(COST_CATEGORIES as readonly string[]).includes(category)) return null;
	if (!Number.isFinite(cents) || cents < 0) return null;
	return { label: l, category, cents: Math.round(cents) };
}

export interface CostItemInput {
	category: string;
	label: string;
	cents: number;
	/** Blank means the trip's home currency. Normalized to upper case. */
	currency?: string;
	assignees: string[];
}

/** Who on this trip the given ids actually are, in one query. */
function validMembers(tripId: string, userIds: string[]): string[] {
	if (userIds.length === 0) return [];
	const unique = [...new Set(userIds)];
	const rows = db
		.prepare(
			`SELECT user_id FROM memberships
			  WHERE trip_id = ? AND user_id IN (${unique.map(() => '?').join(',')})`
		)
		.all(tripId, ...unique) as unknown as { user_id: string }[];
	return rows.map((r) => r.user_id);
}

/** Rewrites an item's roster, inside whatever transaction the caller opened. */
function setPeople(itemId: string, userIds: string[]): void {
	const holes = userIds.map(() => '?').join(',');
	db.prepare(
		`DELETE FROM cost_item_people WHERE item_id = ?${userIds.length ? ` AND user_id NOT IN (${holes})` : ''}`
	).run(itemId, ...userIds);
	const ins = db.prepare(`INSERT OR IGNORE INTO cost_item_people (item_id, user_id) VALUES (?, ?)`);
	for (const uid of userIds) ins.run(itemId, uid);
}

export function addCostItem(tripId: string, actorId: string, input: CostItemInput): boolean {
	if (!isMember(tripId, actorId)) return false;
	const ok = validItem(input.label, input.category, input.cents);
	if (!ok) return false;
	const currency = cleanCurrency(input.currency);
	if (currency === null) return false;
	const people = validMembers(tripId, input.assignees);
	const id = randomUUID();
	const next = db
		.prepare(`SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM cost_items WHERE trip_id = ?`)
		.get(tripId) as { n: number };

	db.exec('BEGIN');
	try {
		db.prepare(
			`INSERT INTO cost_items (id, trip_id, category, label, amount_cents, currency, sort, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			id,
			tripId,
			ok.category,
			ok.label,
			ok.cents,
			currency,
			next.n,
			Date.now()
		);
		setPeople(id, people);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	publish(tripId, 'costs'); // after COMMIT
	return true;
}

export function updateCostItem(
	tripId: string,
	actorId: string,
	itemId: string,
	input: CostItemInput
): boolean {
	if (!isMember(tripId, actorId)) return false;
	const ok = validItem(input.label, input.category, input.cents);
	if (!ok) return false;
	const currency = cleanCurrency(input.currency);
	if (currency === null) return false;
	const exists = !!db
		.prepare(`SELECT 1 FROM cost_items WHERE id = ? AND trip_id = ?`)
		.get(itemId, tripId);
	if (!exists) return false;
	const people = validMembers(tripId, input.assignees);

	db.exec('BEGIN');
	try {
		db.prepare(
			`UPDATE cost_items SET category = ?, label = ?, amount_cents = ?, currency = ?
			 WHERE id = ? AND trip_id = ?`
		).run(ok.category, ok.label, ok.cents, currency, itemId, tripId);
		setPeople(itemId, people);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	publish(tripId, 'costs'); // after COMMIT
	return true;
}

export function removeCostItem(tripId: string, actorId: string, itemId: string): boolean {
	if (!isMember(tripId, actorId)) return false;
	const res = db.prepare(`DELETE FROM cost_items WHERE id = ? AND trip_id = ?`).run(itemId, tripId);
	if (res.changes > 0) publish(tripId, 'costs');
	return res.changes > 0;
}
