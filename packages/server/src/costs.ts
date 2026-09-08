import { randomUUID } from 'node:crypto';
import { db } from './db';

export const COST_CATEGORIES = ['lodging', 'activities', 'food', 'travel'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export interface BudgetCity {
	id: string;
	name: string;
	amounts: Record<string, number>; // category -> cents
	total: number; // cents
}

export interface Budget {
	cities: BudgetCity[];
	categoryTotals: Record<string, number>;
	grandTotal: number;
}

function isMember(tripId: string, userId: string): boolean {
	return !!db
		.prepare(`SELECT 1 FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.get(tripId, userId);
}

export function getBudget(tripId: string): Budget {
	const cities = db
		.prepare(`SELECT id, name FROM cities WHERE trip_id = ? ORDER BY sort`)
		.all(tripId) as unknown as { id: string; name: string }[];
	const rows = db
		.prepare(`SELECT city_id, category, amount_cents FROM cost_estimates WHERE trip_id = ?`)
		.all(tripId) as unknown as { city_id: string; category: string; amount_cents: number }[];

	const byCity = new Map<string, Record<string, number>>();
	for (const r of rows) {
		if (!byCity.has(r.city_id)) byCity.set(r.city_id, {});
		byCity.get(r.city_id)![r.category] = r.amount_cents;
	}

	const categoryTotals: Record<string, number> = {};
	for (const c of COST_CATEGORIES) categoryTotals[c] = 0;
	let grandTotal = 0;

	const budgetCities: BudgetCity[] = cities.map((c) => {
		const amounts: Record<string, number> = {};
		let total = 0;
		for (const cat of COST_CATEGORIES) {
			const cents = byCity.get(c.id)?.[cat] ?? 0;
			amounts[cat] = cents;
			total += cents;
			categoryTotals[cat] += cents;
		}
		grandTotal += total;
		return { id: c.id, name: c.name, amounts, total };
	});

	return { cities: budgetCities, categoryTotals, grandTotal };
}

/** Upsert a set of {cityId, category, cents} budget cells. Members only. */
export function setBudget(
	tripId: string,
	actorId: string,
	entries: { cityId: string; category: string; cents: number }[]
): boolean {
	if (!isMember(tripId, actorId)) return false;
	const cityIds = new Set(
		(
			db.prepare(`SELECT id FROM cities WHERE trip_id = ?`).all(tripId) as unknown as {
				id: string;
			}[]
		).map((c) => c.id)
	);
	const upsert = db.prepare(
		`INSERT INTO cost_estimates (trip_id, city_id, category, amount_cents)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(trip_id, city_id, category) DO UPDATE SET amount_cents = excluded.amount_cents`
	);
	for (const e of entries) {
		if (!cityIds.has(e.cityId)) continue;
		if (!(COST_CATEGORIES as readonly string[]).includes(e.category)) continue;
		const cents = Math.max(0, Math.round(e.cents));
		upsert.run(tripId, e.cityId, e.category, cents);
	}
	return true;
}

// ---- Itemized cost breakdown -------------------------------------------------

export interface CostItem {
	id: string;
	cityId: string | null;
	cityName: string | null;
	category: string;
	label: string;
	amountCents: number;
	sort: number;
}

export interface ItemizedBudget {
	items: CostItem[];
	categoryTotals: Record<string, number>;
	grandTotal: number;
}

export function listCostItems(tripId: string): CostItem[] {
	const rows = db
		.prepare(
			`SELECT ci.id, ci.city_id, ci.category, ci.label, ci.amount_cents, ci.sort, c.name AS city_name
			 FROM cost_items ci LEFT JOIN cities c ON c.id = ci.city_id
			 WHERE ci.trip_id = ? ORDER BY ci.sort, ci.created_at`
		)
		.all(tripId) as unknown as {
		id: string;
		city_id: string | null;
		category: string;
		label: string;
		amount_cents: number;
		sort: number;
		city_name: string | null;
	}[];
	return rows.map((r) => ({
		id: r.id,
		cityId: r.city_id,
		cityName: r.city_name,
		category: r.category,
		label: r.label,
		amountCents: r.amount_cents,
		sort: r.sort
	}));
}

export function getItemizedBudget(tripId: string): ItemizedBudget {
	const items = listCostItems(tripId);
	const categoryTotals: Record<string, number> = {};
	for (const c of COST_CATEGORIES) categoryTotals[c] = 0;
	let grandTotal = 0;
	for (const it of items) {
		categoryTotals[it.category] = (categoryTotals[it.category] ?? 0) + it.amountCents;
		grandTotal += it.amountCents;
	}
	return { items, categoryTotals, grandTotal };
}

function validItem(
	label: string,
	category: string,
	cents: number
): { label: string; category: string; cents: number } | null {
	const l = label.trim();
	if (!l || l.length > 120) return null;
	if (!(COST_CATEGORIES as readonly string[]).includes(category)) return null;
	if (!Number.isFinite(cents) || cents < 0) return null;
	return { label: l, category, cents: Math.round(cents) };
}

export function addCostItem(
	tripId: string,
	actorId: string,
	input: { cityId?: string | null; category: string; label: string; cents: number }
): boolean {
	if (!isMember(tripId, actorId)) return false;
	const ok = validItem(input.label, input.category, input.cents);
	if (!ok) return false;
	let cityId: string | null = null;
	if (input.cityId) {
		const found = db
			.prepare(`SELECT id FROM cities WHERE id = ? AND trip_id = ?`)
			.get(input.cityId, tripId);
		if (found) cityId = input.cityId;
	}
	const next = db
		.prepare(`SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM cost_items WHERE trip_id = ?`)
		.get(tripId) as { n: number };
	db.prepare(
		`INSERT INTO cost_items (id, trip_id, city_id, category, label, amount_cents, sort, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		randomUUID(),
		tripId,
		cityId,
		ok.category,
		ok.label,
		ok.cents,
		next.n,
		Date.now()
	);
	return true;
}

export function updateCostItem(
	tripId: string,
	actorId: string,
	itemId: string,
	input: { cityId?: string | null; category: string; label: string; cents: number }
): boolean {
	if (!isMember(tripId, actorId)) return false;
	const ok = validItem(input.label, input.category, input.cents);
	if (!ok) return false;
	let cityId: string | null = null;
	if (input.cityId) {
		const found = db
			.prepare(`SELECT id FROM cities WHERE id = ? AND trip_id = ?`)
			.get(input.cityId, tripId);
		if (found) cityId = input.cityId;
	}
	const res = db
		.prepare(
			`UPDATE cost_items SET city_id = ?, category = ?, label = ?, amount_cents = ?
			 WHERE id = ? AND trip_id = ?`
		)
		.run(cityId, ok.category, ok.label, ok.cents, itemId, tripId);
	return res.changes > 0;
}

export function removeCostItem(tripId: string, actorId: string, itemId: string): boolean {
	if (!isMember(tripId, actorId)) return false;
	const res = db
		.prepare(`DELETE FROM cost_items WHERE id = ? AND trip_id = ?`)
		.run(itemId, tripId);
	return res.changes > 0;
}
