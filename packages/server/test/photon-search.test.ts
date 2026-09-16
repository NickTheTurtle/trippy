import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * What the keyless provider returns once it is asked properly.
 *
 * Photon is what every search falls back to, and with both Google keys rejected
 * in this environment it is what search actually is. Three things were wrong
 * with how it was asked and read, and all three are about an answer a person
 * could act on:
 *
 *  - no `lang`, so "Acropolis Museum" came back, and was saved, as "Mouseio
 *    Akropolis";
 *  - a `name` filter, which drops a plain street address entirely, because OSM
 *    records one as a house number on a street and gives it no name;
 *  - no de-duplication, so an address search returned one row per OSM street
 *    segment: the same name, the same city, different coordinates, and no way
 *    to tell which was meant.
 *
 * The fixtures below are trimmed from real responses captured from
 * photon.komoot.io while investigating. `fetch` is stubbed throughout: this
 * provider is free, but a unit suite that depends on a third party is a suite
 * that fails on somebody else's outage.
 */
const tempRoot = join(tmpdir(), `trippy-photon-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = join(tempRoot, 'photon.test.db');

let places: typeof import('../src/providers/places.ts');

beforeAll(async () => {
	places = await import('../src/providers/places.ts');
});

const ATHENS = {
	city: 'Athens',
	country: 'Greece',
	region: 'Attica',
	lat: 37.9838,
	lng: 23.7275
};

beforeEach(() => {
	// No key: the point of these cases is the keyless path.
	delete process.env.GOOGLE_SERVER_KEY;
	delete process.env.GOOGLE_PLACES_KEY;
	delete process.env.TRIPPY_OFFLINE_PROVIDERS;
	places.resetProviderStatus();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

interface Feature {
	properties: Record<string, string>;
	geometry: { coordinates: [number, number] };
}

const point = (lng: number, lat: number) => ({ coordinates: [lng, lat] as [number, number] });

/** Answers as Photon, and records the URLs it was called with. */
function stubPhoton(features: Feature[]): string[] {
	const urls: string[] = [];
	vi.stubGlobal('fetch', async (input: string | URL) => {
		urls.push(String(input));
		return { ok: true, json: async () => ({ features }) };
	});
	return urls;
}

/** The museum as Photon returns it: a named POI carrying a house number. */
const MUSEUM: Feature = {
	properties: {
		name: 'Acropolis Museum',
		osm_key: 'tourism',
		osm_value: 'museum',
		type: 'house',
		housenumber: '15',
		street: 'Dionysiou Areopagitou',
		postcode: '117 42',
		city: 'Athens',
		country: 'Greece'
	},
	geometry: point(23.72847, 37.96853)
};

/** One of the eight street segments that flooded an address search. */
const segment = (lng: number, lat: number, value: string, postcode: string): Feature => ({
	properties: {
		name: 'Dionysiou Areopagitou',
		osm_key: 'highway',
		osm_value: value,
		type: 'street',
		postcode,
		city: 'Athens',
		country: 'Greece'
	},
	geometry: point(lng, lat)
});

describe('asking Photon', () => {
	it('asks for English names, so a saved place is not in the local script', async () => {
		const urls = stubPhoton([MUSEUM]);
		await places.searchPlaces('acropolis museum lang case', ATHENS);
		// Photon supports default, de, en and fr, and rejects anything else with a
		// 400, so this is a fixed value rather than the caller's locale.
		expect(urls[0]).toContain('lang=en');
	});

	it('still biases to the city it was given', async () => {
		const urls = stubPhoton([MUSEUM]);
		await places.searchPlaces('acropolis museum bias case', ATHENS);
		expect(urls[0]).toContain('lat=37.9838');
		expect(urls[0]).toContain('lon=23.7275');
	});
});

describe('reading an address back', () => {
	it('keeps the house number, which is what tells a building from its street', async () => {
		stubPhoton([MUSEUM]);
		const [hit] = await places.searchPlaces('acropolis museum number case', ATHENS);
		expect(hit.name).toBe('Acropolis Museum');
		expect(hit.address).toBe('Dionysiou Areopagitou 15, 117 42 Athens, Greece');
	});

	it('keeps a row that has only an address, and labels it as one', async () => {
		stubPhoton([
			{
				properties: {
					osm_key: 'place',
					osm_value: 'house',
					type: 'house',
					housenumber: '77',
					street: 'Unter den Linden',
					postcode: '10117',
					city: 'Berlin',
					country: 'Germany'
				},
				geometry: point(13.38007, 52.51558)
			}
		]);
		const hits = await places.searchPlaces('unter den linden 77', {
			city: 'Berlin',
			country: 'Germany'
		});
		// A `name` filter dropped this row, which is why typing an address
		// returned everything except the address.
		expect(hits).toHaveLength(1);
		expect(hits[0].name).toBe('Unter den Linden 77');
		expect(hits[0].lat).toBe(52.51558);
	});

	it('collapses the street segments an address search floods the list with', async () => {
		stubPhoton([
			segment(23.72581, 37.96976, 'footway', '117 42'),
			segment(23.72616, 37.96978, 'pedestrian', '117 42'),
			segment(23.72233, 37.97025, 'living_street', '117 42'),
			MUSEUM
		]);
		const hits = await places.searchPlaces('dionysiou areopagitou 15', ATHENS);
		// Three rows that read identically are one choice, not three.
		expect(hits).toHaveLength(2);
		expect(hits.filter((h) => h.name === 'Dionysiou Areopagitou')).toHaveLength(1);
	});

	it('puts the building above the street it stands on', async () => {
		stubPhoton([
			segment(23.72581, 37.96976, 'footway', '117 42'),
			segment(23.72616, 37.96978, 'pedestrian', '105 58'),
			MUSEUM
		]);
		const hits = await places.searchPlaces('dionysiou areopagitou order case', ATHENS);
		// Photon ranks the street first often enough that the thing searched for
		// fell off the end of the list.
		expect(hits[0].name).toBe('Acropolis Museum');
	});

	it('keeps the stay filter, so a lodging search is still only lodging', async () => {
		stubPhoton([
			MUSEUM,
			{
				properties: {
					name: 'Hotel Grande Bretagne',
					osm_key: 'tourism',
					osm_value: 'hotel',
					type: 'house',
					housenumber: '1',
					street: 'Vasileos Georgiou A',
					city: 'Athens',
					country: 'Greece'
				},
				geometry: point(23.735, 37.976)
			}
		]);
		const hits = await places.searchPlaces('somewhere to sleep near syntagma', ATHENS, 'stay');
		expect(hits.map((h) => h.name)).toEqual(['Hotel Grande Bretagne']);
	});
});
