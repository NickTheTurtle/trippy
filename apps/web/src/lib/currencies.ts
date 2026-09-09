import type { Option } from '../components/ui/Select';

/**
 * The currency choices, in one place.
 *
 * There were two lists: `Expenses` renders whatever `GET /expenses` returns
 * (the server's rate table, which is authoritative and grows once live rates
 * land), while `TripShell`'s edit dialog carried its own hardcoded array. The
 * trip-create form has no trip yet, so it has no server list to read, and
 * adding a third copy is exactly the divergence to avoid: the codes below are
 * the ones that were already inline in `TripShell`, moved here verbatim and now
 * shared by both places that pick a *home* currency.
 *
 * `currencyOptions` is what keeps the option shape identical everywhere, so a
 * caller that does have a server list (Expenses) still builds its dropdown the
 * same way rather than mapping by hand.
 */
export const CURRENCY_CODES = [
	'USD',
	'EUR',
	'GBP',
	'JPY',
	'CAD',
	'AUD',
	'CHF',
	'CNY',
	'INR',
	'MXN',
	'SEK',
	'NZD',
	'SGD',
	'ZAR',
	'BRL'
];

/** Options for `Select`. Pass the server's list when there is one. */
export function currencyOptions(codes: readonly string[] = CURRENCY_CODES): Option[] {
	return codes.map((c) => ({ value: c, label: c }));
}
