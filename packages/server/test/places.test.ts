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
process.env.GOOGLE_PLACES_KEY = 'test-key';

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
});

describe('as-you-type search', () => {
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

	it('filters suggestions to lodging when the caller wants a stay', async () => {
		const calls = stubProvider({ autocomplete: ONE_SUGGESTION });
		await places.searchPlaces('hilton at', ATHENS, 'stay', 'session-dddd');
		expect(calls[0].body.includedPrimaryTypes).toEqual(['lodging']);
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
