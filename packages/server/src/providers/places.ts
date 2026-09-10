import { env } from '../infra/env';
import { createPersistentCache } from '../infra/cache';

/**
 * A place returned from a search provider, normalised across backends.
 *
 * Everything below `id` is optional at search time: the as-you-type search asks
 * for the cheap fields only and the rest arrive from `placeDetails()` when a
 * result is actually clicked. See `searchGoogle` for why.
 */
export interface PlaceResult {
	/** Google place ID, or null from providers that have none. Feeds `placeDetails`. */
	id: string | null;
	name: string;
	category: string;
	address: string | null;
	url: string | null;
	lat: number | null;
	lng: number | null;
	rating: number | null;
	ratingCount: number | null;
	priceLevel: number | null;
	hours: string[] | null;
	photo: string | null;
	source: 'google' | 'osm';
}

/** The fields a search deliberately leaves out, fetched on demand for one place. */
export interface PlaceDetails {
	url: string | null;
	rating: number | null;
	ratingCount: number | null;
	priceLevel: number | null;
	hours: string[] | null;
	photo: string | null;
	/**
	 * Identity, for the case where the "search" was really a suggestion.
	 *
	 * A prediction carries a name and an address and nothing else, so these are
	 * how a picked suggestion gets its coordinates and category. Absent rather
	 * than null when the provider did not say, so a caller merging this over a
	 * result it already has cannot blank a field it already knew.
	 */
	name?: string;
	address?: string;
	category?: string;
	lat?: number;
	lng?: number;
}

/**
 * Where to bias a search.
 *
 * The region is not decoration. Google resolves the *text* of the query, so
 * "museum Nashville United States" returns Tennessee no matter where the
 * search is biased to: a location bias alone was verified to change nothing
 * for an ambiguous name. Naming the state is what actually picks out Nashville,
 * Georgia. The coordinates then sharpen the ranking, and are what keep a
 * neighbouring big city from taking the top slots once the state is in play.
 */
export interface SearchNear {
	city: string;
	country: string;
	/** State or province, when the city has one. Omitted by city-states. */
	region?: string | null;
	lat?: number | null;
	lng?: number | null;
}

/** How far around a city a search still counts as "here", for the bias circle. */
const BIAS_RADIUS_M = 50000;

/**
 * The place half of a provider query: "Nashville, Georgia, United States".
 *
 * A region equal to the city name is dropped rather than repeated, because
 * "Tokyo Tokyo Japan" is what a city that is its own prefecture would produce.
 */
function nearText(near: SearchNear): string {
	const region = near.region?.trim();
	return [near.city, region && region !== near.city ? region : '', near.country]
		.map((p) => p?.trim())
		.filter(Boolean)
		.join(' ');
}

/** The bias circle for a city, or nothing when we have no coordinates for it. */
function locationBias(near: SearchNear): Record<string, unknown> {
	if (typeof near.lat !== 'number' || typeof near.lng !== 'number') return {};
	return {
		locationBias: {
			circle: {
				center: { latitude: near.lat, longitude: near.lng },
				radius: BIAS_RADIUS_M
			}
		}
	};
}

/**
 * What the caller is shopping for. Stays and places are different searches, not
 * one search filtered afterwards: "apartment" in a general search returns
 * letting agents and furniture shops, and a lodging search for "acropolis"
 * should return nothing rather than the monument.
 */
export type SearchKind = 'place' | 'stay';

const GOOGLE_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const GOOGLE_SUGGEST = 'https://places.googleapis.com/v1/places:autocomplete';
const GOOGLE_DETAILS = 'https://places.googleapis.com/v1/places/';
const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';

/**
 * How far either side of a city, in degrees, a suggestion may sit.
 *
 * Autocomplete takes a *restriction* here rather than the bias a text search
 * gets, because bias barely moves it: biased on Nashville, Georgia it offered
 * museums in Washington, New York and Boston, exactly the way an unweighted
 * text search does. Restricting is the only steering that works, so the box has
 * to be wide enough to keep the day trips people actually plan. One degree is
 * about 110km north to south and less east to west, which reaches Mount Fuji
 * from Tokyo while leaving Nashville, Tennessee well outside Nashville,
 * Georgia. A circle cannot do this job: Google caps its radius at 50km.
 */
