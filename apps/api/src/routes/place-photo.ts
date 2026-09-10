import { Hono } from 'hono';
import { requireUser } from '../middleware';
import { int } from '../parse';
import { fail } from '../respond';
import { readPhoto, writePhoto } from '@trippy/server/photo-cache';

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

export const placePhoto = new Hono();

// Session-gated like the other places endpoints: the pictures are public, but
// every miss spends our Google quota, so this must not be an open proxy.
placePhoto.get('/', requireUser, async (c) => {
	const name = c.req.query('name') ?? '';
	if (!NAME_RE.test(name)) return fail(c, 400, 'Bad photo reference');

	const key = process.env.GOOGLE_PLACES_KEY;
	if (!key) return fail(c, 404, 'Photos unavailable');

	const asked = int(c.req.query('w'));
	const width =
		asked === null ? DEFAULT_WIDTH : Math.min(Math.max(asked, MIN_WIDTH), MAX_WIDTH);

	const cached = readPhoto(name, width);
	if (cached) return photo(cached.bytes, cached.contentType);

	const upstream = new URL(`https://places.googleapis.com/v1/${name}/media`);
	upstream.searchParams.set('maxWidthPx', String(width));
	upstream.searchParams.set('key', key);

	const res = await fetch(upstream, { redirect: 'follow' });
	if (!res.ok || !res.body) return fail(c, 502, 'Photo fetch failed');

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
	return photo(bytes, type);
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
