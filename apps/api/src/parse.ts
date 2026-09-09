/**
 * Readers for untrusted request bodies.
 *
 * A JSON body is `unknown`: any field can be missing, null, or the wrong type,
 * and `String(x)` on an object gives "[object Object]" rather than failing. The
 * SvelteKit routes handled this with `String(form.get(k) ?? '')` on every field,
 * which worked because FormData only ever yields strings. JSON has no such
 * guarantee, so the coercion has to be explicit and it belongs in one place.
 */

/** A trimmed string, or '' for anything that is not a string. */
export function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

/**
 * A string exactly as it was sent, or '' for anything that is not a string.
 *
 * Only for values where the surrounding whitespace is part of the value, which
 * in practice means passwords: a space typed at either end of one is a
 * character of it, and trimming it would silently lock out the account that
 * chose it.
 */
export function rawStr(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

/** A trimmed string, or null when absent or empty. Matches the `|| null` idiom. */
export function optStr(v: unknown): string | null {
	const s = str(v);
	return s === '' ? null : s;
}

/** A finite number, or null. Accepts numeric strings, since form inputs give those. */
export function num(v: unknown): number | null {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/**
 * A whole number, or null. Accepts numeric strings like `num` does.
 *
 * Money in minor units, pixel widths and minute offsets are all counts, and a
 * fractional one is a bad request rather than something to round: `1.5` cents
 * is not a price a client meant to send.
 */
export function int(v: unknown): number | null {
	const n = num(v);
	return n === null || !Number.isInteger(n) ? null : n;
}

/** An ISO calendar day (YYYY-MM-DD) that is a real date, or null. */
export function isoDay(v: unknown): string | null {
	const s = str(v);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
	const [y, m, d] = s.split('-').map(Number);
	const date = new Date(Date.UTC(y, m - 1, d));
	// Round-tripping rejects the shapes the regex cannot: month 13, the 31st of
	// February, and anything else that Date silently rolls over into next month.
	return date.toISOString().slice(0, 10) === s ? s : null;
}

/**
 * A plain object of untrusted values, or an empty one.
 *
 * The point is the rejection: an array, a string or null arriving where a map
 * of per-user values was expected must not be indexed into as though it were
 * one, and asserting `as Record<string, unknown>` would let it be.
 */
export function record(v: unknown): Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}

/**
 * A list of non-empty strings. Accepts a real array or the comma-joined form the
 * SvelteKit forms used, so a client written against either shape works.
 */
export function strList(v: unknown): string[] {
	const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
	return raw.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
}

/** Reads a JSON body, returning an empty object rather than throwing on bad input. */
export async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
	return record(await c.req.json().catch(() => null));
}
