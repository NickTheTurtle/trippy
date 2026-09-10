import { Hono, type Context } from 'hono';
import { requireMember } from '../middleware';
import { body, int, num, optStr, record, str, strList } from '../parse';
import { fail, okOr } from '../respond';
import type { Env } from '../types';
import {
	addExpense,
	balances,
	deleteExpense,
	expenseShares,
	listExpenses,
	recordSettlement,
	settlement,
	tripMembers,
	updateExpense
} from '@trippy/server/expenses';
import { convertCents, ensureRatesFresh, knownCurrencies } from '@trippy/server/fx';
import { isSplitMode, type SplitMode } from '@trippy/core/split';

export const expenses = new Hono<Env>();

expenses.use('*', requireMember);

interface ParsedExpense {
	description: string;
	cents: number;
	currency: string;
	payerId: string;
	splitMode: SplitMode;
	parts: { userId: string; weight: number }[];
	/** The version the editor had on screen, or null when not tracking. */
	version: number | null;
}

/**
 * Reads and checks the body an expense is written from. Adding and editing take
 * exactly the same shape, so they share the rules rather than drifting apart.
 */
async function parseExpense(
	c: Context<Env>,
	home: string
): Promise<ParsedExpense | { error: string }> {
	const b = await body(c);

	const description = str(b.description);
	if (!description) return { error: 'Add a description.' };

	const amount = num(b.amount);
	// Income is the same record with the sign flipped: a negative amount means
	// the payer received money on the group's behalf, so participants get
	// credited rather than charged. The sign comes from the amount itself; there
	// is no separate "this is income" flag to get out of step with it. Zero is
	// the one value that says nothing either way, so it is rejected.
	if (amount === null || Math.round(amount * 100) === 0) return { error: 'Enter an amount.' };
	const cents = Math.round(amount * 100);

	const participantIds = strList(b.participantIds);
	if (!participantIds.length) return { error: 'Pick who shares this.' };

	const rawMode = str(b.splitMode) || 'even';
	const splitMode: SplitMode = isSplitMode(rawMode) ? rawMode : 'even';

	// Per-participant weights, keyed by user id. The SvelteKit form flattened
	// these into `w:<userId>` fields because FormData has no nested values; JSON
	// does, so the map is the honest shape. It is validated rather than asserted:
	// an array or a string arriving here must not be indexed as though it were a
	// map of weights.
	const weights = record(b.weights);

	const parts = participantIds.map((userId) => {
		if (splitMode === 'even') return { userId, weight: 1 };
		const raw = num(weights[userId]) ?? 0;
		// `shares` is a count; `exact` is an amount, stored in cents.
		return { userId, weight: splitMode === 'exact' ? Math.round(raw * 100) : raw };
	});

	if (splitMode !== 'even' && !parts.some((p) => p.weight > 0)) {
		return {
			error: splitMode === 'exact' ? 'Enter at least one amount.' : 'Enter at least one share.'
		};
	}
	if (splitMode === 'exact') {
		const sum = parts.reduce((a, p) => a + Math.max(0, p.weight), 0);
		if (sum !== Math.abs(cents)) {
			return {
				error: `Amounts add up to ${(sum / 100).toFixed(2)}, but the total is ${Math.abs(
					cents / 100
				).toFixed(2)}.`
			};
		}
	}

	return {
		description,
		cents,
		currency: str(b.currency) || home,
		payerId: str(b.payerId),
		splitMode,
		parts,
		version: int(b.version)
	};
}

