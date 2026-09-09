import { describe, expect, it } from 'vitest';
import { estimateTravel, estimateTravelBetween, haversineKm } from '@trippy/core/geo';

describe('haversineKm', () => {
	it('returns zero for identical coordinates', () => {
		expect(haversineKm(40.7128, -74.006, 40.7128, -74.006)).toBe(0);
	});

	it('estimates known real distances within a sensible tolerance', () => {
		expect(haversineKm(40.7128, -74.006, 51.5074, -0.1278)).toBeCloseTo(5570, -1);
		expect(haversineKm(48.8566, 2.3522, 51.5074, -0.1278)).toBeCloseTo(344, 0);
	});
});

describe('estimateTravel', () => {
	it('classifies short walks, local transit and longer drives', () => {
		expect(estimateTravel(0)).toEqual({ mode: 'walk', mins: 3 });
		expect(estimateTravel(3)).toEqual({ mode: 'transit', mins: 21 });
		expect(estimateTravel(10)).toEqual({ mode: 'drive', mins: 31 });
	});

	it('estimates travel between coordinates through the shared distance helper', () => {
		const direct = estimateTravelBetween(48.8566, 2.3522, 51.5074, -0.1278);
		expect(direct).toEqual(estimateTravel(haversineKm(48.8566, 2.3522, 51.5074, -0.1278)));
	});
});
