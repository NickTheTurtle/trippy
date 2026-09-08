import { error, redirect } from '@sveltejs/kit';
import { getTripForUser } from '@trippy/server/trips';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, params }) => {
	if (!locals.user) throw redirect(303, '/login');
	const trip = getTripForUser(params.tripId, locals.user.id);
	if (!trip) throw error(404, 'Trip not found');
	return { trip };
};
