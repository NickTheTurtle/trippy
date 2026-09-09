import { Hono } from 'hono';
import { requireUser } from '../middleware';

/**
 * Proxies a Google Places photo so the API key never reaches the browser.
 *
 * `name` is a Places photo resource name of the form
 * `places/<PLACE_ID>/photos/<PHOTO_ID>`. It is pattern-checked before use: this
 * endpoint turns a caller-supplied string into an outbound request, so anything
 * looser would be an SSRF hole.
 */
const NAME_RE = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

export const placePhoto = new Hono();

// Session-gated like the other places endpoints: the pictures are public, but
// every miss spends our Google quota, so this must not be an open proxy.
placePhoto.get('/', requireUser, async (c) => {
	const name = c.req.query('name') ?? '';
	if (!NAME_RE.test(name)) return c.json({ error: 'Bad photo reference' }, 400);

	const key = process.env.GOOGLE_PLACES_KEY;
	if (!key) return c.json({ error: 'Photos unavailable' }, 404);

	const width = Math.min(Number(c.req.query('w')) || 640, 1200);
	const upstream = new URL(`https://places.googleapis.com/v1/${name}/media`);
	upstream.searchParams.set('maxWidthPx', String(width));
	upstream.searchParams.set('key', key);

	const res = await fetch(upstream, { redirect: 'follow' });
	if (!res.ok || !res.body) return c.json({ error: 'Photo fetch failed' }, 502);

	return new Response(res.body, {
		headers: {
			'content-type': res.headers.get('content-type') ?? 'image/jpeg',
			// Place photos are immutable for the lifetime of the reference, so let
			// the browser and any CDN keep them for a day.
			'cache-control': 'public, max-age=86400'
		}
	});
});
