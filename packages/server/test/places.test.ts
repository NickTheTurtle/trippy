import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Which provider request a search actually makes, and what it costs.
 *
 * Nothing here calls Google. The point is the routing: an as-you-type search
 * should reach autocomplete (free inside a session) and only fall back to the
 * billed text search when autocomplete has no answer. That decision is worth a
 * test because it is invisible at the UI, and getting it wrong shows up as a
 * bill rather than as a bug.
 *
 * A throwaway database, because the search cache is written through to SQLite
 * and the real one holds real trips.
 */
const tempRoot = join(tmpdir(), `trippy-places-tests-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = join(tempRoot, 'places.test.db');
process.env.GOOGLE_SERVER_KEY = 'test-key';

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

interface Call {
	url: string;
	body: Record<string, unknown>;
}

/**
 * Records every provider request and answers each endpoint from `replies`.
 * An endpoint left out answers as if the provider found nothing.
 */
function stubProvider(replies: {
	autocomplete?: unknown;
	searchText?: unknown;
	details?: unknown;
	autocompleteFails?: boolean;
}): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal('fetch', async (input: string | URL, init?: { body?: string }) => {
		const url = String(input);
		calls.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
		if (url.includes(':autocomplete')) {
			if (replies.autocompleteFails) return { ok: false, status: 500 };
			return { ok: true, json: async () => replies.autocomplete ?? {} };
		}
		if (url.includes(':searchText')) return { ok: true, json: async () => replies.searchText ?? {} };
		if (url.includes('/v1/places/')) return { ok: true, json: async () => replies.details ?? {} };
		// Photon, the keyless fallback.
		return { ok: true, json: async () => ({ features: [] }) };
	});
	return calls;
}

/** One autocomplete prediction, shaped the way Google returns it. */
function prediction(id: string, main: string, secondary: string) {
	return {
		placePrediction: {
			placeId: id,
			structuredFormat: { mainText: { text: main }, secondaryText: { text: secondary } }
		}
	};
}

const ONE_SUGGESTION = {
	suggestions: [prediction('place-1', 'Acropolis Museum', 'Dionysiou Areopagitou, Athens')]
};

const ONE_TEXT_RESULT = {
	places: [
		{
			id: 'place-2',
			displayName: { text: 'Sushi Bar' },
			formattedAddress: 'Ermou 1, Athens',
			location: { latitude: 37.97, longitude: 23.72 },
			types: ['restaurant'],
			primaryType: 'restaurant'
		}
	]
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	process.env.GOOGLE_SERVER_KEY = 'test-key';
	delete process.env.GOOGLE_PLACES_KEY;
});

describe('as-you-type search', () => {
	it('uses the deprecated Places key as a rollout fallback', async () => {
		delete process.env.GOOGLE_SERVER_KEY;
		process.env.GOOGLE_PLACES_KEY = 'old-server-key';
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const calls = stubProvider({ autocomplete: ONE_SUGGESTION });

		const results = await places.searchPlaces('legacy key query', ATHENS, 'place', 'session-legacy');

		expect(calls).toHaveLength(1);
		expect(results[0].source).toBe('google');
		expect(warn).toHaveBeenCalledWith(
			'GOOGLE_PLACES_KEY is deprecated. Set GOOGLE_SERVER_KEY for server-side Google Places and Routes calls.'
		);
	});

	it('asks autocomplete, not the billed text search, when it has a session', async () => {
		const calls = stubProvider({ autocomplete: ONE_SUGGESTION });
		const results = await places.searchPlaces('acropolis mus', ATHENS, 'place', 'session-aaaa');

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toContain(':autocomplete');
		expect(results[0].name).toBe('Acropolis Museum');
		expect(results[0].id).toBe('place-1');
		// The address is the only other thing a prediction carries; the rest is
		// bought once, for the one place that gets picked.
		expect(results[0].address).toBe('Dionysiou Areopagitou, Athens');
		expect(results[0].lat).toBeNull();
	});

	it('sends the session token, which is what makes the suggestions free', async () => {
		const calls = stubProvider({ autocomplete: ONE_SUGGESTION });
		await places.searchPlaces('parthenon g', ATHENS, 'place', 'session-bbbb');
		expect(calls[0].body.sessionToken).toBe('session-bbbb');
	});

	it('restricts predictions to a box around the city, not a bias', async () => {
		const calls = stubProvider({ autocomplete: ONE_SUGGESTION });
		await places.searchPlaces('museum near', ATHENS, 'place', 'session-cccc');

		// Verified against the live API: biasing alone offered Boston and New York
		// museums for a city in Georgia. Only restricting keeps predictions local.
		expect(calls[0].body.locationBias).toBeUndefined();
		const box = (
			calls[0].body.locationRestriction as { rectangle: { low: { latitude: number } } }
		).rectangle;
		expect(box.low.latitude).toBeCloseTo(36.98, 2);
	});

	it('filters suggestions to the lodging primary types Google actually assigns', async () => {
		const calls = stubProvider({ autocomplete: ONE_SUGGESTION });
		await places.searchPlaces('hilton at', ATHENS, 'stay', 'session-dddd');

		// Not the umbrella `lodging`. The parameter matches a place's primary
		// type only, and Google gives a real hotel a specific one, so filtering on
		// `lodging` returned an empty 200 and stay search quietly found nothing.
		expect(calls[0].body.includedPrimaryTypes).toContain('hotel');
		expect(calls[0].body.includedPrimaryTypes).not.toContain('lodging');
		// Five is Google's cap; more than that is rejected outright.
		expect(calls[0].body.includedPrimaryTypes.length).toBeLessThanOrEqual(5);
	});

	it('keeps a stay text search unrestricted and filters the answer itself', async () => {
		const calls = stubProvider({
			autocomplete: { suggestions: [] },
			searchText: {
				places: [
					{
						id: 'inn-1',
						displayName: { text: 'Little Inn' },
						formattedAddress: 'Plaka, Athens',
						location: { latitude: 37.97, longitude: 23.72 },
						// Primary type is not in the five, so only a full-list filter keeps it.
						types: ['inn', 'point_of_interest'],
						primaryType: 'inn'
					},
					{
						id: 'rest-1',
						displayName: { text: 'Taverna' },
						formattedAddress: 'Plaka, Athens',
						location: { latitude: 37.97, longitude: 23.72 },
						types: ['restaurant'],
						primaryType: 'restaurant'
					}
				]
			}
		});
		const results = await places.searchPlaces('little', ATHENS, 'stay', 'session-hhhh');

		// A one-value `includedType` could not express the whole list, so the
		// request asks for everything and the restaurant is dropped here.
		expect(calls[1].body.includedType).toBeUndefined();
		expect(results.map((r) => r.name)).toEqual(['Little Inn']);
	});

	it('falls back to the text search when there is nothing to predict', async () => {
		const calls = stubProvider({ autocomplete: { suggestions: [] }, searchText: ONE_TEXT_RESULT });
		const results = await places.searchPlaces('cheap sushi near', ATHENS, 'place', 'session-eeee');

		expect(calls.map((x) => x.url.includes(':searchText'))).toEqual([false, true]);
		expect(results[0].name).toBe('Sushi Bar');
		expect(results[0].category).toBe('Food');
	});

	it('falls back to the text search, not to OSM, when autocomplete errors', async () => {
		const calls = stubProvider({ autocompleteFails: true, searchText: ONE_TEXT_RESULT });
		const results = await places.searchPlaces('broken query', ATHENS, 'place', 'session-ffff');

		// A failed prediction says nothing about whether Google is reachable, so
		// dropping straight to the keyless provider would lose a good answer.
		expect(calls[1].url).toContain(':searchText');
		expect(results[0].source).toBe('google');
	});

	it('skips autocomplete for a city with no coordinates, having no box to draw', async () => {
		const calls = stubProvider({ searchText: ONE_TEXT_RESULT });
		await places.searchPlaces(
			'anything here',
			{ city: 'Nowhere', country: 'Elsewhere' },
			'place',
			'session-gggg'
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toContain(':searchText');
	});
});

describe('picking a suggestion', () => {
	const FULL_DETAILS = {
		displayName: { text: 'Acropolis Museum' },
		formattedAddress: 'Dionysiou Areopagitou 15, Athina 117 42, Greece',
		location: { latitude: 37.9684, longitude: 23.7285 },
		types: ['tourist_attraction', 'museum'],
		primaryType: 'museum',
		rating: 4.7,
		userRatingCount: 84995,
		regularOpeningHours: { weekdayDescriptions: ['Monday: 9:00 AM - 5:00 PM'] },
		photos: [{ name: 'places/x/photos/y' }]
	};

	it('buys the coordinates and category a prediction could not carry', async () => {
		stubProvider({ details: FULL_DETAILS });
		const d = await places.placeDetails('place-1', 'session-hhhh');

		// Without these a suggested place would land on the board with no map pin.
		expect(d?.lat).toBeCloseTo(37.9684, 4);
		expect(d?.lng).toBeCloseTo(23.7285, 4);
		expect(d?.category).toBe('Sights');
		expect(d?.rating).toBe(4.7);
	});

	it('spends the session token, which is what closes the session', async () => {
		const calls = stubProvider({ details: FULL_DETAILS });
		await places.placeDetails('place-2', 'session-iiii');
		expect(calls[0].url).toContain('sessionToken=session-iiii');
	});

	it('leaves identity out when the provider did not answer with it', async () => {
		stubProvider({ details: { rating: 4.1 } });
		const d = await places.placeDetails('place-3', 'session-jjjj');

		// Absent, not null: the caller merges this over a result that already
		// knows its own name, and a null would erase it.
		expect(d).not.toHaveProperty('name');
		expect(d).not.toHaveProperty('lat');
		expect(d?.rating).toBe(4.1);
	});
});

describe('what a place is', () => {
	/** The category assigned to a place with these Google types. */
	async function categoryFor(id: string, types: string[], primaryType?: string) {
		stubProvider({ details: { types, primaryType } });
		return (await places.placeDetails(id))?.category;
	}

	it('calls a hotel with a restaurant in it a hotel', async () => {
		// The regression, and it is Google's real answer for Hotel Gracery
		// Shinjuku: a hotel lists its restaurant in `types`, so testing food
		// before lodging filed every such hotel under Food & Drink.
		expect(
			await categoryFor(
				'hotel-1',
				['hotel', 'lodging', 'restaurant', 'food', 'point_of_interest'],
				'hotel'
			)
		).toBe('Stay');
	});

	it('reads the narrow food types Google actually returns', async () => {
		// `ramen_restaurant` is the primary type; there is a long tail of these
		// and listing them one by one would always be one cuisine behind.
		expect(await categoryFor('food-1', ['ramen_restaurant', 'food'], 'ramen_restaurant')).toBe(
			'Food'
		);
		expect(await categoryFor('food-2', ['sushi_restaurant'], 'sushi_restaurant')).toBe('Food');
	});

	it("prefers Google's own pick to the rest of the list", async () => {
		// `tourist_attraction` comes first in `types` for the Acropolis Museum,
		// and a museum is the more useful answer.
		expect(
			await categoryFor('sight-1', ['tourist_attraction', 'museum', 'point_of_interest'], 'museum')
		).toBe('Sights');
	});

	it('still classifies a place whose primary type means nothing to us', async () => {
		expect(await categoryFor('food-3', ['bakery', 'store'], 'bagel_shop')).toBe('Food');
		expect(await categoryFor('park-1', ['park'], 'dog_park')).toBe('Nature');
	});
});
