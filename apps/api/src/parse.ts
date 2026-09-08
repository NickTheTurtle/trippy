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
 * A list of non-empty strings. Accepts a real array or the comma-joined form the
 * SvelteKit forms used, so a client written against either shape works.
 */
export function strList(v: unknown): string[] {
	const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
	return raw.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
}

/** Reads a JSON body, returning an empty object rather than throwing on bad input. */
export async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
	const parsed = await c.req.json().catch(() => null);
	return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}
