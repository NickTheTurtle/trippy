import { fail, redirect } from '@sveltejs/kit';
import { createTrip, listTripsForUser } from '@trippy/server/trips';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	return { trips: listTripsForUser(locals.user.id) };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const dates = String(form.get('dates') ?? '').trim();
		const currency = String(form.get('currency') ?? 'USD').trim() || 'USD';

		if (!name) return fail(400, { error: 'Give your trip a name.' });

		const id = createTrip(locals.user.id, name, dates || 'Dates to be set', currency);
		throw redirect(303, `/trips/${id}`);
	}
};
