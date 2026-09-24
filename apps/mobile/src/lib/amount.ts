/**
 * A typed amount, read the way a traveller means it.
 *
 * The amount keyboard offers a comma on phones set to comma-decimal regions,
 * so "12,50" has to read as twelve and a half. A comma is only ever a decimal
 * point when one or two digits follow it: "1,000" and "12,500" are thousands,
 * and reading them as 1.00 and 12.50 would quietly save a tenth of a hotel.
 * Anything with a thousands comma is refused (NaN) rather than guessed at, the
 * same answer the form gave before commas were read at all.
 */
export function parseAmount(value: string): number {
	const trimmed = value.trim();
	if (/^-?\d+,\d{1,2}$/.test(trimmed)) return Number(trimmed.replace(',', '.'));
	return Number(trimmed);
}
