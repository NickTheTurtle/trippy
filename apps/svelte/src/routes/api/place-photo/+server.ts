import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

/**
 * Proxies a Google Places photo so the API key never reaches the browser.
 *
 * `name` is a Places photo resource name of the form
 * `places/<PLACE_ID>/photos/<PHOTO_ID>`. It is pattern-checked before use: this
 * endpoint turns a caller-supplied string into an outbound request, so anything
 * looser would be an SSRF hole.
 */
const NAME_RE = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

export const GET: RequestHandler = async ({ url, fetch, setHeaders }) => {
	const name = url.searchParams.get('name') ?? '';
	if (!NAME_RE.test(name)) throw error(400, 'Bad photo reference');

	const key = env.GOOGLE_PLACES_KEY;
	if (!key) throw error(404, 'Photos unavailable');

	const width = Math.min(Number(url.searchParams.get('w')) || 640, 1200);
	const upstream = new URL(`https://places.googleapis.com/v1/${name}/media`);
	upstream.searchParams.set('maxWidthPx', String(width));
	upstream.searchParams.set('key', key);

	const res = await fetch(upstream, { redirect: 'follow' });
	if (!res.ok) throw error(502, 'Photo fetch failed');

	// Place photos are immutable for the lifetime of the reference, so let the
	// browser and any CDN keep them for a day.
	setHeaders({ 'cache-control': 'public, max-age=86400' });
	return new Response(res.body, {
		headers: { 'content-type': res.headers.get('content-type') ?? 'image/jpeg' }
	});
};
