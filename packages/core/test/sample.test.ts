import { describe, expect, it } from 'vitest';
import { getTrip, trips } from '@trippy/core/sample';

describe('sample trips', () => {
	it('looks up a trip by id', () => {
		expect(getTrip('china-2026')).toMatchObject({
			id: 'china-2026',
			name: 'China, autumn',
			homeCurrency: 'USD'
		});
	});

	it('returns undefined for an unknown trip id', () => {
		expect(getTrip('missing-trip')).toBeUndefined();
	});

	it('keeps every sample city attached to a real trip with ordered dates', () => {
		expect(trips.length).toBeGreaterThan(0);
		for (const trip of trips) {
			expect(trip.cities.length).toBeGreaterThan(0);
			for (const city of trip.cities) {
				expect(city.arrive <= city.depart).toBe(true);
				expect(city.tz).not.toBe('');
			}
		}
	});
});
