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

/** Record a failed attempt and return how long this key must now wait. */
export function recordFailure(key: string, now = Date.now()): number {
	prune(now);
	const prev = attempts.get(key);
	const fails = prev && now - prev.last <= RESET_AFTER_MS ? prev.fails + 1 : 1;
	// The first `FREE_ATTEMPTS` cost nothing; each one after that doubles the
	// wait, so guessing gets slow fast while a real person barely notices.
	const over = fails - FREE_ATTEMPTS;
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
