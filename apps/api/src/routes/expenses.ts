import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, num, str, strList } from '../parse';
import type { Env } from '../types';
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

export const expenses = new Hono<Env>();

expenses.use('*', requireMember);

expenses.get('/', (c) => {
	const trip = c.get('trip');
	ensureRatesFresh();
	const home = trip.home_currency;

	return c.json({
		currency: home,
		currencies: knownCurrencies().sort(),
		members: tripMembers(trip.id),
		expenses: listExpenses(trip.id).map((e) => ({
			...e,
			home_cents: convertCents(e.amount_cents, e.currency, home),
			converted: e.currency !== home
		})),
		balances: balances(trip.id),
		settlement: settlement(trip.id)
	});
});

expenses.post('/', async (c) => {
	const trip = c.get('trip');
	const b = await body(c);

	const description = str(b.description);
	if (!description) return c.json({ error: 'Add a description.' }, 400);

	const amount = num(b.amount);
	// Income is the same record with the sign flipped: a negative amount means
	// the payer received money on the group's behalf, so participants get
	// credited rather than charged. The sign comes from the amount itself; there
	// is no separate "this is income" flag to get out of step with it. Zero is
	// the one value that says nothing either way, so it is rejected.
	if (amount === null || Math.round(amount * 100) === 0) {
		return c.json({ error: 'Enter an amount.' }, 400);
	}
	const cents = Math.round(amount * 100);

	const participantIds = strList(b.participantIds);
	if (!participantIds.length) return c.json({ error: 'Pick who shares this.' }, 400);

	const rawMode = str(b.splitMode) || 'even';
	const splitMode: SplitMode = isSplitMode(rawMode) ? rawMode : 'even';

	// Per-participant weights, keyed by user id. The SvelteKit form flattened
	// these into `w:<userId>` fields because FormData has no nested values; JSON
	// does, so the map is the honest shape.
	const weights = (b.weights ?? {}) as Record<string, unknown>;

	const parts = participantIds.map((userId) => {
		if (splitMode === 'even') return { userId, weight: 1 };
		const raw = num(weights[userId]) ?? 0;
		// `shares` is a count; `exact` is an amount, stored in cents.
		return { userId, weight: splitMode === 'exact' ? Math.round(raw * 100) : raw };
	});

	if (splitMode !== 'even' && !parts.some((p) => p.weight > 0)) {
		return c.json(
			{ error: splitMode === 'exact' ? 'Enter at least one amount.' : 'Enter at least one share.' },
			400
		);
	}
	if (splitMode === 'exact') {
		const sum = parts.reduce((a, p) => a + Math.max(0, p.weight), 0);
		if (sum !== Math.abs(cents)) {
			return c.json(
				{
					error: `Amounts add up to ${(sum / 100).toFixed(2)}, but the total is ${Math.abs(
						cents / 100
					).toFixed(2)}.`
				},
				400
			);
		}
	}

	const id = addExpense(
		trip.id,
		c.get('user').id,
		str(b.payerId),
		description,
		cents,
		str(b.currency) || trip.home_currency,
		parts,
		splitMode
	);
	if (!id) return c.json({ error: 'Could not add expense.' }, 400);
	return c.json({ id }, 201);
});

expenses.delete('/:expenseId', (c) => {
	deleteExpense(c.get('trip').id, c.get('user').id, c.req.param('expenseId'));
	return c.json({ ok: true });
});
