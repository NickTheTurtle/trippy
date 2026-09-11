import { describe, expect, it } from 'vitest';
import { isSplitMode, splitByWeight, SPLIT_MODES, type SplitMode } from '@trippy/core/split';

function expectExactSum(totalCents: number, weights: number[]) {
	const parts = splitByWeight(totalCents, weights);
	expect(parts.reduce((sum, part) => sum + part, 0)).toBe(Math.round(totalCents));
	return parts;
}

describe('split modes', () => {
	it('recognizes every supported split mode', () => {
		expect(SPLIT_MODES).toEqual(['even', 'shares', 'exact'] satisfies SplitMode[]);
		for (const mode of SPLIT_MODES) {
			expect(isSplitMode(mode)).toBe(true);
		}
		expect(isSplitMode('percentage')).toBe(false);
	});
});

describe('splitByWeight', () => {
	it('splits even mode weights and assigns remainder cents by order', () => {
		expect(expectExactSum(100, [1, 1, 1])).toEqual([34, 33, 33]);
	});

	it('splits shares mode weights proportionally', () => {
		expect(expectExactSum(1000, [2, 1, 1])).toEqual([500, 250, 250]);
	});

	it('splits exact mode weights back to exact cents when they match the total', () => {
		expect(expectExactSum(700, [123, 234, 343])).toEqual([123, 234, 343]);
	});

	it('preserves exact totals for uneven weighted remainders', () => {
		expect(expectExactSum(101, [3, 2, 1])).toEqual([50, 34, 17]);
	});

	it('preserves exact totals for negative amounts', () => {
		expect(expectExactSum(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
	});

	it('falls back to an even split when no positive weights are usable', () => {
		expect(expectExactSum(5, [0, -1, Number.NaN])).toEqual([2, 2, 1]);
	});

	it('returns an empty split for no participants', () => {
		expect(splitByWeight(100, [])).toEqual([]);
	});
});

/**
 * The inputs a real ledger produces at its extremes.
 *
 * Every case here asserts the same invariant as the ordinary ones: the parts
 * add back to the total, exactly. That is the property the balances depend on,
 * and the interesting thing about an edge is whether it still holds there.
 */
describe('splitByWeight at its limits', () => {
	it('gives a single cent to one person rather than losing it', () => {
		// Four ways to divide one cent, none of them fair, all of them exact.
		expect(expectExactSum(1, [1, 1, 1, 1])).toEqual([1, 0, 0, 0]);
	});

	it('gives one participant the whole amount', () => {
		expect(expectExactSum(12345, [1])).toEqual([12345]);
	});

	it('charges nothing to a participant with no weight, without dropping their slot', () => {
		// Someone can be on an expense for zero: a shares split where a child
		// counts as 0, or an exact split where one person paid their part up
		// front. The slot has to survive, because the UI reads by position.
		expect(expectExactSum(900, [1, 0, 2])).toEqual([300, 0, 600]);
	});

	it('splits zero between everyone as zero', () => {
		expect(expectExactSum(0, [3, 1])).toEqual([0, 0]);
	});

	it('rounds a fractional total before splitting it, so the parts still sum', () => {
		// Nothing should send fractional cents, but a client that does must not
		// be able to produce a split that does not add up.
		expect(expectExactSum(100.4, [1, 1])).toEqual([50, 50]);
		expect(splitByWeight(100.6, [1, 1])).toEqual([51, 50]);
	});

	it('stays exact for an amount far larger than any real expense', () => {
		// Ten million in major units, divided seven ways.
		const parts = expectExactSum(1_000_000_000, [1, 1, 1, 1, 1, 1, 1]);
		expect(parts[0] - parts[6]).toBe(1);
	});

	it('stays exact for a lopsided weighting', () => {
		const parts = expectExactSum(1000, [999_999, 1]);
		expect(parts).toEqual([1000, 0]);
	});

	it('carries the remainder on a negative total too', () => {
		expect(expectExactSum(-101, [1, 1, 1])).toEqual([-34, -34, -33]);
	});

	it('ignores an infinite weight rather than letting it take everything', () => {
		// Infinity is not a share anyone can owe. It is treated as unusable, so
		// the finite weights beside it divide the whole amount.
		expect(expectExactSum(300, [Number.POSITIVE_INFINITY, 1, 1])).toEqual([0, 150, 150]);
	});

	it('breaks a tie by original order, so the same input always splits the same way', () => {
		const once = splitByWeight(1000, [1, 1, 1, 1, 1, 1, 1]);
		expect(once).toEqual(splitByWeight(1000, [1, 1, 1, 1, 1, 1, 1]));
		// The three extra cents go to the first three, not to an arbitrary three.
		expect(once).toEqual([143, 143, 143, 143, 143, 143, 142]);
	});

	it('never returns a fractional or non-finite part', () => {
		const awkward: Array<[number, number[]]> = [
			[7, [1, 1, 1]],
			[9999, [2, 3, 5, 7, 11]],
			[-1, [1, 1]],
			[333, [0.1, 0.2, 0.7]],
			[250, [1e-9, 1]]
		];
		for (const [total, weights] of awkward) {
			const parts = expectExactSum(total, weights);
			for (const p of parts) expect(Number.isSafeInteger(p)).toBe(true);
		}
	});
});
