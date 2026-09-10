import { env } from '../infra/env';
import { createCache } from '../infra/cache';

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
const GOOGLE_DETAILS = 'https://places.googleapis.com/v1/places/';
const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';

/**
 * Fields the search asks for. Under Places (New) the highest-tier field in the
 * mask prices the *whole* request, so asking a search for ratings and opening
 * hours buys the expensive data for eight results the user has not looked at
 * yet, of which they will keep one. This mask stays at the tier a search
 * genuinely needs: enough to render a name, an address and a map pin.
 */
const SEARCH_MASK =
	'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType';

/** The expensive half of the split, bought once for the one place that is clicked. */
const DETAILS_MASK =
	'rating,userRatingCount,priceLevel,regularOpeningHours,websiteUri,photos';

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
 * Fetches the fields the search skipped, for a single place the user has picked.
 *
 * This is the expensive half of the split search: one request per place actually
 * considered, rather than eight per keystroke-batch. Returns null when the
 * provider has no key or the id is unknown, so callers can just show what the
 * search already gave them.
 */
export async function placeDetails(id: string): Promise<PlaceDetails | null> {
	const key = env.GOOGLE_PLACES_KEY;
	if (!key || !id) return null;
	const res = await fetch(`${GOOGLE_DETAILS}${encodeURIComponent(id)}?languageCode=en`, {
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
	};
	return {
		url: p.websiteUri ?? null,
		rating: p.rating ?? null,
		ratingCount: p.userRatingCount ?? null,
		priceLevel: googlePriceLevel(p.priceLevel),
		hours: p.regularOpeningHours?.weekdayDescriptions ?? null,
		photo: p.photos?.[0]?.name ?? null
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
 * Place data is stable over hours, and a group researches the same city from a
 * dozen devices, so an uncached search bills once per member for an identical
 * question. Kept well inside Google's 30-day limit on caching place content.
 */
const searchCache = createCache<PlaceResult[]>(6 * 60 * 60 * 1000, 500);
const detailsCache = createCache<PlaceDetails | null>(24 * 60 * 60 * 1000, 1000);

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
	kind: SearchKind = 'place'
): Promise<PlaceResult[]> {
	const q = query.trim();
	if (q.length < MIN_QUERY) return [];
	// Case and inner spacing do not change what Google returns, so they must not
	// change the cache key either; "Acropolis  Museum" is the same question.
	// The whole `near` goes in: two trips can hold two different Nashvilles, and
	// keying on the name alone served one of them the other's results.
	const key = `${kind}|${q.toLowerCase().replace(/\s+/g, ' ')}|${nearText(near)}|${near.lat ?? ''},${near.lng ?? ''}`;
	return searchCache.take(key, async () => {
		if (env.GOOGLE_PLACES_KEY) {
			try {
				return await searchGoogle(q, near, kind);
			} catch {
				return searchPhoton(q, near, kind);
			}
		}
		return searchPhoton(q, near, kind);
	});
}

/** Cached `placeDetails`, keyed by place ID. */
export function placeDetailsCached(id: string): Promise<PlaceDetails | null> {
	return detailsCache.take(id, () => placeDetails(id));
}
