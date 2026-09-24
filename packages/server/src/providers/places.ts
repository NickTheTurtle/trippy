import { assertPaidProviderAllowed, env, PaidProviderBlockedError } from '../infra/env';
import { createPersistentCache, purgeCachedValues } from '../infra/cache';
import {
	noteProviderFailure,
	noteProviderOk,
	resetProviderHealth,
	serviceHealth,
	type ProviderFailure
} from './provider-health';

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
 * Maps a set of Google place types to one of our discover categories.
 *
 * Order matters and must run specific → generic. Google tags almost every venue
 * worth visiting as `tourist_attraction`, so testing that early collapsed the
 * whole map to "Sights": a `park,tourist_attraction` hill and a
 * `flea_market,market,tourist_attraction` bazaar both came back as Sights.
 *
 * Lodging is tested before food, which is not cosmetic: a hotel's type list
 * routinely contains `restaurant` and `food` because the hotel has a restaurant
 * in it. Hotel Gracery Shinjuku is `hotel, lodging, restaurant, food, ...`, and
 * with food first it was filed under Food & Drink.
 *
 * Returns null when nothing matched, so the caller can decide what an unknown
 * place is rather than being handed a guess.
 */
/**
 * Google types that mean "somewhere you can sleep".
 *
 * One set drives both jobs: deciding that a result belongs under Stays, and
 * keeping a stay search to places you can actually book. They were separate
 * before, and the search half was a single type (see `staySearchTypes`).
 */
const GOOGLE_LODGING = [
	'hotel',
	'lodging',
	'resort_hotel',
	'guest_house',
	'motel',
	'hostel',
	'bed_and_breakfast',
	'extended_stay_hotel',
	'budget_japanese_inn',
	'japanese_inn',
	'inn',
	'campground',
	'camping_cabin',
	'rv_park',
	'cottage',
	'farmstay',
	'private_guest_room'
] as const;

const LODGING_SET: ReadonlySet<string> = new Set(GOOGLE_LODGING);

/**
 * The five lodging types a stay autocomplete filters on.
 *
 * Five is Google's hard cap on `includedPrimaryTypes`, so this cannot be the
 * whole list and the choice matters. It used to be the single umbrella type
 * `lodging`, which looked right and returned almost nothing: the parameter
 * matches a place's *primary* type only, and Google gives a real hotel a
 * specific primary type (`hotel`, `hostel`, `resort_hotel`), reserving bare
 * `lodging` for the few places it cannot classify. The request stayed a 200
 * with an empty list, so nothing logged a failure and the provider health
 * endpoint went on reporting Google as healthy while every stay search came
 * back blank.
 *
 * These are the five with the widest real coverage. Anything rarer is caught
 * by the text search below, which filters on the full list instead.
 */
const LODGING_PRIMARY_TYPES = ['hotel', 'hostel', 'motel', 'resort_hotel', 'guest_house'];

/** True when a result's types say it is somewhere you can sleep. */
function isLodging(types: readonly string[], primaryType?: string): boolean {
	if (primaryType && LODGING_SET.has(primaryType)) return true;
	return types.some((t) => LODGING_SET.has(t));
}

function categoryOf(names: Set<string>): string | null {
	const has = (...wanted: string[]) => wanted.some((n) => names.has(n));
	// Google's finer-grained food types: `ramen_restaurant`, `sushi_restaurant`,
	// `chinese_restaurant` and a long tail more. Matching the suffix covers the
	// ones we have never heard of, which is most of them.
	const suffixed = (suffix: string) => [...names].some((n) => n.endsWith(suffix));

	if (has('amusement_center', 'amusement_park', 'video_arcade', 'bowling_alley')) return 'Activity';
	if (has(...GOOGLE_LODGING)) return 'Stay';
	if (
		has('restaurant', 'cafe', 'coffee_shop', 'bakery', 'food', 'meal_takeaway', 'food_court') ||
		suffixed('_restaurant') ||
		suffixed('_cafe')
	)
		return 'Food';
	if (has('bar', 'night_club', 'pub', 'wine_bar') || suffixed('_bar')) return 'Nightlife';
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
	if (has('tourist_attraction', 'point_of_interest')) return 'Sights';
	return null;
}

/**
 * The category for a place, preferring Google's own pick.
 *
 * `primaryType` is what Google considers the place to *be*, and it is decided
 * on its own before the rest of the list is read: a hotel is `hotel` first and
 * `restaurant` fourth, and a museum is `museum` first and `tourist_attraction`
 * first in `types`. Only when the primary type means nothing to us does the
 * full list get a say, and only then does an unknown place default to Sights.
 */
