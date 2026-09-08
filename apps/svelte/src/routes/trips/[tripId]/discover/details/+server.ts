import { json, error } from '@sveltejs/kit';
import { getTripForUser } from '$lib/server/trips';
import { placeDetailsCached } from '$lib/server/places';
import type { RequestHandler } from './$types';

/**
 * The expensive half of the split search: ratings, price, hours, website and
 * photo for the one place a member has actually clicked. Kept off the search
 * endpoint so typing never buys this for eight results at once.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) throw error(401, 'Sign in');
	// Membership is checked even though the data is public: this endpoint spends
	// our API quota, so it must not be an open proxy to Google.
	if (!getTripForUser(params.tripId, locals.user.id)) throw error(404, 'No trip');

	const id = url.searchParams.get('id')?.trim() ?? '';
	if (!id) throw error(400, 'Missing id');

	try {
		return json({ details: await placeDetailsCached(id) });
	} catch {
		// A failed enrichment is not a failed search; the caller still has the
		// name, address and pin, so let it show the result without the extras.
		return json({ details: null });
	}
};
