/**
 * How an expense is divided between its participants.
 * - `even`   means equal shares.
 * - `shares` means weighted shares (e.g. a couple counts as 2, a room of 3 counts as 3).
 * - `exact`  means each participant owes a stated amount; the amounts must add up
 *              to the expense total.
 *
 * All three collapse to a single representation: a non-negative weight per
 * participant. `even` stores 1 for everyone, `shares` stores the share count,
 * and `exact` stores the stated amount in cents. Splitting is then always
 * "divide the total in proportion to the weights", which keeps balances exact
 * for every mode, including after currency conversion, because the conversion
 * happens on the total before the split rather than on each share.
 */
export type SplitMode = 'even' | 'shares' | 'exact';

export const SPLIT_MODES: SplitMode[] = ['even', 'shares', 'exact'];

export function isSplitMode(v: string): v is SplitMode {
	return (SPLIT_MODES as string[]).includes(v);
}

/**
 * Divide `totalCents` in proportion to `weights`, returning whole cents that
 * sum back to `totalCents` exactly.
 *
 * Remainder cents go to the participants with the largest fractional part
 * (ties broken by original order), which is the standard largest-remainder
 * apportionment. Works for negative totals: an income/refund is distributed
 * with the same proportions and the same exact-sum guarantee.
 */
export function splitByWeight(totalCents: number, weights: number[]): number[] {
	const n = weights.length;
	if (n === 0) return [];

	const sign = totalCents < 0 ? -1 : 1;
	const total = Math.abs(Math.round(totalCents));

	let safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
	let sum = safe.reduce((a, b) => a + b, 0);
	// Every weight is finite, but two of `1e308` still sum to Infinity, and one
	// of them times a large total overflows even when the sum does not. Either
	// turns every share below into NaN. Scaling by the largest weight keeps the
	// proportions and brings every product back into range; ordinary weights
	// never reach this branch, so their rounding is untouched.
	const max = safe.reduce((a, b) => Math.max(a, b), 0);
	if (max > 0 && (!Number.isFinite(sum) || !Number.isFinite(total * max))) {
		safe = safe.map((w) => w / max);
		sum = safe.reduce((a, b) => a + b, 0);
	}
	// No usable weights: fall back to an even split so nothing is silently dropped.
	const eff = sum > 0 ? safe : new Array(n).fill(1);
	const effSum = sum > 0 ? sum : n;

	const exact = eff.map((w) => (total * w) / effSum);
	const floors = exact.map((v) => Math.floor(v));
	let remainder = total - floors.reduce((a, b) => a + b, 0);

	const order = exact
		.map((v, i) => ({ i, frac: v - Math.floor(v) }))
		.sort((a, b) => b.frac - a.frac || a.i - b.i);

	const out = floors.slice();
	for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
		out[order[k].i] += 1;
	}
	return out.map((v) => v * sign);
}
