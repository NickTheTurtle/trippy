import { json, error } from '@sveltejs/kit';
import { searchCities } from '$lib/server/geocode';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Sign in required');
	const q = url.searchParams.get('q') ?? '';
	const results = await searchCities(q);
	return json(results);
};
