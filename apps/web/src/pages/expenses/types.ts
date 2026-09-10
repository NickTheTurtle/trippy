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
	created_at: number;
	home_cents: number;
	converted: boolean;
	/** Home-currency cents this expense charges each participant, keyed by user id. */
	shares: Record<string, number>;
	/** The stored stakes, as typed, so the edit dialog can prefill them. */
	parts: { userId: string; weight: number }[];
};
export type ExpensesData = {
	currency: string;
	currencies: string[];
	members: Member[];
	expenses: Expense[];
	/** `netCents` is the exact figure; the major-unit `net` beside it is a shim. */
	balances: { id: string; name: string; netCents: number }[];
	settlement: Transfer[];
	me: string;
};
export type Transfer = {
	fromId: string;
	toId: string;
	from: string;
	to: string;
	amountCents: number;
};
