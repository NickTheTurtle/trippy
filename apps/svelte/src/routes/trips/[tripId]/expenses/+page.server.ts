import { fail, redirect } from '@sveltejs/kit';
import { getTripForUser } from '@trippy/server/trips';
import {
	addExpense,
	balances,
	deleteExpense,
	listExpenses,
	settlement,
	tripMembers
} from '@trippy/server/expenses';
import { convertCents, ensureRatesFresh, knownCurrencies } from '@trippy/server/fx';
import { isSplitMode, type SplitMode } from '@trippy/core/split';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	if (!locals.user) throw redirect(303, '/login');
	const trip = getTripForUser(params.tripId, locals.user.id);
	if (!trip) throw redirect(303, '/trips');

	ensureRatesFresh();
	const home = trip.home_currency;
	const expenses = listExpenses(trip.id).map((e) => ({
		...e,
		home_cents: convertCents(e.amount_cents, e.currency, home),
		converted: e.currency !== home
	}));

	return {
		currency: home,
		currencies: knownCurrencies().sort(),
		members: tripMembers(trip.id),
		expenses,
		balances: balances(trip.id),
		settlement: settlement(trip.id)
	};
};

export const actions: Actions = {
	add: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');

		const form = await request.formData();
		const description = String(form.get('description') ?? '').trim();
		const payerId = String(form.get('payerId') ?? '');
		const amount = Number(form.get('amount'));
		const currency = String(form.get('currency') ?? trip.home_currency) || trip.home_currency;
		const rawMode = String(form.get('splitMode') ?? 'even');
		const splitMode: SplitMode = isSplitMode(rawMode) ? rawMode : 'even';
		const participantIds = form.getAll('participantIds').map(String);

		if (!description) return fail(400, { error: 'Add a description.' });
		if (!Number.isFinite(amount) || Math.round(amount * 100) === 0) {
			return fail(400, { error: 'Enter an amount.' });
		}
		if (participantIds.length === 0) return fail(400, { error: 'Pick who shares this.' });

		// Income is the same record with the sign flipped: a negative amount means
		// the payer received money on the group's behalf, so participants get
		// credited rather than charged. The sign comes from the amount itself;
		// there is no separate "this is income" flag to get out of step with it.
		const cents = Math.round(amount * 100);

		const parts = participantIds.map((userId) => {
			if (splitMode === 'even') return { userId, weight: 1 };
			const raw = Number(form.get(`w:${userId}`));
			// `shares` is a count; `exact` is an amount, stored in cents.
			const weight = splitMode === 'exact' ? Math.round((raw || 0) * 100) : raw || 0;
			return { userId, weight };
		});

		if (splitMode !== 'even' && !parts.some((p) => p.weight > 0)) {
			return fail(400, {
				error: splitMode === 'exact' ? 'Enter at least one amount.' : 'Enter at least one share.'
			});
		}
		if (splitMode === 'exact') {
			const sum = parts.reduce((a, p) => a + Math.max(0, p.weight), 0);
			if (sum !== Math.abs(cents)) {
				return fail(400, {
					error: `Amounts add up to ${(sum / 100).toFixed(2)}, but the total is ${Math.abs(
						cents / 100
					).toFixed(2)}.`
				});
			}
		}

		const id = addExpense(
			trip.id,
			locals.user.id,
			payerId,
			description,
			cents,
			currency,
			parts,
			splitMode
		);
		if (!id) return fail(400, { error: 'Could not add expense.' });
		return { ok: true };
	},

	remove: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');

		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		if (id) deleteExpense(trip.id, locals.user.id, id);
		return { ok: true };
	}
};
