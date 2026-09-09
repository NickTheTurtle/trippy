import { Hono } from 'hono';
import { requireUser } from '../middleware';
import { int } from '../parse';
import { fail } from '../respond';

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
	const upstream = new URL(`https://places.googleapis.com/v1/${name}/media`);
	upstream.searchParams.set('maxWidthPx', String(width));
	upstream.searchParams.set('key', key);

	const res = await fetch(upstream, { redirect: 'follow' });
	if (!res.ok || !res.body) return fail(c, 502, 'Photo fetch failed');

	return new Response(res.body, {
		headers: {
			'content-type': res.headers.get('content-type') ?? 'image/jpeg',
			// Place photos are immutable for the lifetime of the reference, so let
			// the browser and any CDN keep them for a day.
			'cache-control': 'public, max-age=86400'
		}
	});
});
