import { db } from '../db';

/**
 * What each paid provider last did, and whether it is answering right now.
 *
 * Two problems are solved here, and they are the same problem at two time
 * scales.
 *
 * *Within a process*: a provider failure used to be swallowed. `searchPlaces`
 * caught its errors and dropped to Photon while `/api/health` went on saying
 * "google", which hid a real outage for days: every search in the dev
 * environment was answered by OSM (`source: "osm"`, `id: null`) while the app
 * reported Google, and nothing anywhere said why. Degrading to a free provider
 * is the right behaviour; doing it silently is not. Routing had the same shape
 * of bug and not even the logging: `withTimeout` turned every throw into `null`
 * and a non-ok response returned `null`, so a board quietly ran on straight-line
 * estimates with nothing to see anywhere.
 *
 * *Across processes*: knowing this only in memory is not enough. The API runs
 * under `tsx watch`, so a saved file restarts it and the process forgets that
 * Google is rejecting its key. Health then reports green until the next user
 * happens to search, which is exactly the false green a monitor must not see.
 * So the last success and the last failure are also written to SQLite (the
 * `provider_health` table) and read back on the first status call in a new
 * process.
 *
 * Alternatives weighed, and why not:
 *
 *  - *Probe the provider when `/api/health` is called.* A health endpoint is
 *    polled on a timer by definition, so this turns monitoring into a billing
 *    line, and a synthetic probe passing does not prove that a real search with
 *    a real field mask does.
 *  - *Derive it from configuration alone.* That is what `activeProvider()` does,
 *    and it is precisely the false green being fixed: both Google keys in this
 *    environment are present and rejected, which configuration cannot see.
 *  - *Persist nothing and accept the amnesia.* Cheapest, and the state it loses
 *    is the only state anyone wants.
 *
 * The bias is deliberate: a remembered failure stands until a real call
 * succeeds. It can therefore be stale in the "degraded" direction, which costs
 * an operator one look at a timestamp, while the opposite error costs days of
 * silently worse answers. `at` is on every failure so the age is always visible.
 *
 * Writes are on state changes, not on every call: a search that succeeds while
 * the stored state already says "fine" writes nothing, so the hot path stays
 * read-only.
 */

/** The provider-backed services that can degrade independently. */
export type ProviderService = 'places' | 'routing' | 'osrm';

/** What a failure looked like, without the key or the query in it. */
export interface ProviderFailure {
	/** Which call failed, e.g. `google places text search`. */
	op: string;
	/** Status code or short transport reason. Never a key, never a full query. */
	reason: string;
	/** Epoch ms of the most recent occurrence. */
	at: number;
	/** How many times this op/reason pair has failed since the last reset. */
	count: number;
}

/** One service's state: whether the last thing it did was fail, and what. */
export interface ServiceHealth {
	/** True when the most recent recorded event for this service was a failure. */
	failing: boolean;
	lastFailure: ProviderFailure | null;
	/** Epoch ms of the last recorded success, or 0 when there has been none. */
	lastOkAt: number;
}

/**
 * One line per distinct failure per minute.
 *
 * Search fires as you type, so an outage produces a failure per keystroke-batch
 * per member: logging every one turns a single broken key into thousands of
 * identical lines and buries whatever else the server was saying. De-duplicated
 * on service, op and reason (a 403 from a key restriction and a 429 from quota
 * are different problems and both deserve to be seen) and rate-limited to one
 * line a minute each, with the suppressed count carried into the next line so
 * the volume is still visible. First occurrence is always logged immediately.
 */
const FAILURE_LOG_INTERVAL_MS = 60_000;

/** How often a continuing failure is re-written to the table. */
const PERSIST_INTERVAL_MS = 60_000;

/**
 * What each service says when it degrades, for the log line.
 *
 * Google Routes and OSRM are recorded separately rather than as one "routing"
 * service, because they fail for different reasons and the second failure would
 * otherwise erase the first: when a rejected key drops a leg to OSRM and OSRM is
 * also unreachable, the reason worth reporting is the rejected key, not the
 * free fallback that was only asked because of it.
 */
const FALLBACK_NOTE: Record<ProviderService, string> = {
	places: 'Serving OpenStreetMap results instead.',
	routing: 'Falling back to OSRM or the free estimate.',
	osrm: 'Falling back to the free route estimate.'
};

const failureLog = new Map<string, { at: number; suppressed: number }>();
const failureCounts = new Map<string, number>();

interface MemoryState {
	lastFailure: ProviderFailure | null;
	lastOkAt: number;
	/** When this service's row was last written, so a storm is not a write storm. */
	persistedAt: number;
	/** True once the stored row has been read into this process. */
	loaded: boolean;
}

const state = new Map<ProviderService, MemoryState>();