const NEAR_DEGREES = 1;

/**
 * Fields the search asks for. Under Places (New) the highest-tier field in the
 * mask prices the *whole* request, so asking a search for ratings and opening
 * hours buys the expensive data for eight results the user has not looked at
 * yet, of which they will keep one. This mask stays at the tier a search
 * genuinely needs: enough to render a name, an address and a map pin.
 */
const SEARCH_MASK =
	'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType';

/**
 * What a suggestion is worth asking for: an id to look up and two lines to show.
 *
 * `structuredFormat` splits the prediction into the place's own name and the
 * address under it, which is what the dropdown draws. The plain `text` field
 * runs the two together, so asking for it as well would only buy a duplicate.
 */
const SUGGEST_MASK =
	'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat';

/**
 * The expensive half of the split, bought once for the one place that is clicked.
 *
 * The Essentials fields at the end are not extras: a suggestion carries a name
 * and an address and nothing else, so this is where a picked place gets its
 * coordinates and its category, and without them a suggested place would land
 * on the board with no map pin. They ride along free, because a request is
 * priced by the highest tier in its mask and the ratings above are already
 * Enterprise.
 */
const DETAILS_MASK =
	'rating,userRatingCount,priceLevel,regularOpeningHours,websiteUri,photos,displayName,formattedAddress,location,types,primaryType';

/**
 * Maps a Google place type to one of our discover categories.
 *
 * Order matters and must run specific → generic. Google tags almost every venue
 * worth visiting as `tourist_attraction`, so testing that early collapsed the
 * whole map to "Sights": a `park,tourist_attraction` hill and a
 * `flea_market,market,tourist_attraction` bazaar both came back as Sights.
 * `primaryType` is Google's own pick and is consulted first when present.
 */
function googleCategory(types: string[], primaryType?: string): string {
	const t = new Set(types);
	const has = (...names: string[]) =>
		names.some((n) => n === primaryType) || names.some((n) => t.has(n));

	if (has('amusement_center', 'amusement_park', 'video_arcade', 'bowling_alley'))
		return 'Activity';
	if (has('restaurant', 'cafe', 'coffee_shop', 'bakery', 'food', 'meal_takeaway', 'food_court'))
		return 'Food';
	if (has('bar', 'night_club', 'pub', 'wine_bar')) return 'Nightlife';
	if (
		has(
			'beach',
			'park',
			'national_park',
			'state_park',
			'natural_feature',
			'hiking_area',
			'garden',
			'botanical_garden',
			'wildlife_park',
			'zoo',
			'aquarium'
		)
	)
		return 'Nature';
	if (
		has(
			'flea_market',
			'market',
			'shopping_mall',
			'store',
			'department_store',
			'clothing_store',
			'book_store',
			'gift_shop'
		)
	)
		return 'Shopping';
	if (
		has(
			'historical_landmark',
			'historical_place',
			'monument',
			'castle',
			'church',
			'mosque',
			'synagogue',
			'hindu_temple',
			'place_of_worship',
			'cultural_landmark'
		)
	)
		return 'History';
	if (has('museum', 'art_gallery', 'performing_arts_theater', 'opera_house')) return 'Sights';
	if (has('hotel', 'lodging', 'resort_hotel', 'guest_house')) return 'Stay';
	return 'Sights';
}

/** Maps an OSM key/value pair to one of our discover categories. */
function osmCategory(key: string, value: string): string {
	if (key === 'tourism') {
		if (value === 'museum' || value === 'gallery' || value === 'artwork') return 'Sights';
		return 'Sights';
	}
	if (key === 'natural' || value === 'park' || key === 'leisure') return 'Nature';
	if (key === 'amenity' && (value === 'restaurant' || value === 'cafe' || value === 'fast_food'))
		return 'Food';
	if (key === 'amenity' && (value === 'bar' || value === 'pub' || value === 'nightclub'))
		return 'Nightlife';
	if (key === 'shop') return 'Shopping';
	if (key === 'historic' || value === 'place_of_worship') return 'History';
	return 'Sights';
}

