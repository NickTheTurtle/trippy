import { db } from '../db';

/**
 * A disk cache for Places photo *bytes*.
 *
 * Photos are billed per request, and the proxy in front of them was a pure
 * pass-through: the browser cache was the only thing standing between a cold
 * page load and a fresh bill. That cache is per browser profile and short
 * lived, so every new profile, every private window and every automated check
 * paid for the same pictures again.
 *
 * The bytes for a given photo reference do not change, so one fetch can serve
 * everyone. What stops this being permanent is Google's terms, which cap
 * caching of Places content at 30 days; entries past that are dropped and
 * re-fetched rather than served.
 *
 * Rows are keyed by reference *and* width, because a different width is a
 * genuinely different image. In practice the app asks for one width, so this is
 * one row per photo.
 */
export interface CachedPhoto {
	bytes: Uint8Array;
	contentType: string;
}

/** Google's limit on how long Places content may be cached. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Most photos to keep. At roughly 100KB each this bounds the table at tens of
 * megabytes, and the app holds far fewer than this; the cap exists so a long
 * run of unusual widths cannot grow the database without limit.
 */
const MAX_ROWS = 500;

export function readPhoto(name: string, width: number): CachedPhoto | null {
	const row = db
		.prepare(`SELECT bytes, content_type FROM photo_cache WHERE key = ? AND expires_at > ?`)
		.get(`${name}|${width}`, Date.now()) as
		| { bytes: Uint8Array; content_type: string }
		| undefined;
	return row ? { bytes: row.bytes, contentType: row.content_type } : null;
}

export function writePhoto(
	name: string,
	width: number,
	bytes: Uint8Array,
	contentType: string
): void {
	db.prepare(
		`INSERT INTO photo_cache (key, bytes, content_type, expires_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET
		   bytes = excluded.bytes,
		   content_type = excluded.content_type,
		   expires_at = excluded.expires_at`
	).run(`${name}|${width}`, bytes, contentType, Date.now() + TTL_MS);

	db.prepare(`DELETE FROM photo_cache WHERE expires_at <= ?`).run(Date.now());
	// Oldest expiry first, which for a fixed TTL is oldest written first.
	db.prepare(
		`DELETE FROM photo_cache WHERE key IN (
		   SELECT key FROM photo_cache ORDER BY expires_at DESC LIMIT -1 OFFSET ?
		 )`
	).run(MAX_ROWS);
}

/** How many photos are cached. For tests and for answering "is this working?". */
export function photoCacheSize(): number {
	return (db.prepare(`SELECT COUNT(*) AS n FROM photo_cache`).get() as { n: number }).n;
}
