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