/** Maps Google's price-level enum to a 0-4 integer ($ count). */
function googlePriceLevel(level?: string): number | null {
	switch (level) {
		case 'PRICE_LEVEL_FREE':
			return 0;
		case 'PRICE_LEVEL_INEXPENSIVE':
			return 1;
		case 'PRICE_LEVEL_MODERATE':
			return 2;
		case 'PRICE_LEVEL_EXPENSIVE':
			return 3;
		case 'PRICE_LEVEL_VERY_EXPENSIVE':
			return 4;
		default:
			return null;
	}
}

async function searchGoogle(
	query: string,
	near: SearchNear,
	kind: SearchKind
): Promise<PlaceResult[]> {
	const key = env.GOOGLE_PLACES_KEY;
	if (!key) return [];
	const res = await fetch(GOOGLE_ENDPOINT, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Goog-Api-Key': key,
			'X-Goog-FieldMask': SEARCH_MASK
		},
		body: JSON.stringify({
			textQuery: `${query} ${nearText(near)}`.trim(),
			// Without this Google answers in the local language of the result, so an
			// Athens search returns "Πιττάκη, Αθήνα" for one place and a romanised
			// address for the next. Addresses are prefilled into user-editable notes,
			// so they need to be consistent and readable to the person typing.
			languageCode: 'en',
			maxResultCount: 8,
			...locationBias(near),
			// `lodging` is the umbrella type: verified to cover hotels, hostels,
			// resorts and the apartment listings people actually book, while
			// returning nothing at all for a landmark query.
			...(kind === 'stay' ? { includedType: 'lodging' } : {})
		})
	});
	if (!res.ok) throw new Error(`google ${res.status}`);
	const data = (await res.json()) as {
		places?: {
			id?: string;
			displayName?: { text?: string };
			formattedAddress?: string;
			location?: { latitude?: number; longitude?: number };
			types?: string[];
			primaryType?: string;
		}[];
	};
	return (data.places ?? []).map((p) => ({
		id: p.id ?? null,
		name: p.displayName?.text ?? 'Unknown',
		category: googleCategory(p.types ?? [], p.primaryType),
		address: p.formattedAddress ?? null,
		url: null,
		lat: p.location?.latitude ?? null,
		lng: p.location?.longitude ?? null,
		// Filled in by placeDetails() when this result is clicked.
		rating: null,
		ratingCount: null,
		priceLevel: null,
		hours: null,
		photo: null,
		source: 'google' as const
	}));
}

/**
 * Asks Google what the half-typed query is likely to mean.
 *
 * This is the cheap way to answer "as you type". A text search is billed per
 * request, so every pause in typing bought another one; autocomplete requests
 * that are followed by a Place Details call on the same session token are not
 * billed at all, and that details call is one we already make when a result is
 * picked. The same keystrokes therefore cost one request instead of one per
 * pause, and the request they cost is one we were paying for anyway.
 *
 * Returns partial results: an id, a name and an address, with the rest left for
 * `placeDetails` to fill in. Returns nothing when the city has no coordinates,
 * because the restriction box is what keeps predictions in the right country
 * and there is nothing to build one from.
 */