expenses.get('/', (c) => {
	const trip = c.get('trip');
	ensureRatesFresh();
	const home = trip.home_currency;
	// One pass over the ledger, shared by the rows, the balances and the
	// suggested transfers. They must agree, and computing each from scratch was
	// both three times the work and three chances to disagree.
	const splits = expenseShares(trip.id);
	const bals = balances(trip.id, splits);

	return c.json({
		currency: home,
		currencies: knownCurrencies().sort(),
		members: tripMembers(trip.id),
		expenses: listExpenses(trip.id).map((e) => {
			const split = splits.get(e.id);
			return {
				...e,
				// The rate the expense was recorded at, via the same division the
				// balances are built from. Converting again here would use today's
				// rate, so a euro dinner entered last month would show a home-currency
				// total that its own shares, and the balances, disagreed with.
				home_cents: split?.totalCents ?? convertCents(e.amount_cents, e.currency, home),
				converted: e.currency !== home,
				shares: split?.shares ?? {},
				parts: split?.parts ?? []
			};
		}),
		balances: bals,
		settlement: settlement(trip.id, bals),
		me: c.get('user').id
	});
});

expenses.post('/', async (c) => {
	const trip = c.get('trip');
	const parsed = await parseExpense(c, trip.home_currency);
	if ('error' in parsed) return fail(c, 400, parsed.error);

	const id = addExpense(
		trip.id,
		c.get('user').id,
		parsed.payerId,
		parsed.description,
		parsed.cents,
		parsed.currency,
		parsed.parts,
		parsed.splitMode
	);
	if (!id) return fail(c, 400, 'Could not add expense.');
	return c.json({ id }, 201);
});

expenses.put('/:expenseId', async (c) => {
	const trip = c.get('trip');
	const parsed = await parseExpense(c, trip.home_currency);
	if ('error' in parsed) return fail(c, 400, parsed.error);

	const result = updateExpense(
		trip.id,
		c.get('user').id,
		c.req.param('expenseId'),
		parsed.payerId,
		parsed.description,
		parsed.cents,
		parsed.currency,
		parsed.parts,
		parsed.splitMode,
		parsed.version
	);
	if (!result.ok) {
		return result.reason === 'conflict'
			? fail(c, 409, 'Someone else changed this expense. Reload to see their version.')
			: fail(c, 404, 'Could not save that expense.');
	}
	return c.json({ ok: true, version: result.version });
});

/**
 * Records one of the suggested transfers as having been paid.
 *
 * The amount comes from the request rather than being recomputed, so that what
 * gets written is the number the member was looking at when they pressed the
 * button. A stale figure is caught by the balances simply not clearing, which is
 * visible on the same screen.
 *
 * `amountCents` is the field to send: settlement is computed in whole cents, so
 * a transfer quoted straight back in cents clears a balance exactly, while a
 * major-unit `amount` has to be multiplied and rounded on the way in. `amount`
 * is still accepted, and used only when `amountCents` is absent, so an older
 * client keeps working.
 *
 * `token` is the one carried on the suggestion. Sending it makes the call
 * idempotent, which is what stops a second press (or a second member pressing
 * at the same moment) recording the same payment twice and inverting the debt.
 * A repeat answers 200 with `duplicate: true` rather than 201, so the client
 * can tell "already done" from "just done" without a refetch.
 */
expenses.post('/settle', async (c) => {
	const trip = c.get('trip');
	const b = await body(c);

	const cents = b.amountCents === undefined ? null : int(b.amountCents);
	const major = num(b.amount);
	const amountCents =
		b.amountCents !== undefined ? cents : major === null ? null : Math.round(major * 100);
	if (amountCents === null || amountCents <= 0) return fail(c, 400, 'Enter an amount.');

	const result = recordSettlement(
		trip.id,
		c.get('user').id,
		str(b.fromId),
		str(b.toId),
		amountCents,
		optStr(b.token)
	);
	if (!result) return fail(c, 400, 'Could not record that payment.');
	return c.json({ id: result.id, duplicate: result.duplicate }, result.duplicate ? 200 : 201);
});

expenses.delete('/:expenseId', (c) =>
	okOr(
		c,
		deleteExpense(c.get('trip').id, c.get('user').id, c.req.param('expenseId')),
		404,
		'Could not delete that expense.'
	)
);