function memory(service: ProviderService): MemoryState {
	let s = state.get(service);
	if (!s) {
		s = { lastFailure: null, lastOkAt: 0, persistedAt: 0, loaded: false };
		state.set(service, s);
	}
	if (!s.loaded) {
		s.loaded = true;
		const row = db
			.prepare(
				`SELECT ok_at, fail_at, fail_op, fail_reason, fail_count
				 FROM provider_health WHERE service = ?`
			)
			.get(service) as
			| {
					ok_at: number;
					fail_at: number | null;
					fail_op: string | null;
					fail_reason: string | null;
					fail_count: number;
			  }
			| undefined;
		if (row) {
			s.lastOkAt = row.ok_at ?? 0;
			s.lastFailure =
				row.fail_at != null
					? {
							op: row.fail_op ?? 'unknown',
							reason: row.fail_reason ?? 'unknown',
							at: row.fail_at,
							count: row.fail_count ?? 1
						}
					: null;
			s.persistedAt = Math.max(s.lastOkAt, row.fail_at ?? 0);
		}
	}
	return s;
}

function persist(service: ProviderService, s: MemoryState): void {
	db.prepare(
		`INSERT INTO provider_health (service, ok_at, fail_at, fail_op, fail_reason, fail_count)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(service) DO UPDATE SET
		   ok_at = excluded.ok_at,
		   fail_at = excluded.fail_at,
		   fail_op = excluded.fail_op,
		   fail_reason = excluded.fail_reason,
		   fail_count = excluded.fail_count`
	).run(
		service,
		s.lastOkAt,
		s.lastFailure?.at ?? null,
		s.lastFailure?.op ?? null,
		s.lastFailure?.reason ?? null,
		s.lastFailure?.count ?? 0
	);
	s.persistedAt = Date.now();
}

/** A short, safe description of a provider error: a status code, or its kind. */
export function shortReason(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	// Belt and braces. Nothing here puts a key in a message or a URL, but a
	// logged line must never be the first place that changes.
	return raw.replace(/([?&](key|api_?key)=)[^&\s]*/gi, '$1[redacted]').slice(0, 120);
}

/**
 * Record that a provider call failed. Logs at most one line a minute per
 * distinct failure, and stores the state so a restart does not forget it.
 */
export function noteProviderFailure(service: ProviderService, op: string, err: unknown): void {
	const reason = shortReason(err);
	const key = `${service}|${op}|${reason}`;
	const count = (failureCounts.get(key) ?? 0) + 1;
	failureCounts.set(key, count);

	const s = memory(service);
	const now = Date.now();
	const changed = s.lastFailure?.op !== op || s.lastFailure?.reason !== reason;
	s.lastFailure = { op, reason, at: now, count };
	// Written on the first failure, on a change of failure, and then no more
	// than once a minute: an outage must not turn every keystroke into a write.
	if (changed || now - s.persistedAt >= PERSIST_INTERVAL_MS) persist(service, s);

	const seen = failureLog.get(key);
	if (seen && now - seen.at < FAILURE_LOG_INTERVAL_MS) {
		seen.suppressed += 1;
		return;
	}
	const also = seen?.suppressed ? ` (+${seen.suppressed} more since)` : '';
	failureLog.set(key, { at: now, suppressed: 0 });
	console.warn(`[${service}] ${op} failed: ${reason}${also}. ${FALLBACK_NOTE[service]}`);
}

/**
 * Record that a provider call succeeded.
 *
 * Only a recovery is written: while the stored state already says healthy this
 * does nothing but move a number in memory, so the common case (every search,
 * every routed leg) costs no I/O.
 */
export function noteProviderOk(service: ProviderService): void {
	const s = memory(service);
	const wasFailing = s.lastFailure !== null && s.lastFailure.at > s.lastOkAt;
	s.lastOkAt = Date.now();
	if (wasFailing || s.persistedAt === 0) persist(service, s);
}

/** Whether the last thing this service did was fail, and what it was. */
export function serviceHealth(service: ProviderService): ServiceHealth {
	const s = memory(service);
	const failing = s.lastFailure !== null && s.lastFailure.at > s.lastOkAt;
	return { failing, lastFailure: failing ? s.lastFailure : null, lastOkAt: s.lastOkAt };
}

/**
 * Forget recorded health.
 *
 * `memory` drops only what this process holds, which is what a restart does and
 * is how a test proves the stored state is what survives it. `all` also clears
 * the table, for a test that needs a clean slate or an operator who has fixed a
 * key and does not want to wait for the next call to prove it.
 */
export function resetProviderHealth(scope: 'all' | 'memory' = 'all'): void {
	failureLog.clear();
	failureCounts.clear();
	state.clear();
	if (scope === 'all') db.prepare(`DELETE FROM provider_health`).run();
}
