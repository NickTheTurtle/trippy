import type { PoiKind } from './types';

/**
 * Response shapes the client shares across pages.
 *
 * These had been redeclared per page and had drifted from the wire: one page
 * declared `rating_count`, another `ratingCount`, a third `price_cents` where
 * the payload says `amountCents`. A type that does not match the JSON is worse
 * than none, because it type-checks a field that is always undefined.
 *
 * The convention the API actually follows, and the one recorded here: rows read
 * out of SQLite keep their **snake_case** column names on the way through
 * (`price_cents`, `you_voted`, `rating_count`), while fields the API composes for a
 * request body or a computed response are **camelCase** (`priceCents`,
 * `ratingCount`, `memberCount`). So a GET returns snake and a POST takes camel;
 * that is deliberate and is what these types say.
 */

/** A discovered place, as `GET /trips/:id/discover` returns it. */
export type Poi = {
	id: string;
	name: string;
	/** Whatever the provider called the venue. Free text, unstable, not filtered on. */
	category: string;
	/** The stored Discover bucket. This is what the filter reads. */
	kind: PoiKind;
	notes: string | null;
	url: string | null;
	lat: number | null;
	lng: number | null;
	rating: number | null;
	rating_count: number | null;
	price_level: number | null;
	/** A JSON array of weekday lines, still encoded. Use `parseHours`. */
	hours: string | null;
	photo: string | null;
	saved: number;
	votes: number;
	/** 1 when the viewer has voted for this place. */
	you_voted: number;
	/** Voter names, alphabetical. */
	voters: string[];
	/** Scheduled calendar items pointing at this place. */
	linked: number;
};

/** A city as Discover sees it: identity plus its pool of places. */
export type DiscoverCity = {
	id: string;
	name: string;
	lat: number | null;
	lng: number | null;
	pois: Poi[];
};

/** A proposed stay (`lodging_options`), which is a different table from places. */
export type Stay = {
	id: string;
	name: string;
	/** The single free-text line a stay carries. Posted as `notes` or `tag`. */
	tag: string;
	price_cents: number | null;
	currency: string;
	url: string | null;
	photo: string | null;
	votes: number;
	/** 1 when the viewer's single per-city vote is on this stay. */
	you_voted: number;
	/** Stay bands on the calendar booked into this stay. */
	linked: number;
};

export type DiscoverData = {
	cities: DiscoverCity[];
	/** Stays keyed by city id. */
	stays: Record<string, Stay[]>;
	/** The trip's home currency, which a stay with no currency of its own is in. */
	currency: string;
	/** Every currency the rate table knows, for the price field's dropdown. */
	currencies: string[];
	memberCount: number;
	isOrganizer: boolean;
	provider: 'google' | 'osm';
};

/**
 * One provider search result. `id` is the provider's and only Google results
 * carry one, which is what decides whether details can be fetched for it.
 */
export type PlaceHit = {
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
};

/**
 * The fields the search deliberately leaves out, fetched for one clicked place.
 *
 * The optional half is identity: when the results came from autocomplete they
 * carry only a name and an address, so this is where the picked one gets its
 * coordinates and category. Absent, not null, when the provider did not say.
 */
export type PlaceHitDetails = Pick<
	PlaceHit,
	'url' | 'rating' | 'ratingCount' | 'priceLevel' | 'hours' | 'photo'
> &
	Partial<Pick<PlaceHit, 'name' | 'address' | 'category' | 'lat' | 'lng'>>;