function googleCategory(types: string[], primaryType?: string): string {
	if (primaryType) {
		const own = categoryOf(new Set([primaryType]));
		if (own) return own;
	}
	return categoryOf(new Set(types)) ?? 'Sights';
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
	assertPaidProviderAllowed('google places text search');
	const key = env.GOOGLE_SERVER_KEY;
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
			maxResultCount: kind === 'stay' ? 20 : 8,
			...locationBias(near)
			// No `includedType` for a stay. It restricts on the *primary* type and
			// takes exactly one value, so the umbrella `lodging` that used to be
			// passed here matched almost nothing: Google gives a real hotel the
			// primary type `hotel`. The full type list is filtered below instead,
			// which matches on every type a place carries rather than just its
			// first, and costs no extra request because `places.types` is already
			// in the field mask.
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
	return (data.places ?? [])
		.filter((p) => kind !== 'stay' || isLodging(p.types ?? [], p.primaryType))
		.slice(0, 8)
		.map((p) => ({
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
	assertPaidProviderAllowed('google places autocomplete');
	const key = env.GOOGLE_SERVER_KEY;
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
			// (`includedPrimaryTypes`, a list) and, importantly, matches only the
			// place's *primary* type. See `LODGING_PRIMARY_TYPES` for why the
			// single umbrella `lodging` that used to be here matched nothing.
			...(kind === 'stay' ? { includedPrimaryTypes: LODGING_PRIMARY_TYPES } : {})
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
	assertPaidProviderAllowed('google place details');
	const key = env.GOOGLE_SERVER_KEY;
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

/** How many rows a search shows, whatever the provider was asked for. */
const PHOTON_RESULTS = 8;

/**
 * A Photon feature's properties, as far as we read them.
 *
 * `housenumber` and `postcode` are here because an address search needs them:
 * without the number, the Acropolis Museum's own row said "Dionysiou
 * Areopagitou, Athens, Greece", which is the street it is on rather than the
 * building, and matched a dozen other rows exactly.
 */
interface PhotonProps {
	name?: string;
	osm_key?: string;
	osm_value?: string;
	type?: string;
	housenumber?: string;
	street?: string;
	postcode?: string;
	city?: string;
	district?: string;
	state?: string;
	country?: string;
}

/**
 * The label for a feature, which is not always its name.
 *
 * A pure address has no `name` at all: OSM records it as a house number on a
 * street. Those rows were dropped by a `name` filter, which is why typing an
 * address returned everything except the address. Falling back to
 * "street number" gives them the label a person would have written.
 */
function photonLabel(pr: PhotonProps): string | null {
	if (pr.name?.trim()) return pr.name.trim();
	if (pr.street && pr.housenumber) return `${pr.street} ${pr.housenumber}`;
	if (pr.street) return pr.street;
	return null;
}

/**
 * The address line under the label.
 *
 * The house number is included, which it was not: it is the one part of a
 * street address that distinguishes a building from its street, and dropping it
 * is what made an address search unusable. The postcode comes with the city
 * because Photon returns several same-named streets in one city and the
 * postcode is often the only thing that tells the segments apart.
 */
function photonAddress(pr: PhotonProps): string | null {
	const street = pr.street && pr.housenumber ? `${pr.street} ${pr.housenumber}` : pr.street;
	const town = [pr.postcode, pr.city ?? pr.district].filter(Boolean).join(' ');
	const parts = [street, town, pr.country].filter(Boolean);
	return parts.length ? parts.join(', ') : null;
}

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
	// Names in English where OSM has one. Without this, searching "Acropolis
	// Museum" saved "Mouseio Akropolis": Photon answers in the local script by
	// default and the picked name is what lands on the board and in the
	// database. Verified against the live endpoint, which rejects an unsupported
	// value with a 400 listing what it takes: default, de, en, fr. So this is
	// the one useful setting rather than the user's locale.
	url.searchParams.set('lang', 'en');
	// Photon has no type filter, so lodging is filtered out of the response, and
	// a street with many segments floods the rows. Ask for more than we show so
	// both the filter and the de-duplication below have something to keep.
	url.searchParams.set('limit', kind === 'stay' ? '25' : '20');
	const res = await fetch(url, {
		headers: { 'User-Agent': 'Trippy-trip-planner' }
	});
	if (!res.ok) throw new Error(`photon ${res.status}`);
	const data = (await res.json()) as {
		features?: { properties?: PhotonProps; geometry?: { coordinates?: [number, number] } }[];
	};

	const rows: (PlaceResult & { street: boolean })[] = [];
	const seen = new Set<string>();
	for (const f of data.features ?? []) {
		const pr = f.properties ?? {};
		const name = photonLabel(pr);
		if (!name) continue;
		if (kind === 'stay' && !(pr.osm_key === 'tourism' && OSM_LODGING.has(pr.osm_value ?? ''))) {
			continue;
		}
		const address = photonAddress(pr);
		// Rows that read identically are one row as far as anybody choosing from
		// a list is concerned. Searching an address returned eight of them: OSM
		// splits a street into a segment per surface change, and each segment is
		// a feature with the same name, the same city and different coordinates,
		// so the list offered the same answer eight times with no way to tell
		// which was meant. The first is kept, which is the best-ranked one.
		const key = `${name}|${address ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		rows.push({
			id: null,
			name,
			category: osmCategory(pr.osm_key ?? '', pr.osm_value ?? ''),
			address,
			url: null,
			lat: f.geometry?.coordinates?.[1] ?? null,
			lng: f.geometry?.coordinates?.[0] ?? null,
			rating: null,
			ratingCount: null,
			priceLevel: null,
			hours: null,
			photo: null,
			source: 'osm' as const,
			street: pr.type === 'street'
		});
	}

	// A building before the street it stands on. Photon ranks a whole street
	// above the places on it often enough that the thing actually searched for
	// fell off the end of the list. Stable, so the provider's ranking still
	// decides everything else.
	const ordered = [...rows.filter((r) => !r.street), ...rows.filter((r) => r.street)];
	return ordered.slice(0, PHOTON_RESULTS).map(({ street: _street, ...row }) => row);
}

/**
 * Sentinel stored in `pois.photo` once we have asked Google for a photo and it
 * had none. Without it every page load would re-ask for the same misses, which
 * costs a Places call per card per view. `photoSrc()` treats it as "no photo"
 * because it is neither a `places/...` name nor a URL.
 */
export const NO_PHOTO = '-';

/** What a photo lookup found: the picture, and where the result actually is. */
export interface PhotoLookup {
	photo: string;
	lat: number | null;
	lng: number | null;
}

/**
 * Finds a cover photo for a place we already know about (seeded data, or a place
 * added before photos were wired up). Biased to the place's own coordinates when
 * we have them, so "Great Escape" resolves to the one in Athens rather than a
 * same-named venue on another continent.
 *
 * Returns the photo resource name (or NO_PHOTO when Google has no picture) and
 * the coordinates the same result carried. The coordinates ride along free: a
 * request is priced by the highest tier in its mask and `photos` is already
 * Enterprise, so asking for `location` costs nothing and is what lets a stay
 * typed by hand gain a position without a second billed lookup.
 *
 * Throws only on transport failure, so callers can tell "no photo" (cache it)
 * from "lookup broke" (try again later).
 */
export async function lookupPhoto(
	name: string,
	near: SearchNear,
	lat?: number | null,
	lng?: number | null
): Promise<PhotoLookup> {
	assertPaidProviderAllowed('google place photo lookup');
	const key = env.GOOGLE_SERVER_KEY;
	if (!key) return { photo: NO_PHOTO, lat: null, lng: null };

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
			'X-Goog-FieldMask': 'places.photos,places.location'
		},
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`google ${res.status}`);
	const data = (await res.json()) as {
		places?: {
			photos?: { name?: string }[];
			location?: { latitude?: number; longitude?: number };
		}[];
	};
	const top = data.places?.[0];
	return {
		photo: top?.photos?.[0]?.name ?? NO_PHOTO,
		lat: top?.location?.latitude ?? null,
		lng: top?.location?.longitude ?? null
	};
}

/** Which backend is configured, for the UI to label results. */
export function activeProvider(): 'google' | 'osm' {
	return env.GOOGLE_SERVER_KEY ? 'google' : 'osm';
}

// --- Provider health --------------------------------------------------------

/**
 * Places' view of the shared health record in `provider-health.ts`.
 *
 * The recording mechanism moved there so Routing could use the same one rather
 * than grow a second: both are the same Google key failing, and an operator
 * reading `/api/health` should not have to learn two vocabularies. What stays
 * here is the places-specific reading of it, because only this module knows
 * that the fallback is OpenStreetMap.
 */
export type { ProviderFailure };

export interface ProviderStatus {
	/** What configuration says: Google when a server key is set. */
	configured: 'google' | 'osm';
	/** What is actually answering, which is OSM once Google has failed. */
	serving: 'google' | 'osm';
	/** Set when `serving` is not `configured`. */
	lastFailure: ProviderFailure | null;
}

function noteGoogleFailure(op: string, err: unknown): void {
	noteProviderFailure('places', op, err);
}

/**
 * Configured vs. actually answering, for a health endpoint to report.
 *
 * Google counts as serving until it has failed, and counts as serving again as
 * soon as one call succeeds; a single 403 should not pin the report to "osm"
 * forever once the key is fixed. Unlike before, a failure recorded by an earlier
 * process still counts: `tsx watch` restarts on every save, and forgetting the
 * outage on restart was how this endpoint came to report green through one.
 */
export function providerStatus(): ProviderStatus {
	const configured = activeProvider();
	if (configured === 'osm') return { configured, serving: 'osm', lastFailure: null };
	const { failing, lastFailure } = serviceHealth('places');
	return {
		configured,
		serving: failing ? 'osm' : 'google',
		lastFailure: failing ? lastFailure : null
	};
}

/** Clears remembered failures, stored ones included. For tests. */
export function resetProviderStatus(): void {
	resetProviderHealth('all');
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
 * How long "no results" is worth keeping: ten minutes, not seven days.
 *
 * There is a real tension here. Never caching a miss means a query that
 * genuinely matches nothing re-bills on every retry, and as-you-type search
 * produces plenty of those. But an empty array is also exactly what a provider
 * outage returns, and a week-long TTL turns a five-minute outage into a
 * week-long one: two probe queries were pinned to `[]` in SQLite and stayed
 * broken after the provider recovered, with no way to fix them short of
 * deleting the database. Ten minutes keeps the anti-retry protection that
 * matters (a member hammering the same fruitless query, a board reloading)
 * while capping the blast radius of a bad answer at one coffee break.
 */
const EMPTY_RESULT_TTL_MS = 10 * 60 * 1000;

const searchTtl = (results: PlaceResult[]) =>
	results.length ? 7 * 24 * 60 * 60 * 1000 : EMPTY_RESULT_TTL_MS;

/**
 * Drops rows poisoned under the old policy: searches stored as `[]` with a
 * seven-day TTL while the provider was failing. Runs once at startup because it
 * is a single indexed-free DELETE over a small table, and because those rows
 * are unreachable-by-design garbage under the policy above rather than data.
 * Exported as `clearEmptySearchCache` for an operator who wants it on demand.
 */
export function clearEmptySearchCache(): number {
	return purgeCachedValues('search', ['[]']);
}

clearEmptySearchCache();

/**
 * Search for places. Uses Google Places when GOOGLE_SERVER_KEY is set,
 * otherwise the keyless OpenStreetMap (Photon) provider. Google falls back
 * to Photon if the request fails so discovery keeps working, and the failure is
 * logged and reflected in `providerStatus()` rather than swallowed.
 *
 * Results are cached per normalised query and city: the same search typed twice
 * costs one request, and simultaneous identical searches share one in flight.
 * An empty result is cached for minutes rather than days; see EMPTY_RESULT_TTL_MS.
 */
export async function searchPlaces(
	query: string,
	near: SearchNear,
	kind: SearchKind = 'place',
	sessionToken?: string,
	gate?: () => void
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
	return searchCache.take(
		key,
		async () => {
			// Charged only here, on a cache miss, so a repeat search served from cache
			// costs the caller no quota. Throws through `take` when over the ceiling,
			// which the route turns into a 429.
			gate?.();
			if (env.GOOGLE_SERVER_KEY) {
				// Suggestions first, because inside a session they are free. They are
				// prefix matching though, so they come up empty on the wordier queries
				// ("cheap sushi near the station") that a text search still answers.
				// Paying for a text search only once predictions have failed keeps that
				// answer without paying for it on every ordinary lookup.
				if (sessionToken) {
					try {
						const hits = await suggestGoogle(q, near, kind, sessionToken);
						if (hits.length) {
							noteProviderOk('places');
							return hits;
						}
					} catch (err) {
						// A blocked paid call is a bug in the caller, not an outage: it
						// must not be absorbed into a quiet OSM answer.
						if (err instanceof PaidProviderBlockedError) throw err;
						// Fall through to the text search rather than to Photon: a failed
						// suggestion says nothing about whether Google is reachable. Logged
						// all the same, because this is where a bad key shows up first.
						noteGoogleFailure('google places autocomplete', err);
					}
				}
				try {
					const hits = await searchGoogle(q, near, kind);
					noteProviderOk('places');
					return hits;
				} catch (err) {
					if (err instanceof PaidProviderBlockedError) throw err;
					noteGoogleFailure('google places text search', err);
					return searchPhoton(q, near, kind);
				}
			}
			return searchPhoton(q, near, kind);
		},
		searchTtl
	);
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
	sessionToken?: string,
	gate?: () => void
): Promise<PlaceDetails | null> {
	return detailsCache.take(id, async () => {
		// As with search: charged only on a miss, so re-opening a place already
		// looked at is free and never blocked.
		gate?.();
		try {
			const details = await placeDetails(id, sessionToken);
			noteProviderOk('places');
			return details;
		} catch (err) {
			if (err instanceof PaidProviderBlockedError) throw err;
			// Rethrown, not swallowed: the caller decides what an unavailable
			// detail means. Logged here so the reason is not lost on the way up.
			noteGoogleFailure('google place details', err);
			throw err;
		}
	});
}