async function suggestGoogle(
	query: string,
	near: SearchNear,
	kind: SearchKind,
	sessionToken: string
): Promise<PlaceResult[]> {
	const key = env.GOOGLE_PLACES_KEY;
	if (!key || typeof near.lat !== 'number' || typeof near.lng !== 'number') return [];
	const res = await fetch(GOOGLE_SUGGEST, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Goog-Api-Key': key,
			'X-Goog-FieldMask': SUGGEST_MASK
		},
		body: JSON.stringify({
			input: query,
			languageCode: 'en',
			// The token is what makes these requests free, and it only works if the
			// caller sends the same one for a whole session and then spends it on
			// the details call. See `placeDetails`.
			sessionToken,
			locationRestriction: {
				rectangle: {
					low: { latitude: near.lat - NEAR_DEGREES, longitude: near.lng - NEAR_DEGREES },
					high: { latitude: near.lat + NEAR_DEGREES, longitude: near.lng + NEAR_DEGREES }
				}
			},
			// Autocomplete spells this differently from a text search
			// (`includedPrimaryTypes`, a list) but means the same thing, and was
			// verified to hold: "acropolis" under it returns Acropolis *hotels*.
			...(kind === 'stay' ? { includedPrimaryTypes: ['lodging'] } : {})
		})
	});
	if (!res.ok) throw new Error(`google ${res.status}`);
	const data = (await res.json()) as {
		suggestions?: {
			placePrediction?: {
				placeId?: string;
				structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
			};
		}[];
	};
	return (data.suggestions ?? [])
		.map((s) => s.placePrediction)
		.filter((p): p is NonNullable<typeof p> => Boolean(p?.placeId))
		.map((p) => ({
			id: p.placeId ?? null,
			name: p.structuredFormat?.mainText?.text ?? 'Unknown',
			address: p.structuredFormat?.secondaryText?.text ?? null,
			// Everything below arrives with the details of whichever one is picked.
			category: '',
			url: null,
			lat: null,
			lng: null,
			rating: null,
			ratingCount: null,
			priceLevel: null,
			hours: null,
			photo: null,
			source: 'google' as const
		}));
}

/**
 * Fetches the fields the search skipped, for a single place the user has picked.
 *
 * This is the expensive half of the split search: one request per place actually
 * considered, rather than eight per keystroke-batch. Returns null when the
 * provider has no key or the id is unknown, so callers can just show what the
 * search already gave them.
 *
 * Passing back the session token the suggestions were made under is what closes
 * that session and makes them free; without it they are billed one by one. A
 * token may only be spent once, so the caller starts a new one after each pick.
 */
export async function placeDetails(
	id: string,
	sessionToken?: string
): Promise<PlaceDetails | null> {
	const key = env.GOOGLE_PLACES_KEY;
	if (!key || !id) return null;
	const url = new URL(`${GOOGLE_DETAILS}${encodeURIComponent(id)}`);
	url.searchParams.set('languageCode', 'en');
	if (sessionToken) url.searchParams.set('sessionToken', sessionToken);
	const res = await fetch(url, {
		headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': DETAILS_MASK }
	});
	if (!res.ok) throw new Error(`google ${res.status}`);
	const p = (await res.json()) as {
		websiteUri?: string;
		rating?: number;
		userRatingCount?: number;
		priceLevel?: string;
		regularOpeningHours?: { weekdayDescriptions?: string[] };
		photos?: { name?: string }[];
		displayName?: { text?: string };
		formattedAddress?: string;
		location?: { latitude?: number; longitude?: number };
		types?: string[];
		primaryType?: string;
	};
	return {
		url: p.websiteUri ?? null,
		rating: p.rating ?? null,
		ratingCount: p.userRatingCount ?? null,
		priceLevel: googlePriceLevel(p.priceLevel),
		hours: p.regularOpeningHours?.weekdayDescriptions ?? null,
		photo: p.photos?.[0]?.name ?? null,
		// Left off entirely when Google did not answer, rather than nulled: the
		// caller merges this over a result that may already know better.
		...(p.displayName?.text ? { name: p.displayName.text } : {}),
		...(p.formattedAddress ? { address: p.formattedAddress } : {}),
		...(p.types?.length ? { category: googleCategory(p.types, p.primaryType) } : {}),
		...(typeof p.location?.latitude === 'number' ? { lat: p.location.latitude } : {}),
		...(typeof p.location?.longitude === 'number' ? { lng: p.location.longitude } : {})
	};
}

