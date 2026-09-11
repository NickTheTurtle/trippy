import type { Option } from '../components/ui/Select';
import { CURRENCY_CODES } from '@trippy/core/currency';

export { CURRENCY_CODES };

/**
 * The currency choices, in one place.
 *
 * The list itself lives in `@trippy/core/currency`, beside the offline rate
 * table, because a currency the app offers but cannot convert is worse than
 * one it does not offer at all: see the note there.
 *
 * `currencyOptions` is what keeps the option shape identical everywhere, so a
 * caller that does have a server list (Expenses, which renders whatever
 * `GET /expenses` returns once live rates land) still builds its dropdown the
 * same way rather than mapping by hand.
 */

/** Options for `Select`. Pass the server's list when there is one. */
export function currencyOptions(codes: readonly string[] = CURRENCY_CODES): Option[] {
	return codes.map((c) => ({ value: c, label: c }));
}
