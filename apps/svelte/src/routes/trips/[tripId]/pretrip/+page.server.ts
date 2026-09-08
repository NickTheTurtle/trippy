import { fail, redirect } from '@sveltejs/kit';
import { getTripForUser } from '@trippy/server/trips';
import { addTask, listTasks, removeTask, toggleTask } from '@trippy/server/tasks';
import {
	COST_CATEGORIES,
	getItemizedBudget,
	addCostItem,
	updateCostItem,
	removeCostItem
} from '@trippy/server/costs';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	if (!locals.user) throw redirect(303, '/login');
	const trip = getTripForUser(params.tripId, locals.user.id);
	if (!trip) throw redirect(303, '/trips');

	return {
		me: locals.user.id,
		members: trip.memberList.map((m) => ({ id: m.id, name: m.name })),
		tasks: listTasks(trip.id, 'task'),
		packing: listTasks(trip.id, 'packing'),
		currency: trip.home_currency,
		memberCount: trip.members.length,
		categories: [...COST_CATEGORIES],
		cities: trip.cities.map((c) => ({ id: c.id, name: c.name })),
		budget: getItemizedBudget(trip.id)
	};
};

function readItem(form: FormData) {
	const cityId = String(form.get('cityId') ?? '').trim() || null;
	const category = String(form.get('category') ?? '').trim();
	const label = String(form.get('label') ?? '').trim();
	const cents = Math.round(Number(form.get('amount')) * 100);
	return { cityId, category, label, cents };
}

export const actions: Actions = {
	add: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');

		const form = await request.formData();
		const kind = String(form.get('kind') ?? 'task') === 'packing' ? 'packing' : 'task';
		const label = String(form.get('label') ?? '').trim();
		const assignees = form.getAll('assignee').map((v) => String(v));
		if (!label) return fail(400, { error: 'Describe the task.' });
		addTask(trip.id, locals.user.id, kind, label, assignees, null);
		return { ok: true };
	},

	/**
	 * Ticks one person's box. `userId` is optional and defaults to the caller;
	 * tasks.ts refuses to complete someone else's share regardless.
	 */
	toggle: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const userId = String(form.get('userId') ?? '') || undefined;
		if (!id) return fail(400, { error: 'Missing task.' });
		if (!toggleTask(trip.id, locals.user.id, id, userId))
			return fail(403, { error: 'You can only tick your own box.' });
		return { ok: true };
	},

	remove: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		if (id) removeTask(trip.id, locals.user.id, id);
		return { ok: true };
	},

	addCost: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const item = readItem(await request.formData());
		if (!Number.isFinite(item.cents)) return fail(400, { error: 'Enter a valid amount.' });
		if (!addCostItem(trip.id, locals.user.id, item))
			return fail(400, { error: 'Could not add that item.' });
		return { ok: true };
	},

	saveCost: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const id = String(form.get('itemId') ?? '');
		const item = readItem(form);
		if (!Number.isFinite(item.cents)) return fail(400, { error: 'Enter a valid amount.' });
		if (!updateCostItem(trip.id, locals.user.id, id, item))
			return fail(400, { error: 'Could not save that item.' });
		return { ok: true };
	},

	removeCost: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		removeCostItem(trip.id, locals.user.id, String(form.get('itemId') ?? ''));
		return { ok: true };
	}
};