/** OSM tags that mean "somewhere you can sleep", for the Photon fallback. */
const OSM_LODGING = new Set([
	'hotel',
	'hostel',
	'guest_house',
	'motel',
	'apartment',
	'chalet',
	'alpine_hut',
	'camp_site',
	'caravan_site'
]);

async function searchPhoton(
	query: string,
	near: SearchNear,
	kind: SearchKind
): Promise<PlaceResult[]> {
	const url = new URL(PHOTON_ENDPOINT);
	url.searchParams.set('q', `${query} ${nearText(near)}`.trim());
	// Photon ranks by distance from a given point, which is the only steering it
	// offers; without it a same-named city elsewhere wins on population.
	if (typeof near.lat === 'number' && typeof near.lng === 'number') {
		url.searchParams.set('lat', String(near.lat));
		url.searchParams.set('lon', String(near.lng));
	}
	// Photon has no type filter, so lodging is filtered out of the response;
	// ask for more rows than we show so the filter has something to keep.
	url.searchParams.set('limit', kind === 'stay' ? '25' : '8');
	const res = await fetch(url, {
		headers: { 'User-Agent': 'Trippy-trip-planner' }
	});
	if (!res.ok) throw new Error(`photon ${res.status}`);
	const data = (await res.json()) as {
		features?: {
			properties?: {
				name?: string;
				osm_key?: string;
				osm_value?: string;
				street?: string;
				city?: string;
				country?: string;
			};
			geometry?: { coordinates?: [number, number] };
		}[];
	};
	return (data.features ?? [])
		.filter((f) => f.properties?.name)
		.filter(
			(f) =>
				kind !== 'stay' ||
				(f.properties?.osm_key === 'tourism' && OSM_LODGING.has(f.properties?.osm_value ?? ''))
		)
		.slice(0, 8)
		.map((f) => {
			const pr = f.properties ?? {};
			const parts = [pr.street, pr.city, pr.country].filter(Boolean);
			return {
				id: null,
				name: pr.name ?? 'Unknown',
				category: osmCategory(pr.osm_key ?? '', pr.osm_value ?? ''),
				address: parts.length ? parts.join(', ') : null,
				url: null,
				lat: f.geometry?.coordinates?.[1] ?? null,
				lng: f.geometry?.coordinates?.[0] ?? null,
				rating: null,
				ratingCount: null,
				priceLevel: null,
				hours: null,
				photo: null,
				source: 'osm' as const
			};
		});
}

/**
 * Sentinel stored in `pois.photo` once we have asked Google for a photo and it
 * had none. Without it every page load would re-ask for the same misses, which
 * costs a Places call per card per view. `photoSrc()` treats it as "no photo"
 * because it is neither a `places/...` name nor a URL.
 */
export const NO_PHOTO = '-';

/**
 * Finds a cover photo for a place we already know about (seeded data, or a place
 * added before photos were wired up). Biased to the place's own coordinates when
 * we have them, so "Great Escape" resolves to the one in Athens rather than a
 * same-named venue on another continent.
 *
 * Returns a photo resource name, or NO_PHOTO when Google has no picture for it.
 * Throws only on transport failure, so callers can tell "no photo" (cache it)
 * from "lookup broke" (try again later).
 */
export async function lookupPhoto(
	name: string,
	near: SearchNear,
	lat?: number | null,
	lng?: number | null
): Promise<string> {
	const key = env.GOOGLE_PLACES_KEY;
	if (!key) return NO_PHOTO;

	const body: Record<string, unknown> = {
		textQuery: `${name} ${nearText(near)}`.trim(),
		maxResultCount: 1
	};
	if (typeof lat === 'number' && typeof lng === 'number') {
		// The place's own coordinates, so a tight circle is right. The city's are
		// the fallback and get the wider one, since they only say which town.
		body.locationBias = {
			circle: { center: { latitude: lat, longitude: lng }, radius: 5000 }
		};
	} else {
		Object.assign(body, locationBias(near));
	}

	const res = await fetch(GOOGLE_ENDPOINT, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Goog-Api-Key': key,
			'X-Goog-FieldMask': 'places.photos'
		},
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`google ${res.status}`);
	const data = (await res.json()) as {
		places?: { photos?: { name?: string }[] }[];
	};
	return data.places?.[0]?.photos?.[0]?.name ?? NO_PHOTO;
}

