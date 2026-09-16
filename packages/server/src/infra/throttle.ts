/**
 * Failed-attempt throttling for the credential endpoints.
 *
 * Verifying a password here is deliberately expensive: scrypt with a 64 byte
 * derived key, which is what makes a stolen `users` table worth little. That
 * same cost is a liability on the way in. An unthrottled login is both an
 * offer to guess passwords at whatever rate the network allows and, because
 * every guess burns real CPU, a way to make the process unresponsive for
 * everybody else with a laptop and a loop.
 *
 * The answer is a per-key backoff that grows with consecutive failures and
 * resets the moment one succeeds. A person who mistypes their password twice
 * never notices; a script trying the top thousand passwords is stopped after
 * the first few and spends the rest of its time waiting.
 *
 * State is in memory, like the FX rates and the geocode cache. It is lost on
 * restart, which is the honest trade for a single-process app: a persistent
 * counter would be a write to the same SQLite file on every failed guess,
 * which hands the attacker a cheaper way to cause load than the one being
 * defended against.
 */

/** Failures allowed before any waiting starts. Covers ordinary mistyping. */
const FREE_ATTEMPTS = 5;

/**
 * How many registrations one address gets before the same backoff applies.
 *
 * Signing up is not guessing, so the ceiling is about stopping bulk account
 * creation rather than about protecting a secret, and it can be far looser than
 * the login one. It is configurable because an end-to-end run legitimately
 * creates an account per test from a single address, and a suite that has to
 * sit out an exponential backoff to test anything else is a suite nobody runs.
 * Raising it costs nothing an attacker could not already do more slowly.
 */
export const REGISTER_ATTEMPTS = Number(process.env.TRIPPY_REGISTER_LIMIT ?? 20);

/**
 * Per-caller ceilings on billed provider calls (place search and details, the
 * geocoder, the photo proxy), before the same backoff applies.
 *
 * `cache.ts` already stops a repeated question from being re-bought, but a novel
 * query costs money every time and any signed-in caller can spin them in a loop.
 * These are a per-caller quota on the calls a cache miss would actually make, so
 * ordinary searching never notices while a loop is stopped fast.
 *
 * The numbers are chosen for a real group-trip user. Someone researching a city
 * types a few dozen distinct searches across an afternoon; 60 novel billed calls
 * an hour sits well above that, and the per-IP figure is four times looser so a
 * household or office sharing one NAT address (Trippy's own core use case) is not
 * throttled as if it were one person. A tight loop, by contrast, burns 60 in
 * seconds and then meets exponential backoff. Both are configurable so the owner
 * can tune them against the real bill without a deploy of code.
 *
 * Open sign-up is why the per-IP backstop matters at all: the per-user limit is
 * trivially reset by registering another account, so a single machine minting
 * accounts to dodge it still meets a ceiling on its address.
 */
export const PROVIDER_LIMIT = Number(process.env.TRIPPY_PROVIDER_LIMIT ?? 60);
export const PROVIDER_IP_LIMIT = Number(process.env.TRIPPY_PROVIDER_IP_LIMIT ?? 240);

/**
 * The routing provider gets its own, looser, per-user ceiling and a gentler
 * failure mode (the caller falls back to the free estimate rather than being
 * refused; see provider-quota.ts). A full itinerary legitimately has many legs
 * and a board load routes each once, so this has to clear a real trip's worth of
 * journeys, not a handful of searches.
 */
export const ROUTING_LIMIT = Number(process.env.TRIPPY_ROUTING_LIMIT ?? 300);

/**
 * Per-user ceiling on cover-photo lookups, which are billed Places calls made
 * by the backlog drainer rather than by anything a member typed.
 *
 * It needs its own number for the same reason routing does. A row is looked up
 * at most once ever and a single request drains at most `PHOTO_BACKLOG_CAP` of
 * them, so ordinary use is self-limiting; what is not self-limiting is a caller
 * who adds places faster than the backlog drains, which turns "add a row" into
 * "buy a Places call" with no ceiling anywhere. Charging these against
 * `PROVIDER_LIMIT` instead would have been worse than no limit in one specific
 * way: opening a fresh trip with a full backlog would spend a third of the
 * search allowance before the member had typed anything, and they would then be
 * refused a search they were entitled to. Cosmetic work must not be able to
 * lock a member out of the work they came to do, so it gets a separate, looser
 * allowance and a gentler failure: the drain simply stops and the rows stay in
 * the backlog for the next visit.
 */
export const PHOTO_LIMIT = Number(process.env.TRIPPY_PHOTO_LIMIT ?? 120);

/** First penalty, doubling per failure after that. */
const BASE_DELAY_MS = 2_000;

/** Longest a caller is ever asked to wait. */
const MAX_DELAY_MS = 15 * 60 * 1000;

/** A quiet spell this long forgets the failures entirely. */
const RESET_AFTER_MS = 60 * 60 * 1000;

interface Attempts {
	fails: number;
	/** Nothing is accepted for this key before this moment. */
	blockedUntil: number;
	last: number;
}

const attempts = new Map<string, Attempts>();

/** Keeps a long-running process from accumulating a row per address ever tried. */
function prune(now: number): void {
	if (attempts.size < 1000) return;
	for (const [key, a] of attempts) {
		if (now - a.last > RESET_AFTER_MS) attempts.delete(key);
	}
}

/**
 * How much longer this key must wait, in milliseconds. Zero means go ahead.
 *
 * Call before doing the expensive work, so a blocked attempt costs a map
 * lookup rather than a key derivation.
 */
export function retryAfterMs(key: string, now = Date.now()): number {
	const a = attempts.get(key);
	if (!a) return 0;
	if (now - a.last > RESET_AFTER_MS) {
		attempts.delete(key);
		return 0;
	}
	return Math.max(0, a.blockedUntil - now);
}

/**
 * Record a failed attempt and return how long this key must now wait.
 *
 * `free` is how many attempts this kind of key gets for nothing. It is a
 * parameter rather than a constant because the endpoints differ in what an
 * attempt means: a wrong password is a guess, a registration is a signup.
 */
export function recordFailure(key: string, now = Date.now(), free = FREE_ATTEMPTS): number {
	prune(now);
	const prev = attempts.get(key);
	const fails = prev && now - prev.last <= RESET_AFTER_MS ? prev.fails + 1 : 1;
	// The first `free` attempts cost nothing; each one after that doubles the
	// wait, so guessing gets slow fast while a real person barely notices.
	const over = fails - free;
	const delay = over <= 0 ? 0 : Math.min(BASE_DELAY_MS * 2 ** (over - 1), MAX_DELAY_MS);
	attempts.set(key, { fails, blockedUntil: now + delay, last: now });
	return delay;
}

/** Forget this key's failures. Called on every success. */
export function clearFailures(key: string): void {
	attempts.delete(key);
}

/** Drop all state. For tests, which must not inherit each other's counters. */
export function resetThrottle(): void {
	attempts.clear();
}
