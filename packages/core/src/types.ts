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
 *   duration pinned. Its location, if it has one, is where it ends.
 * - `freetime` is an explicit absence of plan. It is the only type with no
 *   location, and it deliberately breaks the travel chain, because nobody can
 *   say where a person will be when the block ends.
 */
export const EVENT_TYPES = ['activity', 'food', 'stay', 'travel', 'freetime'] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(v: string): v is EventType {
	return (EVENT_TYPES as readonly string[]).includes(v);
}

/**
 * What each type is called, in one place.
 *
 * Display text, but it belongs beside the literals rather than beside any one
 * screen: the same five words are the labels in the client's type picker, the
 * words the API falls back to when a block has no name of its own, and the
 * words a future native client will need. There were already two copies of this
 * map, and two copies of a vocabulary is how "Free time" becomes "Freetime" on
 * one surface and not the other.
 *
 * Core stays pure, so this is a constant and nothing more: no formatting, no
 * locale lookup, no I/O. Translating it later means replacing the lookup at the
 * edges, and having one map is what makes that a single change.
 */
export const EVENT_TYPE_LABELS: Record<EventType, string> = {
	activity: 'Activity',
	food: 'Food',
	stay: 'Stay',
	travel: 'Travel',
	freetime: 'Free time'
};

/** What a type is called, for untrusted text: an unknown one is shown as it came. */
export function eventTypeLabel(t: string): string {
	return isEventType(t) ? EVENT_TYPE_LABELS[t] : t;
}

/**
 * Types that record where a person is, and so can carry coordinates.
 *
 * Free time is the one exclusion: it is deliberately nowhere, because nobody
 * has promised to be anywhere. Travel belongs here even though it is a journey
 * rather than a place, because the place it records is where it ends, which is
 * where the person is once it is over. Being here is not the same as being an
 * end of an automatic journey: nothing is ever planned *to* a travel event.
 * `planLegs` owns that distinction.
 */
export const LOCATED_EVENT_TYPES: readonly EventType[] = ['activity', 'food', 'stay', 'travel'];

export function isLocatedType(t: EventType): boolean {
	return LOCATED_EVENT_TYPES.includes(t);
}

/**
 * The minute a stay is drawn at on a day it covers.
 *
 * A stay is not really on the clock: it is a range of nights, and it is drawn
 * as a band rather than a block. But the journey home is a real journey, so the
 * stay has to enter the planner somewhere, and this is the minute it has always
 * been drawn at. It lives in core because the client replans a day as it is
 * edited and must anchor it at exactly the same minute the server does.
 */
export const STAY_CHECK_IN = 21 * 60;

/**
 * The shortest event that may be stored, in minutes.
 *
 * It is a display floor as much as a data rule: the grid draws a minute as a
 * pixel, so anything shorter has no room for its own title and becomes an
 * unreadable sliver. It lives in core because the server enforces it, the API
 * quotes it in its refusal, and the client has to offer the same floor in its
 * pickers, and three separate copies of the number would eventually disagree.
 */
export const MIN_EVENT_MINS = 15;

/** The last minute of a day, as the grid counts them: midnight ends the day. */
export const DAY_END_MIN = 24 * 60;

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
