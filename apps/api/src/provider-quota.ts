import type { Context } from 'hono';
import {
	recordFailure,
	retryAfterMs,
	PROVIDER_LIMIT,
	PROVIDER_IP_LIMIT,
	ROUTING_LIMIT
} from '@trippy/server/throttle';
import { clientIp } from './client-ip';

/**
 * Per-caller quotas on the endpoints that spend money at a provider.
 *
 * The mechanism is the same keyed exponential backoff the login and register
 * throttles use (`throttle.ts`), reused rather than reinvented: each billed call
 * is recorded like a "failure", the first `free` of them cost nothing, and past
 * that the caller is made to wait longer and longer. A free allowance is exactly
 * the right shape for a quota, so no new machinery is needed.
 *
 * The one rule that makes this safe to attach is that a gate is invoked *only on
 * a cache miss*, from inside the provider's own `load` closure. A cached hit
 * returns before the gate runs, so it neither consumes quota nor can be blocked:
 * serving an answer we have already paid for must never cost the caller anything.
 */

/** Thrown by a billing gate when the caller is over quota. Carries the wait. */
export class QuotaError extends Error {
	constructor(public readonly retryMs: number) {
		super('provider quota exceeded');
		this.name = 'QuotaError';
	}
}

/**
 * Turn a thrown `QuotaError` into the standard 429, with a `Retry-After` in
 * whole seconds, or rethrow anything else. Lets a route wrap a gated provider
 * call in one `catch` without teaching every handler the quota's shape.
 */
export function quota429(c: Context, err: unknown): Response {
	if (err instanceof QuotaError) {
		c.header('retry-after', String(Math.ceil(err.retryMs / 1000)));
		return c.json({ error: 'Slow down a moment; too many searches just now.' }, 429);
	}
	throw err;
}

/** The keys a request is charged against: the user, and the client address. */
function providerKeys(c: Context, userId: string): { key: string; free: number }[] {
	return [
		{ key: `provider:user:${userId}`, free: PROVIDER_LIMIT },
		{ key: `provider:ip:${clientIp(c)}`, free: PROVIDER_IP_LIMIT }
	];
}

/**
 * A gate for the search-style endpoints (place search, place details, city
 * search, photo proxy), which surface a refusal to the caller. Throws
 * `QuotaError` when either the per-user or per-IP ceiling is already spent;
 * otherwise it records one billed call against both and returns.
 *
 * Pass the result as the `gate` of a provider call. It fires once per real
 * provider request, so a burst that shares one in-flight fetch is charged once.
 */
export function billingGate(c: Context, userId: string): () => void {
	const keys = providerKeys(c, userId);
	return () => {
		const wait = Math.max(0, ...keys.map((k) => retryAfterMs(k.key)));
		if (wait > 0) throw new QuotaError(wait);
		const now = Date.now();
		for (const k of keys) recordFailure(k.key, now, k.free);
	};
}

/**
 * A gate for routing, which must never break a board load. Instead of throwing,
 * it returns false when the per-user ceiling is spent, and the caller quietly
 * uses the free straight-line estimate. Per-user only: a board load fans out
 * across a NAT the same way registrations do, so charging routing per shared IP
 * would degrade a whole office's boards at once for no cost saved.
 */
export function routingGate(userId: string): () => boolean {
	const key = `routing:user:${userId}`;
	return () => {
		if (retryAfterMs(key) > 0) return false;
		recordFailure(key, Date.now(), ROUTING_LIMIT);
		return true;
	};
}
