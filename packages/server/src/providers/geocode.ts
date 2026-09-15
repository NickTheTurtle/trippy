/// <reference path="./tz-lookup.d.ts" />
// The reference above is deliberate. tz-lookup ships no types, and this file is
// type-checked by more than one tsconfig (its own package, and the SvelteKit app
// that reaches it through the workspace symlink). Binding the declaration to the
// file that needs it works under all of them; relying on a tsconfig `include`
// only works under the one that has it.
import tzlookup from 'tz-lookup';
import { haversineKm } from '@trippy/core/geo';

/** A city suggestion returned from geocoding, with an autofilled time zone. */
export interface CitySuggestion {
	name: string;
	country: string;
	/**
	 * The state / province / region the place sits in, when the geocoder knows
	 * one. Absent for city-states and small countries (Singapore, Monaco,
	 * Vatican City), so it is optional rather than an empty string: there is a
	 * difference between "no region exists" and "the region is blank", and only
	 * the former should make a client drop the line entirely.
	 */
	region?: string;
	lat: number;
	lng: number;
	tz: string;
}

/**
 * How close two same-named places in the same country must be before they are
 * treated as one place returned twice.
 *
 * Photon regularly returns more than one OSM node for a single settlement (a
 * `place:city` point and a `place:town` point for a suburb of the same name,
 * for instance); those sit within a couple of kilometres of each other. Two
 * genuinely distinct settlements that share a name are far further apart:
 * Springfield IL and Springfield MO are about 300 km apart, and the closest
 * same-name pairs anywhere are still tens of kilometres.
 *
 * Ten kilometres sits well clear of both. It is deliberately small, because the
 * two failure modes are not equal: dropping a real city makes it unreachable
 * (the bug being fixed here), while showing one city twice is only untidy.
 */
const DUPLICATE_RADIUS_KM = 10;

const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';

/**
 * Search for cities/towns by free text using the keyless Photon (OSM) geocoder.
 * Time zone is derived offline from the coordinates via tz-lookup, so the
 * organizer never has to pick a country or time zone by hand.
 */
export async function searchCities(query: string, gate?: () => void): Promise<CitySuggestion[]> {
	const q = query.trim();
	if (q.length < 2) return [];
	// This provider has no cache in front of it, so every call is a real request:
	// the gate is charged here, before the fetch, on each one. It throws through
	// to the route (a 429) when the caller is over quota. Photon is keyless today,
	// so the guard is defensive against hammering an external service rather than
	// a direct bill, but it keeps the geocode endpoint from being an open proxy.
	gate?.();
	const url = new URL(PHOTON_ENDPOINT);
	url.searchParams.set('q', q);
	url.searchParams.set('limit', '8');
	url.searchParams.set('lang', 'en');
	url.searchParams.set('osm_tag', 'place:city');
	url.searchParams.append('osm_tag', 'place:town');
	url.searchParams.append('osm_tag', 'place:village');
	let res: Response;
	try {
		res = await fetch(url, { headers: { 'User-Agent': 'Trippy-trip-planner' } });
	} catch {
		return [];
	}
	if (!res.ok) return [];
	const data = (await res.json()) as {
		features?: {
			properties?: { name?: string; country?: string; state?: string };
			geometry?: { coordinates?: [number, number] };
		}[];
	};
	const out: CitySuggestion[] = [];
	for (const f of data.features ?? []) {
		const name = f.properties?.name;
		const coords = f.geometry?.coordinates;
		if (!name || !coords) continue;
		const [lng, lat] = coords;
		if (typeof lat !== 'number' || typeof lng !== 'number') continue;
		let tz: string;
		try {
			tz = tzlookup(lat, lng);
		} catch {
			continue;
		}
		const country = f.properties?.country ?? '';
		const region = f.properties?.state?.trim();
		// Name plus country alone used to be the key, which collapsed every
		// same-named city in a country down to whichever one Photon happened to
		// list first: the second Springfield could not be picked at all, because
		// it never reached the client. Name plus region is no better in kind, it
		// just moves the collision one level down (two Springfields in one
		// state). So the name only groups candidates, and position decides: a
		// later hit is a duplicate only when it is within DUPLICATE_RADIUS_KM of
		// an already-accepted place of the same name in the same country.
		const duplicate = out.some(
			(s) =>
				s.name === name &&
				s.country === country &&
				haversineKm(s.lat, s.lng, lat, lng) <= DUPLICATE_RADIUS_KM
		);
		if (duplicate) continue;
		// `region` is omitted rather than set to undefined or '', so it never
		// serializes as a null field or reaches a client as the string
		// "undefined".
		out.push(region ? { name, country, region, lat, lng, tz } : { name, country, lat, lng, tz });
	}
	return out;
}
