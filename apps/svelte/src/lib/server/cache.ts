/**
 * A tiny in-process TTL cache with in-flight de-duplication.
 *
 * Place lookups are billed per request, so the same question asked twice should
 * only be paid for once. Two things cause repeats here and both are handled:
 *
 *  - *Repetition over time.* Members research the same city days apart, and the
 *    same person retypes the same query after clearing the box. A TTL is enough
 *    for that; place data does not change minute to minute.
 *  - *Repetition at the same moment.* Typing "acropolis" fires a request, and a
 *    second member typing the same word 200ms later would fire another before
 *    the first has returned; a value cache alone never sees it. Storing the
 *    *promise* rather than the value means the second caller waits on the first
 *    request instead of starting one.
 *
 * A rejected promise is evicted immediately, so a transient failure is not
 * cached and retried callers get a fresh attempt.
 *
 * This is per-process and deliberately not shared state: it is a cost and
 * latency optimisation, not a source of truth, so a restart losing it is fine.
 */
export interface TtlCache<T> {
	/** Returns the cached value for `key`, or runs `load` and caches the result. */
	take(key: string, load: () => Promise<T>): Promise<T>;
	/** Entry count, for tests. */
	readonly size: number;
}

export function createCache<T>(ttlMs: number, max: number): TtlCache<T> {
	const entries = new Map<string, { expires: number; value: Promise<T> }>();

	return {
		take(key, load) {
			const hit = entries.get(key);
			if (hit && hit.expires > Date.now()) return hit.value;

			const value = load();
			entries.set(key, { expires: Date.now() + ttlMs, value });
			value.catch(() => {
				// Only evict if this is still the entry we wrote; a later successful
				// load for the same key must not be thrown away by an older failure.
				if (entries.get(key)?.value === value) entries.delete(key);
			});

			// Bounded so a long-running server cannot be walked into an OOM by
			// unique queries: drop what has expired, then the oldest writes. Map
			// iterates in insertion order, which is near enough to LRU here.
			if (entries.size > max) {
				const now = Date.now();
				for (const [k, e] of entries) if (e.expires <= now) entries.delete(k);
				while (entries.size > max) {
					const oldest = entries.keys().next().value;
					if (oldest === undefined) break;
					entries.delete(oldest);
				}
			}
			return value;
		},
		get size() {
			return entries.size;
		}
	};
}
