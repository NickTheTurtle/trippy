import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Costs merged into Preparation; kept so old links/bookmarks still land somewhere. */
export const load: PageServerLoad = ({ params }) => {
	redirect(307, `/trips/${params.tripId}/pretrip`);
};
