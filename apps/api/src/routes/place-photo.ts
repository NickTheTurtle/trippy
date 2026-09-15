import { Hono } from 'hono';
import { requireUser } from '../middleware';
import { billingGate, quota429 } from '../provider-quota';
import { int } from '../parse';
import { fail } from '../respond';
import { readPhoto, writePhoto } from '@trippy/server/photo-cache';
import { env } from '@trippy/server/env';
import type { SessionUser } from '@trippy/server/auth';

/**
 * Proxies a Google Places photo so the API key never reaches the browser.
 *
 * Both inputs are caller-supplied and both are checked before use, because this
 * endpoint turns them into a billed outbound request. `name` is a Places photo
 * resource name of the form `places/<PLACE_ID>/photos/<PHOTO_ID>` and is
 * pattern-checked; anything looser would be an SSRF hole. `w` is a pixel width
 * and is only accepted as a whole number inside the range below: `Number(w) ||
 * 640` let `-1` and `1e9` through as-is, and both are requests we pay for.
 */
const NAME_RE = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

/** Smallest useful thumbnail, and the largest width any card renders at. */
const MIN_WIDTH = 64;
const MAX_WIDTH = 1200;
const DEFAULT_WIDTH = 640;

export const placePhoto = new Hono<{ Variables: { user: SessionUser | null } }>();

/**
 * Fetches in flight, keyed by the same `name|width` the cache is.
 *
 * A card grid mounts a dozen images at once and a cold page load misses on all
 * of them, so without this the same photo is fetched, and billed, once per
 * concurrent request. Sharing the promise makes a burst cost one call. Entries
 * are removed as soon as they settle: this is a stampede guard, not a cache.
 */
const inflight = new Map<string, Promise<{ bytes: Uint8Array; type: string } | null>>();

/**
 * Photos we asked for and did not get, and when to stop remembering that.
 *
 * A reference that fails once tends to keep failing: it has been revoked, or
 * the place was edited and its photo ids changed. Retrying on every page load
 * spends quota to be told the same thing, so a failure is remembered briefly.
 * Briefly, because the other cause is a transient upstream error, and that must
 * not be turned into a permanently broken picture.
 */
const failures = new Map<string, number>();
const FAILURE_TTL_MS = 5 * 60 * 1000;

function recentlyFailed(key: string): boolean {
	const until = failures.get(key);
	if (until === undefined) return false;
	if (until > Date.now()) return true;
	failures.delete(key);
	return false;
}

async function fetchPhoto(
	name: string,
	width: number,
	cacheKey: string,
	apiKey: string
): Promise<{ bytes: Uint8Array; type: string } | null> {
	const upstream = new URL(`https://places.googleapis.com/v1/${name}/media`);
	upstream.searchParams.set('maxWidthPx', String(width));
	upstream.searchParams.set('key', apiKey);

	const res = await fetch(upstream, { redirect: 'follow' });
	if (!res.ok || !res.body) {
		failures.set(cacheKey, Date.now() + FAILURE_TTL_MS);
		return null;
	}

	// Buffered rather than streamed, because the bytes have to be kept: a
	// streamed response is spent by the time it reaches the browser and the
	// next cold load pays for it again. These are thumbnails, not files.
	const bytes = new Uint8Array(await res.arrayBuffer());
	const type = res.headers.get('content-type') ?? 'image/jpeg';
	// A cache write must never cost the caller their picture.
	try {
		writePhoto(name, width, bytes, type);
	} catch {
		/* served anyway */
	}
	return { bytes, type };
}

// Session-gated like the other places endpoints: the pictures are public, but
// every miss spends our Google quota, so this must not be an open proxy.
placePhoto.get('/', requireUser, async (c) => {
	const name = c.req.query('name') ?? '';
	if (!NAME_RE.test(name)) return fail(c, 400, 'Bad photo reference.');

	const key = env.GOOGLE_SERVER_KEY;
	if (!key) return fail(c, 404, 'Photos unavailable.');

	const asked = int(c.req.query('w'));
	const width = asked === null ? DEFAULT_WIDTH : Math.min(Math.max(asked, MIN_WIDTH), MAX_WIDTH);

	const cached = readPhoto(name, width);
	if (cached) return photo(cached.bytes, cached.contentType);

	const cacheKey = `${name}|${width}`;
	if (recentlyFailed(cacheKey)) return fail(c, 502, 'Photo fetch failed');

	let pending = inflight.get(cacheKey);
	if (!pending) {
		// Charged only when a genuinely new fetch is about to start: a cache hit
		// returned above, and a request that joins an in-flight fetch shares that
		// one call, so neither spends quota. Over the ceiling becomes a 429.
		try {
			billingGate(c, c.get('user')!.id)();
		} catch (err) {
			return quota429(c, err);
		}
		pending = fetchPhoto(name, width, cacheKey, key).finally(() => inflight.delete(cacheKey));
		inflight.set(cacheKey, pending);
	}

	// A thrown fetch must not take the request down with it, and must not leave
	// the failure unremembered either.
	const got = await pending.catch(() => {
		failures.set(cacheKey, Date.now() + FAILURE_TTL_MS);
		return null;
	});
	if (!got) return fail(c, 502, 'Photo fetch failed');
	return photo(got.bytes, got.type);
});

/**
 * The response, however the bytes were obtained.
 *
 * A photo reference's bytes are immutable, so this is cached hard. 30 days is
 * both the longest Google's terms allow Places content to be kept and long
 * enough that a returning member never re-fetches one.
 */
function photo(bytes: Uint8Array, contentType: string): Response {
	return new Response(bytes, {
		headers: {
			'content-type': contentType,
			'cache-control': 'public, max-age=2592000, immutable'
		}
	});
}
