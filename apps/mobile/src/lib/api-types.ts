/**
 * Response shapes the mobile client shares across screens.
 *
 * They are a copy of apps/web/src/lib/api-types.ts and follow the same
 * convention the API actually uses: rows read out of SQLite keep their
 * snake_case column names (`price_cents`, `you_voted`), while fields the API
 * composes are camelCase (`priceCents`, `memberCount`).
 *
 * These are declared here rather than imported from the web app because one
 * client must not depend on another. If they ever need to be shared, the home
 * for them is @trippy/core, which both may import.
 */
import type { PoiKind } from '@trippy/core/types';

export type Poi = {
	id: string;
	name: string;
	category: string;
	kind: PoiKind;
	notes: string | null;
	url: string | null;
	lat: number | null;
	lng: number | null;
	rating: number | null;
	rating_count: number | null;
	price_level: number | null;
	hours: string | null;
	photo: string | null;
	saved: number;
	votes: number;
	you_voted: number;
	voters: string[];
	linked: number;
};

export type DiscoverCity = {
	id: string;
	name: string;
	lat: number | null;
	lng: number | null;
	pois: Poi[];
};

export type Stay = {
	id: string;
	name: string;
	tag: string;
	price_cents: number | null;
	currency: string;
	url: string | null;
	locked: number;
	check_in: string | null;
	check_out: string | null;
	photo: string | null;
	votes: number;
	you_voted: number;
};

export type DiscoverData = {
	cities: DiscoverCity[];
	stays: Record<string, Stay[]>;
	currency: string;
	memberCount: number;
	isOrganizer: boolean;
	provider: 'google' | 'osm';
};

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
