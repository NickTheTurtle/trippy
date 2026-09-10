/**
 * Display formatters for money and dates.
 *
 * Three pages had grown their own money helper and they disagreed about the
 * unit: Discover divided by 100, Expenses took major units already divided by
 * its caller, and Preparation divided by 100 and dropped the decimals. The same
 * amount therefore rendered three ways depending on which page you were on, and
 * a caller passing the wrong unit was off by a hundred with nothing to catch it.
 *
 * Everything here takes **cents**, because that is what the server stores and
 * now returns (`priceCents`, `amountCents`, `netCents`); the major-unit fields
 * are deprecated shims. Dates are `YYYY-MM-DD` day strings and are read as UTC,
 * so a calendar day never shifts by the reader's zone.
 *
 * This lives in `apps/web` rather than `@trippy/core` because it is
 * presentation: it picks locale-dependent wording and non-breaking spaces for a
 * particular layout, which is not domain logic.
 */

import { copy } from '../copy';

/** A whole-cent amount in `currency`, e.g. "$1,240.00" (or "$1,240" when whole). */
export function formatMoney(
	cents: number,
	currency: string,
	options: { whole?: boolean } = {}
): string {
	return new Intl.NumberFormat(undefined, {
		style: 'currency',
		currency,
		...(options.whole ? { maximumFractionDigits: 0 } : {})
	}).format(cents / 100);
}

/**
 * The bare currency symbol, for prefixing an input the user types a number
 * into. Taken from `Intl` rather than a table, so it follows the reader's
 * locale the way every other figure on the page does.
 */
export function currencySymbol(currency: string): string {
	const parts = new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0);
	return parts.find((p) => p.type === 'currency')?.value ?? currency;
}

/**
 * The same, but null-tolerant: an unpriced thing is a real state, not a zero,
 * so the caller says what to render instead of it.
 */
export function formatMoneyOr(
	cents: number | null | undefined,
	currency: string,
	fallback: string,
	options: { whole?: boolean } = {}
): string {
	return cents === null || cents === undefined ? fallback : formatMoney(cents, currency, options);
}

/**
 * A nightly rate. Non-breaking spaces around the slash so the price and its
 * unit wrap as one chunk rather than leaving "night" stranded on its own line
 * in a narrow card.
 */
export function formatPerNight(cents: number | null | undefined, currency: string): string {
	if (cents === null || cents === undefined) return copy.discover.stayCard.priceTbd;
	return `${formatMoney(cents, currency)}\u00a0/\u00a0night`;
}

/**
 * Whole cents from what someone typed into a price box. `null` for an empty
 * box (unpriced), `'bad'` for anything that is not a non-negative amount, which
 * is what the server answers 400 to.
 */
export function parseMoneyToCents(input: string): number | null | 'bad' {
	const text = input.trim();
	if (!text) return null;
	const value = Number(text);
	if (!Number.isFinite(value) || value < 0) return 'bad';
	return Math.round(value * 100);
}

/** "Apr 16", or "Apr 16, 2026" with the year. */
export function formatDay(iso: string, options: { year?: boolean } = {}): string {
	const d = new Date(`${iso}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		...(options.year ? { year: 'numeric' } : {}),
		timeZone: 'UTC'
	});
}

/** "Apr 16 – 20" for a day range, using an en dash because it is a real range. */
export function formatDayRange(start: string, end: string): string {
	const from = new Date(`${start}T00:00:00Z`);
	const to = new Date(`${end}T00:00:00Z`);
	if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return `${start} – ${end}`;
	const sameMonth = start.slice(0, 7) === end.slice(0, 7);
	return `${formatDay(start)} – ${sameMonth ? String(to.getUTCDate()) : formatDay(end)}`;
}

/** Whole nights between two days, or null when the range is not a real one. */
export function nightsBetween(checkIn: string | null, checkOut: string | null): number | null {
	if (!checkIn || !checkOut) return null;
	const ms = Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`);
	if (!Number.isFinite(ms) || ms <= 0) return null;
	return Math.round(ms / 86400000);
}

/** "Apr 16 – 20 · 4 nights", or null when there is no usable range. */
export function formatNights(checkIn: string | null, checkOut: string | null): string | null {
	const n = nightsBetween(checkIn, checkOut);
	if (n === null || !checkIn || !checkOut) return null;
	return `${formatDayRange(checkIn, checkOut)} · ${n} ${n === 1 ? 'night' : 'nights'}`;
}

/**
 * When something was recorded, in the reader's own zone: this is a fact about
 * the reader's timeline (when the row was written), not about a destination.
 * The year only appears when it is not the current one.
 */
export function formatTimestamp(ms: number): string {
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return '';
	const sameYear = d.getFullYear() === new Date().getFullYear();
	return d.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: sameYear ? undefined : 'numeric'
	});
}
