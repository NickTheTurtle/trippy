import type { PoiKind } from '@trippy/core/types';

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
 * (`price_cents`, `you_voted`, `check_in`), while fields the API composes for a
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
	locked: number;
	check_in: string | null;
	check_out: string | null;
	photo: string | null;
	votes: number;
	/** 1 when the viewer's single per-city vote is on this stay. */
	you_voted: number;
};

export type DiscoverData = {
	cities: DiscoverCity[];
	/** Stays keyed by city id. */
	stays: Record<string, Stay[]>;
	/** Distinct members who have voted on a stay, keyed by city id. */
	staysVoted: Record<string, number>;
	/** The trip's home currency, which stay prices are denominated in. */
	currency: string;
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

/** The fields the search deliberately leaves out, fetched for one clicked place. */
export type PlaceHitDetails = Pick<
	PlaceHit,
	'url' | 'rating' | 'ratingCount' | 'priceLevel' | 'hours' | 'photo'
>;

/**
 * Row counts for one member, in one direction of the removal cascade.
 *
 * Composed by the API, hence camelCase. Mirrors `RemovalCounts` in
 * `@trippy/server/members`; only the fields the confirmation actually says out
 * loud are listed, because a field here that the UI never renders is a claim
 * nobody checks.
 */
export type RemovalCounts = {
	/** Expenses this person PAID. The whole expense row goes, with everyone's shares on it. */
	expensesPaid: number;
	expensesPaidCents: number;
	/** Shares this person owes. */
	expenseShares: number;
	/** OTHER members' shares that disappear with the expenses this person paid. */
	otherPeopleSharesLost: number;
	poiVotes: number;
	lodgingVotes: number;
	itemAssignments: number;
	taskAssignments: number;
	taskCompletions: number;
	partySegments: number;
	memberships: number;
};

/** `GET /trips/:tripId/people/:userId/removal-impact`. 404 when the member cannot be removed. */
export type RemovalImpact = {
	userId: string;
	name: string;
	/** Invited but never registered: removal deletes the user row itself. */
	isPlaceholder: boolean;
	isSeeded: boolean;
	/** True when the `users` row goes, which is what makes the cascade fire. */
	deletesUserRow: boolean;
	/** Rows in THIS trip that removal permanently destroys. */
	destroyed: RemovalCounts;
	/** The same, in the member's other trips. */
	destroyedElsewhere: RemovalCounts;
	/** Rows that survive but lose their member. */
	retained: RemovalCounts;
	sessionsEnded: number;
	/** True when removal genuinely changes who owes whom on this trip. */
	affectsSettlement: boolean;
};
