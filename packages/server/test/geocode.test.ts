import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchCities, type CitySuggestion } from '../src/providers/geocode.ts';

/**
 * Geocoding suggestions, driven entirely off a stubbed Photon response.
 *
 * The provider is never actually called: a test suite must not depend on a live
 * third party, whether or not that third party charges for the call. Everything
 * here is about what the provider's answer is turned into.
 */

interface Feature {
	name: string;
	country: string;
	state?: string;
	lat: number;
	lng: number;
}

function feature(f: Feature) {
	return {
		properties: { name: f.name, country: f.country, ...(f.state ? { state: f.state } : {}) },
		geometry: { coordinates: [f.lng, f.lat] }
	};
}

/** Replaces fetch with one that answers every request with these features. */
function stubPhoton(features: Feature[]): void {
	vi.stubGlobal('fetch', async () => ({
		ok: true,
		json: async () => ({ features: features.map(feature) })
	}));
}

const SPRINGFIELD_IL: Feature = {
	name: 'Springfield',
	country: 'United States',
	state: 'Illinois',
	lat: 39.7817,
	lng: -89.6501
};
const SPRINGFIELD_MO: Feature = {
	name: 'Springfield',
	country: 'United States',
	state: 'Missouri',
	lat: 37.2089,
	lng: -93.2923
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('city suggestions', () => {
	it('keeps two distinct same-name cities in the same country', async () => {
		stubPhoton([SPRINGFIELD_IL, SPRINGFIELD_MO]);
		const results = await searchCities('springfield');
		// The regression: the old `name|country` key dropped the second one
		// entirely, so the other Springfield could not be picked at all.
		expect(results).toHaveLength(2);
		expect(results.map((r) => r.region)).toEqual(['Illinois', 'Missouri']);
		expect(new Set(results.map((r) => r.tz))).toEqual(
			new Set(['America/Chicago'])
		);
	});

	it('keeps two same-name cities that also share a region', async () => {
		// Region in the key would only move the collision one level down, so the
		// two towns below (roughly 90 km apart, same state) must both survive.
		stubPhoton([
			{ name: 'Sunnyvale', country: 'United States', state: 'Texas', lat: 32.7959, lng: -96.5522 },
			{ name: 'Sunnyvale', country: 'United States', state: 'Texas', lat: 32.0, lng: -96.0 }
		]);
		const results = await searchCities('sunnyvale');
		expect(results).toHaveLength(2);
	});

	it('collapses near-duplicate nodes for a single city', async () => {
		// Photon happily returns more than one OSM node for one settlement; they
		// sit within a couple of kilometres of each other.
		stubPhoton([
			{ name: 'Athens', country: 'Greece', state: 'Attica', lat: 37.9838, lng: 23.7275 },
			{ name: 'Athens', country: 'Greece', state: 'Attica', lat: 37.9842, lng: 23.7301 },
			{ name: 'Athens', country: 'Greece', state: 'Attica', lat: 37.9838, lng: 23.7275 }
		]);
		const results = await searchCities('athens');
		expect(results).toHaveLength(1);
		expect(results[0]).toEqual({
			name: 'Athens',
			country: 'Greece',
			region: 'Attica',
			lat: 37.9838,
			lng: 23.7275,
			tz: 'Europe/Athens'
		});
	});

	it('distinguishes same-name cities in different countries', async () => {
		stubPhoton([
			{ name: 'Athens', country: 'Greece', state: 'Attica', lat: 37.9838, lng: 23.7275 },
			{ name: 'Athens', country: 'United States', state: 'Georgia', lat: 33.9519, lng: -83.3576 }
		]);
		const results = await searchCities('athens');
		expect(results.map((r) => r.country)).toEqual(['Greece', 'United States']);
	});

	it('handles a place with no region without inventing one', async () => {
		stubPhoton([
			{ name: 'Singapore', country: 'Singapore', lat: 1.3521, lng: 103.8198 },
			{ name: 'Monaco', country: 'Monaco', state: '  ', lat: 43.7384, lng: 7.4246 }
		]);
		const results = await searchCities('sing');
		expect(results).toHaveLength(2);
		for (const r of results) {
			expect(r.region).toBeUndefined();
			// Absent, not present-and-undefined: the key must not survive a JSON
			// round trip as a null, and nothing may render as "undefined".
			expect(Object.hasOwn(r, 'region')).toBe(false);
		}
		expect(JSON.stringify({ results })).not.toContain('undefined');
		expect(JSON.stringify({ results })).not.toContain('region');
	});

	it('skips malformed features and short queries without calling the provider', async () => {
		const spy = vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }));
		vi.stubGlobal('fetch', spy);
		expect(await searchCities(' a ')).toEqual([]);
		expect(spy).not.toHaveBeenCalled();

		vi.stubGlobal('fetch', async () => ({
			ok: true,
			json: async () => ({
				features: [
					{ properties: { country: 'Greece' }, geometry: { coordinates: [23.7, 37.9] } },
					{ properties: { name: 'Nowhere', country: 'Greece' } },
					feature(SPRINGFIELD_IL)
				]
			})
		}));
		const results: CitySuggestion[] = await searchCities('anything');
		expect(results.map((r) => r.name)).toEqual(['Springfield']);
	});

	it('returns nothing when the provider errors', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new Error('network down');
		});
		expect(await searchCities('athens')).toEqual([]);
		vi.stubGlobal('fetch', async () => ({ ok: false, json: async () => ({}) }));
		expect(await searchCities('athens')).toEqual([]);
	});
});
