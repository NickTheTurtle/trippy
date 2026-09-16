import { formatDay } from '../../lib/format';

/**
 * The day an expense happened, on the two sides the ledger needs it.
 *
 * It is deliberately the reader's own calendar day rather than a destination
 * zone. `spent_on` answers "which day did this money go", which is a fact about
 * the person who spent it and the day they were living in; it is not an instant
 * on a timeline that has to be re-expressed anywhere else. That is the same
 * reasoning `formatTimestamp` already gives for showing a recorded-at date
 * locally, so the ledger keeps one rule instead of two.
 */

/** Today as `YYYY-MM-DD` in the reader's own zone, which is what a date input takes. */
export function today(): string {
	// `en-CA` is ISO order, so this is the local calendar day rather than the
	// UTC one. `toISOString().slice(0, 10)` would hand someone in Auckland
	// yesterday's date every morning.
	return new Date().toLocaleDateString('en-CA');
}

/**
 * How a stored day is written in a list: "Apr 16", and "Apr 16, 2026" once it
 * is not this year. The same rule `formatTimestamp` uses, so a ledger that
 * mixes old and new rows reads consistently.
 */
export function formatSpentOn(iso: string): string {
	if (!iso) return '';
	return formatDay(iso, { year: iso.slice(0, 4) !== String(new Date().getFullYear()) });
}
