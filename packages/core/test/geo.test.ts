import { describe, expect, it } from 'vitest';
import { haversineKm } from '@trippy/core/geo';

describe('haversineKm', () => {
	it('returns zero for identical coordinates', () => {
		expect(haversineKm(40.7128, -74.006, 40.7128, -74.006)).toBe(0);
	});

	it('estimates known real distances within a sensible tolerance', () => {
		expect(haversineKm(40.7128, -74.006, 51.5074, -0.1278)).toBeCloseTo(5570, -1);
		expect(haversineKm(48.8566, 2.3522, 51.5074, -0.1278)).toBeCloseTo(344, 0);
	});
});
