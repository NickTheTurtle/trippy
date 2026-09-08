import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** The trip index has no page of its own; Discover is the landing tab. */
export const load: PageServerLoad = ({ params }) => {
	throw redirect(307, `/trips/${params.tripId}/discover`);
};
