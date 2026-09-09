// Shared domain vocabulary for the Trip Planner.
// Kept framework-agnostic so both client and server import from here.

/**
 * The types a schedule item can carry.
 *
 * This list is the single source of truth: the server validates edits against
 * it and the calendar renders one label per literal. It is a value array with
 * the union derived from it, so the runtime check and the compile-time type
 * cannot drift apart.
 *
 * `food` and `transport` are the literals actually persisted and rendered, so
 * they are canonical; the older `meal` spelling was normalised away in a
 * migration (see docs/DESIGN.md section 2).
 */
export const ITEM_TYPES = ['poi', 'food', 'transport', 'travel', 'lodging', 'freetime'] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

export function isItemType(v: string): v is ItemType {
	return (ITEM_TYPES as readonly string[]).includes(v);
}

/**
 * The bucket a discovered place belongs to, as the traveller thinks of it.
 *
 * `pois.category` holds whatever the provider called the venue (a Google place
 * type, an OSM tag, or one of the display labels we map those onto), which is
 * free text and unstable. Discover filters on a fixed, stored bucket instead,
 * so the filter cannot depend on classifying provider text at render time.
 *
 * Stays are deliberately NOT a kind. They live in `lodging_options`, a
 * different table with prices, night ranges and one exclusive vote per city.
 * The Discover dropdown offers Attractions / Food & Drink / Stays, but the
 * third entry switches which table is being read, it is not a value here.
 */
export const POI_KINDS = ['attraction', 'food'] as const;

export type PoiKind = (typeof POI_KINDS)[number];

export function isPoiKind(v: string): v is PoiKind {
	return (POI_KINDS as readonly string[]).includes(v);
}

/**
 * Category strings that mean "somewhere you eat or drink".
 *
 * Covers both halves of what has ever been written into `pois.category`: our own
 * display labels (`Food`, `Nightlife`) and the raw provider types a place could
 * arrive with (`restaurant`, `cafe`, `meal_takeaway`, ...). Anything not listed,
 * including null and anything ambiguous, is an attraction.
 *
 * Nightlife counts as food and drink: the bucket is "Food & Drink", and a bar or
 * a club is not a sight to visit.
 */
export const POI_FOOD_CATEGORIES = [
	'food',
	'food & drink',
	'food and drink',
	'food_court',
	'nightlife',
	'restaurant',
	'cafe',
	'café',
	'coffee',
	'coffee_shop',
	'coffee shop',
	'bakery',
	'bar',
	'wine_bar',
	'pub',
	'brewery',
	'biergarten',
	'night_club',
	'nightclub',
	'meal_takeaway',
	'meal_delivery',
	'fast_food',
	'ice_cream',
	'dessert',
	'drinks'
] as const;

/** Best-effort bucket for a place from its provider category. Defaults to `attraction`. */
export function poiKindFromCategory(category: string | null | undefined): PoiKind {
	const c = (category ?? '').trim().toLowerCase();
	return (POI_FOOD_CATEGORIES as readonly string[]).includes(c) ? 'food' : 'attraction';
}

/** Coerce untrusted input into a kind. Anything unrecognised is an attraction. */
export function toPoiKind(v: unknown): PoiKind {
	return typeof v === 'string' && isPoiKind(v) ? v : 'attraction';
}
