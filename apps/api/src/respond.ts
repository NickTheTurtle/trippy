import type { Context } from 'hono';

/**
 * The two response envelopes every route in this API answers with.
 *
 * Failures are `{ error: string }` and successes with nothing to return are
 * `{ ok: true }`, which is what the clients already read. What was inconsistent
 * was the status attached to each: the same class of refusal came back as 400
 * from one router, 403 from another, and as a false `{ ok: true }` from a third
 * because a boolean-returning domain call had its result dropped. These helpers
 * exist so that choice is made once, at the call site, in one form.
 *
 * The convention:
 *
 *  - 400 the request itself is malformed or the values do not fit the trip
 *  - 401 there is no session
 *  - 403 there is a session, but this member may not do this
 *  - 404 the thing does not exist, or exists in a trip the caller cannot see
 *  - 503 a capacity limit was hit; the same request may succeed later, so the
 *    caller should be given a `Retry-After` alongside it
 *
 * 404 is deliberately overloaded for the "not yours" case (see `requireMember`):
 * distinguishing it from "no such id" tells a stranger which ids are real.
 */
export type FailStatus = 400 | 401 | 403 | 404 | 409 | 502 | 503;

/** The standard error envelope. */
export function fail(c: Context, status: FailStatus, message: string) {
	return c.json({ error: message }, status);
}

/** The standard "it worked, there is nothing to return" envelope. */
export function ok(c: Context) {
	return c.json({ ok: true });
}

/**
 * Answer with the outcome of a domain call.
 *
 * The functions in `@trippy/server` report a refusal (not a member, not the
 * organizer, no such row in this trip, values that do not belong to this trip)
 * as a plain `false`. Discarding that and returning `{ ok: true }` anyway told
 * the member their change had been saved when nothing had been written, and the
 * lie only surfaced on the next reload. Passing the boolean through here makes
 * "I ignored the result" impossible to write by accident.
 */
export function okOr(c: Context, okay: boolean, status: FailStatus, message: string) {
	return okay ? ok(c) : fail(c, status, message);
}
