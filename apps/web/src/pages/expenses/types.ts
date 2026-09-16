import type { SplitMode } from '@trippy/core/split';

/**
 * The shape of `GET /trips/:id/expenses`: the ledger, the balances it nets out
 * to, and the transfers that would clear them.
 */
export type Member = { id: string; name: string };
export type Expense = {
	id: string;
	description: string;
	payer_name: string;
	payer_id: string;
	amount_cents: number;
	currency: string;
	split_mode: SplitMode;
	participants: number;
	settlement: number;
	/**
	 * The day the money moved, `YYYY-MM-DD`. Distinct from `created_at`, which is
	 * when the row was typed in: an expense logged after the trip is over is
	 * still an expense from the day it happened, and the ledger is ordered by
	 * this rather than by when somebody got round to entering it.
	 */
	spent_on: string;
	created_at: number;
	home_cents: number;
	converted: boolean;
	/** Home-currency cents this expense charges each participant, keyed by user id. */
	shares: Record<string, number>;
	/** The stored stakes, as typed, so the edit dialog can prefill them. */
	parts: { userId: string; weight: number }[];
	/** Bumped on every save; sent back on edit so a stale write is refused. */
	version: number;
	/**
	 * The payer or one of the participants is no longer on the trip, and their
	 * stake could not be re-divided automatically. Derived per request, so it
	 * clears by itself once the expense is edited or the person re-invited.
	 */
	needsReview: boolean;
};
export type ExpensesData = {
	currency: string;
	currencies: string[];
	members: Member[];
	expenses: Expense[];
	/**
	 * `netCents` is the exact figure; the major-unit `net` beside it is a shim.
	 * `former` marks somebody who has left the trip but still has money in it:
	 * shown rather than dropped, because a total that quietly stops summing to
	 * zero is the worse failure.
	 */
	balances: { id: string; name: string; netCents: number; former: boolean }[];
	settlement: Transfer[];
	me: string;
};
export type Transfer = {
	fromId: string;
	toId: string;
	from: string;
	to: string;
	amountCents: number;
	/** Idempotency key for `POST /expenses/settle`; see `settlementToken`. */
	token: string;
};