/** Which backend is active, for the UI to label results. */
export function activeProvider(): 'google' | 'osm' {
	return env.GOOGLE_PLACES_KEY ? 'google' : 'osm';
}

/**
 * Shortest query we will send to a provider. A single letter matches nothing
 * useful but still costs a full billed request, and the search fires as you
 * type, so the first two keystrokes of every search were pure waste. Enforced
 * on the server as well as the client: the client minimum is a UX choice, this
 * one is the cost guard.
 */
export const MIN_QUERY = 3;

/**
 * Place data is stable over days, and a group researches the same city from a
 * dozen devices, so an uncached search bills once per member for an identical
 * question. Written through to SQLite, so a `tsx watch` restart no longer
 * re-buys every answer: that, not repeat queries, was where most of the
 * development spend went. Kept well inside Google's 30-day limit on caching
 * place content, and short enough that a rating or an opening time is never
 * more than a week stale.
 */
const searchCache = createPersistentCache<PlaceResult[]>('search', 7 * 24 * 60 * 60 * 1000, 500);
const detailsCache = createPersistentCache<PlaceDetails | null>(
	'details',
	7 * 24 * 60 * 60 * 1000,
	1000
);

/**
 * Search for places. Uses Google Places when GOOGLE_PLACES_KEY is set,
 * otherwise the keyless OpenStreetMap (Photon) provider. Google falls back
 * to Photon if the request fails so discovery keeps working.
 *
 * Results are cached per normalised query and city: the same search typed twice
 * costs one request, and simultaneous identical searches share one in flight.
 */
export async function searchPlaces(
	query: string,
	near: SearchNear,
	kind: SearchKind = 'place',
	sessionToken?: string
): Promise<PlaceResult[]> {
	const q = query.trim();
	if (q.length < MIN_QUERY) return [];
	// Case and inner spacing do not change what Google returns, so they must not
	// change the cache key either; "Acropolis  Museum" is the same question.
	// The whole `near` goes in: two trips can hold two different Nashvilles, and
	// keying on the name alone served one of them the other's results.
	// The session token is deliberately *not* in the key: it changes every
	// search, and keying on it would mean never reading the cache again.
	const key = `${kind}|${q.toLowerCase().replace(/\s+/g, ' ')}|${nearText(near)}|${near.lat ?? ''},${near.lng ?? ''}`;
	return searchCache.take(key, async () => {
		if (env.GOOGLE_PLACES_KEY) {
			// Suggestions first, because inside a session they are free. They are
			// prefix matching though, so they come up empty on the wordier queries
			// ("cheap sushi near the station") that a text search still answers.
			// Paying for a text search only once predictions have failed keeps that
			// answer without paying for it on every ordinary lookup.
			if (sessionToken) {
				try {
					const hits = await suggestGoogle(q, near, kind, sessionToken);
					if (hits.length) return hits;
				} catch {
					// Fall through to the text search rather than to Photon: a failed
					// suggestion says nothing about whether Google is reachable.
				}
			}
			try {
				return await searchGoogle(q, near, kind);
			} catch {
				return searchPhoton(q, near, kind);
			}
		}
		return searchPhoton(q, near, kind);
	});
}

/**
 * Cached `placeDetails`, keyed by place ID.
 *
 * The token is not part of the key and is not part of what is stored: it
 * identifies a typing session, not a place. A cache hit therefore skips the
 * request that would have closed the session, which leaves that session
 * unterminated and its suggestions billed at the cheap per-request rate. That
 * is the right trade: not making a call is always cheaper than making one.
 */
export function placeDetailsCached(
	id: string,
	sessionToken?: string
): Promise<PlaceDetails | null> {
	return detailsCache.take(id, () => placeDetails(id, sessionToken));
}
