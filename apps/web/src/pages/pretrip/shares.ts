import type { CostItem } from './types';

/**
 * Whose money an estimate is, and how much of it is theirs.
 *
 * A line with nobody on it is the whole trip's: an estimate is usually written
 * before anyone has worked out who is doing what, so "everyone" has to be what
 * an untouched line means. A line with people on it is split evenly between
 * exactly those people.
 *
 * These are estimates, so the division is a plain round rather than the
 * remainder-walking the real expense ledger does. Nothing is settled from
 * these numbers; the penny they can be out by never leaves the screen.
 */
export function isFor(item: CostItem, userId: string): boolean {
	return item.people.length === 0 || item.people.some((p) => p.id === userId);
}

export function shareOf(item: CostItem, userId: string, memberCount: number): number {
	if (!isFor(item, userId)) return 0;
	const heads = item.people.length || memberCount;
	return heads > 0 ? Math.round(item.amountCents / heads) : 0;
}

/** What one row reads as: the whole line, or one person's share of it. */
export function amountFor(item: CostItem, viewAs: string, memberCount: number): number {
	return viewAs ? shareOf(item, viewAs, memberCount) : item.amountCents;
}

export function totalFor(items: CostItem[], viewAs: string, memberCount: number): number {
	return items.reduce((n, it) => n + amountFor(it, viewAs, memberCount), 0);
}
