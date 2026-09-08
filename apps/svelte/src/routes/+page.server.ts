import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** The marketing page is only useful to signed-out visitors. */
export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) redirect(307, '/trips');
};
