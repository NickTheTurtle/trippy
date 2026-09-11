// Shared domain vocabulary for the Trip Planner.
// Kept framework-agnostic so both client and server import from here.

/**
 * The five things a scheduled event can be.
 *
 * This list is the single source of truth: the server validates writes against
 * it and the schedule renders one label per literal. It is a value array with
 * the union derived from it, so the runtime check and the compile-time type
 * cannot drift apart.
 *
 * The old vocabulary had six entries and two of them meant the same thing
 * (`transport` and `travel`), while `poi` named where the event came from
 * rather than what it is. Each of these five answers a different question the
 * travel planner has to ask:
 *
 * - `activity` and `food` are ordinary located stops. They differ only in how
 *   they are drawn, but that difference is worth a literal because a day is
 *   read by looking for the meals.
 * - `stay` is where the group sleeps. It is the one event that spans midnight,
 *   and it anchors both ends of the day: the first journey of the morning
 *   starts at last night's stay and the last one returns to tonight's.
 * - `travel` is a journey. Most are planned automatically from the events
 *   either side; a manually added one is the same record with its mode and
 *   duration pinned.
 * - `freetime` is an explicit absence of plan. It is the only type with no
 *   location, and it deliberately breaks the travel chain, because nobody can
 *   say where a person will be when the block ends.
 */
export const EVENT_TYPES = ['activity', 'food', 'stay', 'travel', 'freetime'] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(v: string): v is EventType {
	return (EVENT_TYPES as readonly string[]).includes(v);
}

/** Types that put a person somewhere, and so can be an end of a journey. */
export const LOCATED_EVENT_TYPES: readonly EventType[] = ['activity', 'food', 'stay'];

export function isLocatedType(t: EventType): boolean {
	return LOCATED_EVENT_TYPES.includes(t);
}

/**
 * How a journey is made.
 *
 * Ordered slowest to fastest over the ground, which is also roughly the order
 * a planner tries them in, so a picker rendered straight from this array reads
 * sensibly without a second list deciding the order.
 */
export const TRANSPORT_MODES = ['walk', 'cycle', 'transit', 'drive', 'ferry', 'flight'] as const;

export type TransportMode = (typeof TRANSPORT_MODES)[number];

export function isTransportMode(v: string): v is TransportMode {
	return (TRANSPORT_MODES as readonly string[]).includes(v);
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

/**
 * Category strings that mean "somewhere you sleep".
 *
 * A stay is not a `PoiKind`, so this cannot fold into `poiKindFromCategory`: it
 * answers a different question, "is this a hotel at all", for the one caller
 * that can act on the answer by switching which table the thing is added to.
 * Covers our own `Stay` label and the raw provider types a place can arrive
 * with.
 */
export const POI_STAY_CATEGORIES = [
	'stay',
	'stays',
	'lodging',
	'hotel',
	'hostel',
	'motel',
	'inn',
	'resort',
	'resort_hotel',
	'guest_house',
	'guesthouse',
	'bed_and_breakfast',
	'extended_stay_hotel',
	'apartment',
	'campground',
	'cottage',
	'farmstay'
] as const;

export function isStayCategory(category: string | null | undefined): boolean {
	const c = (category ?? '').trim().toLowerCase();
	return (POI_STAY_CATEGORIES as readonly string[]).includes(c);
}

/** Coerce untrusted input into a kind. Anything unrecognised is an attraction. */
export function toPoiKind(v: unknown): PoiKind {
	return typeof v === 'string' && isPoiKind(v) ? v : 'attraction';
}
