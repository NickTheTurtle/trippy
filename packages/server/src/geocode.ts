import tzlookup from 'tz-lookup';

/** A city suggestion returned from geocoding, with an autofilled time zone. */
export interface CitySuggestion {
	name: string;
	country: string;
	lat: number;
	lng: number;
	tz: string;
}

const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';

/**
 * Search for cities/towns by free text using the keyless Photon (OSM) geocoder.
 * Time zone is derived offline from the coordinates via tz-lookup, so the
 * organizer never has to pick a country or time zone by hand.
 */
export async function searchCities(query: string): Promise<CitySuggestion[]> {
	const q = query.trim();
	if (q.length < 2) return [];
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
	const seen = new Set<string>();
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
		const key = `${name}|${country}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ name, country, lat, lng, tz });
	}
	return out;
}
