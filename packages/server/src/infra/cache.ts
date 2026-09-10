import { db } from '../db';

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

/**
 * The same cache, with its values also written to SQLite so a restart does not
 * throw away answers we have already paid for.
 *
 * This matters more than it sounds. The API runs under `tsx watch`, so every
 * saved file restarts the process; before this, a day of development re-bought
 * the same place searches dozens of times over. The memory layer is kept in
 * front of the table because it is what de-duplicates requests that are in
 * flight at the same moment, which a stored value can never do.
 *
 * Values are JSON, so this suits provider results and not binary. `ttlMs` is
 * capped at 30 days, the limit Google's terms place on caching Places content.
 */
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createPersistentCache<T>(
	namespace: string,
	ttlMs: number,
	max: number
): TtlCache<T> {
	const ttl = Math.min(ttlMs, MAX_TTL_MS);
	const mem = createCache<T>(ttl, max);
	const read = db.prepare(`SELECT value FROM provider_cache WHERE key = ? AND expires_at > ?`);
	const write = db.prepare(
		`INSERT INTO provider_cache (key, value, expires_at) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
	);
	const prune = db.prepare(`DELETE FROM provider_cache WHERE expires_at <= ?`);

	return {
		take(key, load) {
			const full = `${namespace}|${key}`;
			return mem.take(full, async () => {
				const hit = read.get(full, Date.now()) as { value: string } | undefined;
				// A row we cannot parse is a row from an older shape of the value.
				// Treat it as a miss and let the fresh load overwrite it.
				if (hit) {
					try {
						return JSON.parse(hit.value) as T;
					} catch {
						/* fall through to the load */
					}
				}
				const value = await load();
				write.run(full, JSON.stringify(value), Date.now() + ttl);
				prune.run(Date.now());
				return value;
			});
		},
		get size() {
			return mem.size;
		}
	};
}
