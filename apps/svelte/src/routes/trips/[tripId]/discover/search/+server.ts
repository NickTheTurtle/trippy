import { json, error } from '@sveltejs/kit';
import { getTripForUser } from '$lib/server/trips';
import { db } from '$lib/server/db';
import { searchPlaces, MIN_QUERY, type SearchKind } from '$lib/server/places';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) throw error(401, 'Sign in');
	const trip = getTripForUser(params.tripId, locals.user.id);
	if (!trip) throw error(404, 'No trip');

	const q = url.searchParams.get('q')?.trim() ?? '';
	const cityId = url.searchParams.get('cityId') ?? '';
	const kind: SearchKind = url.searchParams.get('kind') === 'stay' ? 'stay' : 'place';
	if (q.length < MIN_QUERY) return json({ results: [] });

	const city = db
		.prepare(`SELECT name, country FROM cities WHERE id = ? AND trip_id = ?`)
		.get(cityId, trip.id) as { name: string; country: string } | undefined;
	if (!city) throw error(400, 'Unknown city');

	const results = await searchPlaces(q, { city: city.name, country: city.country }, kind);
	return json({ results });
};
