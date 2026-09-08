import { fail, redirect } from '@sveltejs/kit';
import { updateTrip } from '$lib/server/trips';
import type { Actions, PageServerLoad } from './$types';

/**
 * Action-only route. The Edit trip modal lives in the trip layout, so it is
 * rendered on every tab and cannot own an action itself (only pages have
 * actions). The form posts here cross-route via `action="…/settings?/edit"`.
 */
export const load: PageServerLoad = ({ params }) => {
	throw redirect(303, `/trips/${params.tripId}/discover`);
};

export const actions: Actions = {
	edit: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const form = await request.formData();
		const problem = updateTrip(params.tripId, locals.user.id, {
			name: String(form.get('name') ?? ''),
			startDate: String(form.get('startDate') ?? '').trim() || null,
			endDate: String(form.get('endDate') ?? '').trim() || null,
			currency: String(form.get('currency') ?? '')
		});
		if (problem) return fail(400, { error: problem });
		return { ok: true };
	}
};
