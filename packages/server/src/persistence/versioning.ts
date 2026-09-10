/**
 * The outcome of a write that several people can make at the same time.
 *
 * A boolean was enough while every refusal meant the same thing ("not yours, or
 * no such row"). Optimistic concurrency adds a second kind of no that needs a
 * different answer and a different message: the row is real and the caller may
 * write it, but somebody else already did, so this write is built on a copy
 * that no longer exists.
 *
 * Collapsing the two would either 404 an edit whose row is plainly on screen,
 * or 409 a row that was genuinely deleted. Both read as bugs to the person
 * holding the phone, so the distinction is carried rather than flattened.
 *
 * `version` comes back on success so a client that made two edits in a row does
 * not have to refetch between them to stay writable.
 */
export type WriteResult =
	{ ok: true; version: number } | { ok: false; reason: 'missing' | 'conflict' };

export const written = (version: number): WriteResult => ({ ok: true, version });
export const missing: WriteResult = { ok: false, reason: 'missing' };
export const conflict: WriteResult = { ok: false, reason: 'conflict' };

/**
 * Read the version a client claims to have been looking at.
 *
 * An absent version means "I am not tracking versions": the write proceeds
 * unchecked, which is what keeps older clients and one-off scripts working.
 * Only a version that is present and stale is a conflict, so a client opts in
 * to the protection by sending one, and cannot be locked out by sending
 * nothing.
 */
export function isStale(expected: number | null | undefined, actual: number): boolean {
	return expected !== null && expected !== undefined && expected !== actual;
}
