import { fail, redirect } from '@sveltejs/kit';
import { getTripForUser } from '$lib/server/trips';
import {
	inviteToTrip,
	isOrganizer,
	listPeople,
	listPendingInvites,
	removeMember,
	revokeInvite
} from '$lib/server/members';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	if (!locals.user) throw redirect(303, '/login');
	const trip = getTripForUser(params.tripId, locals.user.id);
	if (!trip) throw redirect(303, '/trips');

	const organizer = isOrganizer(trip.id, locals.user.id);
	return {
		me: locals.user.id,
		organizer,
		people: listPeople(trip.id),
		invites: organizer ? listPendingInvites(trip.id) : []
	};
};

export const actions: Actions = {
	invite: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');

		const form = await request.formData();
		const email = String(form.get('email') ?? '');
		const result = inviteToTrip(trip.id, locals.user.id, email);

		switch (result) {
			case 'added':
				return { ok: true, message: `${email.trim()} was added to the trip.` };
			case 'invited':
				return { ok: true, message: `Invite sent to ${email.trim()}. They'll join when they register.` };
			case 'exists':
				return fail(400, { error: 'That person is already a member or invited.' });
			default:
				return fail(400, { error: 'Enter a valid email address. Only the organizer can invite.' });
		}
	},

	remove: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');

		const form = await request.formData();
		const userId = String(form.get('userId') ?? '');
		if (userId && !removeMember(trip.id, locals.user.id, userId)) {
			return fail(400, { error: 'Could not remove that member.' });
		}
		return { ok: true };
	},

	revoke: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');

		const form = await request.formData();
		const inviteId = String(form.get('inviteId') ?? '');
		if (inviteId) revokeInvite(trip.id, locals.user.id, inviteId);
		return { ok: true };
	}
};
