import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireMember } from '../middleware';
import { routingGate } from '../provider-quota';
import { body, int, isoDay, num, str, strList } from '../parse';
import { fail, goneMessage, okOr } from '../respond';
import type { Env, Trip } from '../types';
import { env } from '@trippy/server/env';
import {
	DAY_END_MIN,
	EVENT_TYPE_LABELS,
	isEventType,
	isLocatedType,
	isTransportMode,
	MIN_EVENT_MINS,
	type EventType
} from '@trippy/core/types';
import { formatDayRange } from '@trippy/core/tz';
import { guessLeg, routeKey } from '@trippy/core/travel';
import { daysBetween } from '@trippy/core/plan';
import {
	lastDayOf,
	MAX_SPAN_DAYS,
	normalizeSpan,
	onOneClock,
	spanProblem,
	type SpanRow,
	type ZoneOf
} from '@trippy/core/span';
import {
	isNameLength,
	isNotesLength,
	isOutsideTrip,
	MAX_NAME_LENGTH,
	nameTooLong,
	notesTooLong,
	stayNightsProblem
} from '@trippy/core/validate';
import {
	createEvent,
	crewsForTrip,
	currentPlaceName,
	currentType,
	dayCity,
	deleteEvent,
	editEvent,
	editedSpan,
	editLeg,
	eventTrip,
	eventVersion,
	eventsForDay,
	incomingStays,
	legsForDay,
	moveEvent,
	movable,
	movedSpan,
	movedStayCheckout,
	plannedLegsForDay,
	resizable,
	resizeEvent,
	saveAutoLeg,
	scheduleDays,
	scheduledDayAfter,
	scheduledDayBefore,
	scheduledDayEdges,
	setEventPeople,
	shiftDay,
	staysOnBoard,
	storedAutoLegs,
	strandedDayCount,
	dayHasEvents,
	STAY_CHECK_IN
} from '@trippy/server/schedule';
import { routeLegs } from '@trippy/server/routing';
import { savedPoisForTrip } from '@trippy/server/pois';
import { stayOptionsForTrip } from '@trippy/server/lodging';
import { providerStatus } from '@trippy/server/places';

export const schedule = new Hono<Env>();

schedule.use('*', requireMember);

export const SCHEDULE_LOCKED =
	'The schedule is locked. The organizer can unlock it to make changes.';

/**
 * A frozen board takes no writes.
 *
 * Guarded here rather than in each mutation because the point of the lock is
 * that it covers the whole page: a check per route is a check somebody adding
 * the next route can forget, and the failure would be silent. Reads are never
 * refused, so anyone can still look at the agreed plan.
 *
 * The lock is not a permission. It is set and cleared by the organizer from the
 * trip's edit dialog, and while it is on it holds against the organizer too,
 * which is the whole of its value: the accident it exists to stop is a drag by
 * whoever is looking at the board, and that is usually the person who built it.
 */
schedule.use('*', async (c, next) => {
	if (c.req.method !== 'GET' && c.get('trip').schedule_locked) {
		return fail(c, 403, SCHEDULE_LOCKED);
	}
	await next();
});

const VIEWS = ['day', 'agenda'] as const;
type ViewMode = (typeof VIEWS)[number];

/**
 * The 404 an event mutation answers with when the event is not this trip's.
 *
 * The mutations enforce this themselves (each takes the trip id and refuses a
 * foreign event), so this is not the security boundary; it only decides which
 * refusal the caller is told about. Without it a cross-trip id would come back
 * as the generic 403 "Not allowed", which is the wrong story: the event is not
 * missing permission in this trip, it is not in this trip at all. `eventTrip`
 * also returns null for an id that exists nowhere, and that is the same 404,
 * which is deliberate: it keeps a stranger from probing for real event ids.
 */
function foreignEvent(tripId: string, eventId: string): boolean {
	return eventTrip(eventId) !== tripId;
}

/**
 * What a request for a day the trip does not have is told.
 *
 * A 400 in this API is `{ error }` and nothing else, and that is still what the
 * message is read from. The extra fields are for the client's own recovery: the
 * board is reached by url, so the commonest way here is a bookmark left behind
 * by a trip whose dates were edited, and the honest fix is to send the reader to
 * a day that exists rather than to leave them on a dead url. Parsing the range
 * back out of the sentence is not a contract.
 *
 * `code` is there because the three refusals are genuinely different and only
 * one of them is the reader's typing:
 *
 *  - `not_a_date` the day in the url is not a date at all
 *  - `outside_trip` a real date, before or after everything the trip reaches
 *  - `day_not_offered` a real date inside the trip's reach, on neither its dates
 *    nor anything scheduled: the gap left behind when a trip was shortened under
 *    an event
 *
 * `firstDay` / `lastDay` are null on a trip with no dates and nothing scheduled,
 * which has no range to name; they are null rather than invented.
 */
type DayRefusal = 'not_a_date' | 'outside_trip' | 'day_not_offered';

function outOfRange(
	c: Context<Env>,
	reach: { first: string; last: string } | null,
	code: DayRefusal,
	message: string
) {
	return c.json(
		{ error: message, code, firstDay: reach?.first ?? null, lastDay: reach?.last ?? null },
		400
	);
}

/**
 * Fill in the automatic side of a day's travel, then read it back.
 *
 * Routing is done here rather than inside the persistence layer because it
 * reaches the network: a write should not wait on a provider, and a read that
 * cannot reach one should still answer with the straight-line estimate. The
 * provider's answer is stored (`saveAutoLeg`) rather than returned directly so
 * the next load of the same day is instant and so an override can be compared
 * against what the automatic answer would have been.
 *
 * A journey whose stored answer is already a real route in the mode it wants is
 * not asked about again. Every leg used to go to `routeLegs` on every load, and
 * the route cache is in memory, so each restart of the API (every saved file,
 * under `tsx watch`) re-bought every leg of every day anybody opened. A stored
 * straight-line guess is still retried, because it is only there because the
 * provider could not answer at the time. Changing the mode is a different
 * question, and so is moving either end: the stored answer carries the
 * `routeKey` (mode plus both endpoints' coordinates) it was bought for, and is
 * only reused while that still matches. The leg key is just the pair of
 * events, so without it a route survived its events being moved anywhere.
 */
async function dayLegs(tripId: string, day: string, canBill?: () => boolean) {
	const planned = plannedLegsForDay(tripId, day);
	if (planned.length) {
		const stored = new Map(legsForDay(tripId, day).map((l) => [l.key, l]));
		const known = storedAutoLegs(tripId, day);
		const question = (leg: (typeof planned)[number]) =>
			routeKey(leg, stored.get(leg.key)?.mode ?? guessLeg(leg.km).mode);
		const toRoute = planned.filter((leg) => {
			const auto = known.get(leg.key);
			return !(auto?.routed && auto.autoMins != null && auto.routeKey === question(leg));
		});
		if (toRoute.length) {
			const byKey = new Map(toRoute.map((leg) => [leg.key, leg]));
			const routed = await routeLegs(
				toRoute,
				(leg) => stored.get(leg.key)?.mode ?? undefined,
				canBill
			);
			for (const [key, r] of routed) {
				const leg = byKey.get(key);
				const asked = leg ? routeKey(leg, r.mode) : null;
				saveAutoLeg(tripId, day, key, r.mode, r.mins, r.routed, asked);
			}
		}
	}
	return legsForDay(tripId, day);
}

/**
 * The trip's own date range, when it has a usable one.
 *
 * Reversed endpoints are treated as no range at all rather than walked: a range
 * that ends before it starts describes no days, and the schedule's reach then
 * comes from what is actually scheduled.
 */
function tripRange(
	start: string | null,
	end: string | null
): { start: string; end: string } | null {
	const from = isoDay(start);
	const to = isoDay(end);
	return from && to && from <= to ? { start: from, end: to } : null;
}

/** Whole days from `start` to `end` inclusive. Arithmetic, so no walk. */
function spanDays(start: string, end: string): number {
	return daysBetween(start, end) + 1;
}

/**
 * How far the trip reaches, and how many days that is.
 *
 * This is the same definition the day list has always had - the date range
 * union everything scheduled outside it, so an event stranded by a shortened
 * trip stays reachable - but answered without building the list. That matters
 * because the list used to *be* the answer, and building it needed a stopping
 * rule: `for (let d = from, i = 0; d <= to && i < 400; ...)`. Four hundred was
 * a guard against a reversed or absurd range walking forever, not a considered
 * limit, and it silently truncated any real trip longer than it. The Montreal
 * trip runs 2024-09-09 to 2026-09-12, so its last eleven months were not served
 * at all and every request for a day in them was answered with 2025-10-13.
 *
 * Edges come from `MIN`/`MAX` over the events table, so the cost is the same
 * whether the trip is a weekend or a decade, and no number in here decides how
 * far a trip may run.
 */
function tripReach(
	tripId: string,
	range: { start: string; end: string } | null
): { first: string; last: string; count: number } | null {
	const edges = scheduledDayEdges(tripId);
	if (!range) {
		if (!edges.first || !edges.last) return null;
		return { first: edges.first, last: edges.last, count: scheduleDays(tripId).length };
	}
	return {
		first: edges.first && edges.first < range.start ? edges.first : range.start,
		last: edges.last && edges.last > range.end ? edges.last : range.end,
		count: spanDays(range.start, range.end) + strandedDayCount(tripId, range.start, range.end)
	};
}

/**
 * Whether the trip offers `day` at all.
 *
 * Offered is the date range union the days that carry something, which is the
 * set the arrows walk: a day stranded outside a shortened range is offered, and
 * so are all the days inside the range, empty or not. The gap between a
 * stranded day and the range is neither, and answering for it would be the same
 * fiction as the clamp - a board for a day the trip does not have.
 *
 * Two indexed reads at most, and neither depends on how long the trip is.
 */
function offersDay(
	tripId: string,
	range: { start: string; end: string } | null,
	reach: { first: string; last: string },
	day: string
): boolean {
	if (day < reach.first || day > reach.last) return false;
	if (range && day >= range.start && day <= range.end) return true;
	return dayHasEvents(tripId, day);
}

/**
 * The next day the trip offers in `delta`'s direction, or null at the end.
 *
 * The arrows step through what the trip offers, which is not the calendar: a
 * day stranded outside a shortened range is offered, and the empty days between
 * it and the range are not. So the answer is the nearest of two candidates -
 * the neighbouring day inside the range, and the nearest day carrying anything
 * - rather than `day ± 1`.
 *
 * Served as a field because the client used to derive it by finding the day in
 * the list and taking the next index, which only works while the whole list is
 * in the payload.
 */
function stepDay(
	tripId: string,
	range: { start: string; end: string } | null,
	day: string,
	delta: 1 | -1
): string | null {
	const forward = delta === 1;
	const inRange = range
		? forward
			? day < range.start
				? range.start
				: day < range.end
					? shiftDay(day, 1)
					: null
			: day > range.end
				? range.end
				: day > range.start
					? shiftDay(day, -1)
					: null
		: null;
	const scheduled = forward ? scheduledDayAfter(tripId, day) : scheduledDayBefore(tripId, day);
	const options = [inRange, scheduled].filter((d): d is string => d !== null);
	if (!options.length) return null;
	return forward
		? options.reduce((a, b) => (b < a ? b : a))
		: options.reduce((a, b) => (b > a ? b : a));
}

/**
 * How many days the payload is willing to list at once.
 *
 * The list is no longer what decides which days exist - `firstDay`, `lastDay`,
 * `prevDay` and `nextDay` do, and every one of them is answered without it - so
 * this is a payload bound rather than a reach bound. It is deliberately far
 * above any real trip (eleven years) so that the window is never what a member
 * runs into: the trip form caps a new trip at 366 days, and the longest trip in
 * the database is 730. If the list is ever dropped from the payload, nothing
 * about which days are reachable changes.
 */
const MAX_DAY_LIST = 4000;

/**
 * The days the trip offers, as a window around the one being drawn.
 *
 * One code path for every trip length, which is the point: a trip shorter than
 * the window gets its whole self, byte for byte what it got before there was a
 * window at all, because the clamps collapse rather than because there is a
 * branch testing its length. Two behaviors would be two things to reason about,
 * and the one that only shows up on long trips is the one nobody can test by
 * looking at the app.
 *
 * Centred on `day` rather than anchored at `first` so a trip long enough to
 * exceed the window still lists days either side of the reader, and slid back
 * off the end rather than truncated there, so the window is the same size
 * wherever in a long trip it is taken. At length 1, `from` and `to` are both
 * that day.
 */
function tripDays(
	tripId: string,
	range: { start: string; end: string } | null,
	reach: { first: string; last: string },
	day: string
): string[] {
	const half = Math.floor(MAX_DAY_LIST / 2);
	// The latest start that still reaches the end of the trip, so a window taken
	// at the far end fills backwards instead of coming up short.
	const latest = shiftDay(reach.last, -(MAX_DAY_LIST - 1));
	const back = shiftDay(day, -half);
	const slid = back > latest ? latest : back;
	const from = slid > reach.first ? slid : reach.first;
	const edge = shiftDay(from, MAX_DAY_LIST - 1);
	const to = edge < reach.last ? edge : reach.last;
	const days = new Set(scheduleDays(tripId).filter((d) => d >= from && d <= to));
	if (range) {
		const walkFrom = from > range.start ? from : range.start;
		const walkTo = to < range.end ? to : range.end;
		for (let d = walkFrom; d <= walkTo; d = shiftDay(d, 1)) days.add(d);
	}
	return [...days].sort();
}

schedule.get('/', async (c) => {
	const trip = c.get('trip');

	const range = tripRange(trip.start_date, trip.end_date);
	const reach = tripReach(trip.id, range);

	// The trip's own start comes first, ahead of the earliest scheduled day. It
	// used to be the other way around, and a single event saved on a mistyped
	// date was then enough to make a bare /schedule open on the year 1900 for
	// every member of the trip, with no previous arrow and nothing but empty
	// board ahead. The stray day is still reachable, because it is still inside
	// the trip's reach; it just no longer decides where everybody starts.
	const fallback = range?.start ?? reach?.first ?? new Date().toISOString().slice(0, 10);
	const viewRaw = c.req.query('view') ?? 'day';
	const view: ViewMode = VIEWS.includes(viewRaw as ViewMode) ? (viewRaw as ViewMode) : 'day';

	/* A day the trip does not have is refused, not quietly swapped.
	 *
	 * This used to clamp: a request for a day past the end came back 200 with
	 * the last day on it, so the url said one thing and the board drew another,
	 * and there was nothing in the response to tell the client they had parted
	 * company. Paired with a day list truncated at 400, that turned a genuine
	 * bug (the last eleven months of a two-year trip were not served) into a
	 * silent one: the board looked like it had answered.
	 *
	 * Two cases, kept distinguishable:
	 *
	 *  - Not a date at all, or a date outside what the trip offers: a client
	 *    error, 400, with the range named and carried as `firstDay`/`lastDay` so
	 *    the caller can send the reader somewhere real rather than parse prose.
	 *  - A date inside what the trip offers: always served, whatever `days`
	 *    happens to list. The list is a window; it never decides which day the
	 *    board draws.
	 *
	 * `day` is fed to shiftDay(), so a malformed one would build an Invalid Date
	 * and throw inside toISOString(): the refusal comes before any use of it.
	 *
	 * The reach is the date range union anything scheduled outside it, so an
	 * event stranded by a shortened trip is still inside and still reachable. */
	const asked = c.req.query('day');
	const requested = asked ? isoDay(asked) : fallback;
	if (!requested) return outOfRange(c, reach, 'not_a_date', 'That is not a date.');
	if (reach && (requested < reach.first || requested > reach.last)) {
		return outOfRange(
			c,
			reach,
			'outside_trip',
			`That day is outside this trip, which runs ${formatDayRange(reach.first, reach.last)}.`
		);
	}
	if (reach && !offersDay(trip.id, range, reach, requested)) {
		// Inside the reach but on neither the dates nor anything scheduled, which
		// only happens to a trip that was shortened under an event: the stranded
		// day is still offered, the empty days between it and the range are not.
		return outOfRange(
			c,
			reach,
			'day_not_offered',
			range
				? `The trip does not cover that day. Its dates run ${formatDayRange(range.start, range.end)}, and nothing is scheduled on it.`
				: 'Nothing is scheduled on that day.'
		);
	}
	const day = requested;
	const days = reach ? tripDays(trip.id, range, reach, day) : [day];
	const prevDay = reach ? stepDay(trip.id, range, day, -1) : null;
	const nextDay = reach ? stepDay(trip.id, range, day, 1) : null;

	// Cities are dateless itinerary places, so a day is not assigned one. It is
	// read off the one booking that says where somebody is on a date, a stay at
	// a lodging option (`cityOfDay`), with the first city as the trip-wide
	// default. It frames the day view's map and is the clock a block created on
	// the day without a city of its own starts on; the pins themselves come from
	// the events, which do know where they are.
	const cell = (city: Trip['cities'][number] | null | undefined) =>
		city ? { id: city.id, name: city.name, tz: city.tz, lat: city.lat, lng: city.lng } : null;
	const cityOn = (on: string) => trip.cities.find((x) => x.id === cityOfDay(trip, on)) ?? null;

	/* The day being read, and the one either side of it.
	 *
	 * The board is a strip that scrolls sideways and settles on a day, so the
	 * neighbours have to be drawn before the reader reaches them: a strip that
	 * fetched the next day when the scroll began would show an empty column for
	 * as long as the round trip took, which is the whole of the gesture.
	 *
	 * Three and no more. The reach is the whole trip, and the trip can be four
	 * hundred days; the strip covers it by recycling this window as it settles
	 * rather than by listing it, which keeps the cost of a board flat in the
	 * length of the trip. Each day costs a routing pass on its first load, so
	 * the count here is a bill as well as a payload.
	 *
	 * The agenda is served the same three. It has no strip, but a step that
	 * waited a round trip held the old day on screen under the new date; with
	 * the neighbours already here the next day is drawn on the tap. The routing
	 * pass that buys is one the next step would have paid anyway, and it is
	 * saved, so it is paid once per day rather than once per look.
	 */
	const drawn = [prevDay, day, nextDay].filter((d): d is string => d !== null);

	const board = await Promise.all(
		drawn.map(async (on) => ({
			day: on,
			city: cell(cityOn(on)),
			events: eventsForDay(trip.id, on),
			// The day's lodgings, drawn as a band rather than a block: a stay is a
			// range of days, so it is on every day it covers, the morning of
			// checkout included, and there may be more than one when the group
			// sleeps in more than one place.
			stays: staysOnBoard(trip.id, on),
			// Where the morning starts. The client needs it to plan the day's travel
			// the same way the server does, which is what lets an unsaved change to
			// who is going redraw the journeys as it is typed. It overlaps `stays`
			// on every day but the first: the same row answers both questions.
			incoming: incomingStays(trip.id, on),
			legs: await dayLegs(trip.id, on, routingGate(c.get('user').id))
		}))
	);

	return c.json({
		days,
		day,
		view,
		/* What the trip reaches, answered without the list.
		 *
		 * `days` used to be the only statement of this, so anything it left out
		 * did not exist as far as the client was concerned. These four are each
		 * derived from the trip's dates and a `MIN`/`MAX` over its events, so
		 * they stay correct at any trip length and the list can shrink or go
		 * away without changing what is reachable. `dayCount` is what the trip
		 * offers in total, which is not `days.length` on a trip long enough to
		 * exceed the window. */
		firstDay: reach?.first ?? day,
		lastDay: reach?.last ?? day,
		dayCount: reach?.count ?? 1,
		prevDay,
		nextDay,
		board,
		members: trip.memberList,
		me: c.get('user').id,
		crews: crewsForTrip(trip.id),
		saved: savedPoisForTrip(trip.id),
		// What a stay block can be booked into. Kept beside `saved` rather than
		// mixed into it: the picker offers one list or the other, never both, and
		// an id that means a place in one row and a stay in the next is how an
		// event ends up linked to the wrong table.
		stays: stayOptionsForTrip(trip.id),
		cities: trip.cities.map((x) => cell(x)),
		// Who is answering the place field's search, which is only ever needed for
		// the attribution line under its results. `serving` rather than what is
		// configured: a broken Google key means OSM is answering, and crediting
		// the wrong provider is the one thing an attribution must not do.
		provider: providerStatus().serving,
		mapsKey: env.GOOGLE_MAPS_KEY ?? ''
	});
});

// --- Events -----------------------------------------------------------------

/**
 * Turn what the place field was left holding into the place an event sits at.
 *
 * A stay is booked into a proposed stay and everything else is scheduled at a
 * saved place, so the type decides which list the id is looked up in and which
 * column the link is written to. Mixing the two would let a stay claim a museum
 * and a lunch claim a hotel room, and the Discover card that counts what is on
 * the calendar would count neither.
 *
 * An unknown id unlinks rather than fails: the alternative is an event that
 * claims a place the trip no longer saves.
 *
 * A name that was typed rather than picked resolves to itself, with no
 * coordinates. That is the whole of the feature: the event is named after
 * somewhere the trip has not saved, and the map and the travel chain both read
 * coordinates, so it stays out of each rather than being guessed onto them.
 */
function placeFor(tripId: string, type: EventType, pickedId: string, typed: string) {
	if (!pickedId) {
		const text = typed.trim();
		return text ? { text, lat: null, lng: null } : null;
	}
	if (type === 'stay') {
		const stay = stayOptionsForTrip(tripId).find((s) => s.id === pickedId);
		return stay && { lodgingId: stay.id, name: stay.name, lat: stay.lat, lng: stay.lng };
	}
	const poi = savedPoisForTrip(tripId).find((p) => p.id === pickedId);
	return poi && { poiId: poi.id, name: poi.name, lat: poi.lat, lng: poi.lng };
}

/** What a resolved place is called, whether it was picked or typed. */
function placeName(place: ReturnType<typeof placeFor>): string {
	if (!place) return '';
	return ('name' in place ? place.name : place.text) ?? '';
}

/** The type an edited block is ending up as: the one it was sent, or the stored one. */
function editedType(eventId: string, sent: unknown): EventType {
	const raw = sent == null ? currentType(eventId) : String(sent);
	return isEventType(raw) ? raw : 'activity';
}

/**
 * What a block with no name of its own is called, per type.
 *
 * The type's own noun rather than a single generic string: a board row reading
 * "Activity" or "Food & Drinks" still says something about the block, where a
 * column of identical "New event"s says nothing and is harder to tell apart at
 * a glance. `Travel` and `Free time` were already the defaults for their types,
 * so this only extends the rule the route already had to the other three.
 *
 * Read from `@trippy/core` rather than written out again here. These words were
 * duplicated deliberately once, on the grounds that core owns literals and not
 * display text, and the duplicate is what a rename has to remember: the picker
 * said one thing and a block named by the server said another. Core carries the
 * map now, so there is one copy and a rename reaches both.
 */
const TYPE_TITLES: Record<EventType, string> = EVENT_TYPE_LABELS;

/**
 * A derived name cut down to something the title column will take.
 *
 * Only ever applied to text the organiser did not type into the name field: a
 * place name from a provider, or a line of notes. Refusing those with a 400
 * would be refusing a field nobody filled in, so an over-long one is shortened
 * instead. The cut prefers a word boundary, but only when that still leaves at
 * least half the limit, so a single very long word is not sliced back to a
 * couple of characters. One character is held back for the ellipsis so the
 * result is always within the limit, and the ellipsis is what tells a reader
 * the name is a summary rather than the whole line.
 *
 * Runs of whitespace collapse first: a notes line pasted with a tab or a double
 * space in it is the same title either way.
 */
function fitName(text: string): string {
	const clean = text.replace(/\s+/g, ' ').trim();
	if (isNameLength(clean)) return clean;
	const cut = clean.slice(0, MAX_NAME_LENGTH - 1);
	const space = cut.lastIndexOf(' ');
	const body = space >= MAX_NAME_LENGTH / 2 ? cut.slice(0, space) : cut;
	return `${body.trimEnd()}…`;
}

/**
 * The first line of a note, as a title.
 *
 * "First line" means the first line with anything on it, on either line ending:
 * a note that opens with a blank line, which is what a paste out of a document
 * tends to look like, should be named after its first real sentence rather than
 * fall through to the type's noun. Nothing else about the text is interpreted:
 * a leading "- " or "# " is left exactly as typed, because guessing at markup
 * would mangle a title that genuinely starts with a dash, and the organiser can
 * always type a name if the derived one reads badly.
 */
function firstNoteLine(notes: string): string {
	return notes.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
}

/**
 * The name an event ends up with when the client sent none.
 *
 * In order: the place that was picked, then the first line of the notes, then
 * the type's own noun, which never being empty is what makes the name genuinely
 * optional on the wire. Picking a place is the primary way things get added, so
 * it stays ahead of the notes; the notes are the next thing an organiser has
 * actually written about this block.
 *
 * Free time is nowhere by definition, so it never takes a place's name, which
 * keeps this agreeing with what create does when it skips the lookup entirely.
 *
 * The type's noun is `EVENT_TYPE_LABELS` from `@trippy/core/types` rather than
 * a copy kept here. A board row reading "Activity" or "Food" still says
 * something about the block where a column of identical "New event"s says
 * nothing, and reading the one map is what stops a block named after its type
 * coming out as "Freetime" here and "Free time" on the screen that shows it.
 */
function derivedTitle(type: EventType, placeName: string, notes: string): string {
	const fromPlace = isLocatedType(type) ? fitName(placeName) : '';
	return fromPlace || fitName(firstNoteLine(notes)) || EVENT_TYPE_LABELS[type];
}

/**
 * Whether a day falls outside the trip, for a write that is choosing one.
 *
 * Reads are deliberately more forgiving than writes: a read still serves
 * anything already scheduled outside the range, so an event stranded by a later
 * change to the trip's dates stays reachable. This is only about refusing to
 * create the stranded row in the first place. A single event saved on a
 * mistyped year was enough to be unreachable in practice and to drag the whole
 * board's default day back to it.
 *
 * A trip missing either endpoint cannot bound anything, so it bounds nothing.
 */
function outsideTrip(trip: Trip, day: string): boolean {
	return isOutsideTrip(day, isoDay(trip.start_date), isoDay(trip.end_date));
}

/**
 * Whether a stay checking out on `checkout` would spend a night outside the
 * trip. The rule itself is core's (`stayNightsProblem`), shared with the
 * Discover stay routes so the board and the lodging card cannot disagree about
 * which stays fit: the last night must be a trip day, so a checkout may fall on
 * the morning after the trip ends and no later.
 */
function checkoutOutsideTrip(trip: Trip, checkout: string): boolean {
	const from = isoDay(trip.start_date);
	const to = isoDay(trip.end_date);
	return stayNightsProblem(null, checkout, from, to) === 'outside';
}

/** What a day outside the trip is told, with the range quoted back. */
function outsideTripMessage(trip: Trip): string {
	return `That date is outside the trip, which runs ${trip.start_date} to ${trip.end_date}.`;
}

/*
 * --- Events that run past their own day -------------------------------------
 *
 * The rules are core's (`packages/core/src/span.ts`): where the block sits on
 * each day, how long it really is across days and zones, and what is wrong with
 * it. This layer only has the trip to hand, so it supplies the trip's zones and
 * dates and turns core's answer into a sentence. The sentences are the ones
 * under `copy.schedule.span` that the dialogs show before a save is sent, so a
 * refusal from here reads the same as one from the form.
 */

/** The zone of each of the trip's cities, which a span's two ends are read in. */
function zonesOf(trip: Trip): ZoneOf {
	const zones = new Map(trip.cities.map((city) => [city.id, city.tz]));
	return (cityId) => (cityId ? zones.get(cityId) : null);
}

/**
 * The city a day is spent in: the one its earliest stay's lodging belongs to
 * (`dayCity`), else the trip's first. The same answer is `BoardDay.city` and
 * the city a block created without one is stored in, so the clock a start is
 * read on is the one the board showed the day on, and the arrival city of a
 * journey is compared against the city it really leaves from.
 */
function cityOfDay(trip: Trip, day: string): string | null {
	const booked = dayCity(trip.id, day);
	const known = booked && trip.cities.some((city) => city.id === booked) ? booked : null;
	return known ?? trip.cities[0]?.id ?? null;
}

const END_BEFORE_START = 'The end must be after the start.';
const SPAN_TOO_LONG = `An event can run for at most ${MAX_SPAN_DAYS} days.`;
const END_OUTSIDE_TRIP = 'Pick an end date within the trip.';
const PICK_TRIP_CITY = 'Pick a city on this trip.';

/** A span in its stored form, which is the form every check below judges. */
function settled(trip: Trip, row: SpanRow): SpanRow {
	return { ...row, ...normalizeSpan(row, zonesOf(trip)) };
}

/**
 * Whether a span is a block on one clock on one day once it is in its stored
 * form, which is when the old one-day rules (an end at least the shortest
 * block after the start, a length that fits in the day) apply rather than
 * `spanProblem`. Settled first, so a block that runs to 00:00 tomorrow is the
 * one-day block ending at midnight it will be stored as.
 */
function oneClock(trip: Trip, row: SpanRow): boolean {
	return onOneClock(settled(trip, row), zonesOf(trip));
}

/**
 * What is wrong with a timed event's span, for a write about to store it, or
 * null. A stay, and a block on one clock on one day, are judged elsewhere by
 * the rules they always had.
 *
 * An end day before the start day is caught before the span is settled, which
 * would otherwise read it as "its own day". An arrival city that is not one of
 * the trip's is refused rather than dropped, as `cityId` is; it is only read
 * on a journey, so any other type is not asked about it.
 */
function spanRefusal(trip: Trip, row: SpanRow): string | null {
	if (row.type === 'stay') return null;
	if (row.end_day && row.end_day < row.day) return END_BEFORE_START;
	if (
		row.type === 'travel' &&
		row.end_city_id &&
		!trip.cities.some((city) => city.id === row.end_city_id)
	) {
		return PICK_TRIP_CITY;
	}
	const span = settled(trip, row);
	const zoneOf = zonesOf(trip);
	if (onOneClock(span, zoneOf)) return null;
	const problem = spanProblem(span, zoneOf);
	if (problem === 'too-long') return SPAN_TOO_LONG;
	if (problem) return END_BEFORE_START;
	if (outsideTrip(trip, lastDayOf(span))) return END_OUTSIDE_TRIP;
	return null;
}

/**
 * The end day a body asked a non-stay block for: a day, null for "its own
 * day" (sent as null or empty), or undefined when the body did not say.
 */
function sentEndDay(v: unknown): string | null | undefined {
	if (v === undefined) return undefined;
	if (v === null || v === '') return null;
	return isoDay(v) ?? undefined;
}

/** The arrival city a body asked for: an id, null to clear, or undefined when silent. */
function sentEndCity(v: unknown): string | null | undefined {
	if (v === undefined) return undefined;
	return str(v) || null;
}

/** What a participant list of nothing but strangers is told. */
const STRANGERS_MESSAGE = "Nobody in that list is on this trip. Pick from the trip's members.";

/**
 * Whether a named participant list resolves to nobody the trip has.
 *
 * An empty list is not this. Empty is how "everyone" is written, on the wire
 * and in storage alike: `event_people` holds no rows for such an event and the
 * roster is put back on the way out, which is the only form that survives
 * somebody joining the trip later. The client says everyone by sending `[]`,
 * so refusing `[]` would refuse the commonest save there is. "Nobody" is
 * therefore not a state this model can hold, and free time, not an empty list,
 * is how the schedule says somebody is not involved.
 *
 * A list that names people and names only strangers is a different thing: a
 * real mistake, and the one genuinely wrong participant payload that can be
 * expressed here. Ids from another trip, or ids of people who have since left,
 * were quietly dropped by `writePeople` and the event then read back as
 * everyone, which is the opposite of what was asked for. Caught here rather
 * than at the persistence boundary because this is the layer that still has
 * somewhere to put the reason, and because a partial list must keep working:
 * four members and one stale id still saves the four, exactly as before.
 */
function allStrangers(trip: Trip, people: string[]): boolean {
	if (!people.length) return false;
	const members = new Set(trip.memberList.map((m) => m.id));
	return !people.some((id) => members.has(id));
}

schedule.post('/events', async (c) => {
	const trip = c.get('trip');
	const b = await body(c);

	const day = isoDay(b.day);
	if (!day) return fail(c, 400, 'Pick a day.');
	if (outsideTrip(trip, day)) return fail(c, 400, outsideTripMessage(trip));

	// The vocabulary is core's, so the API, the server and the client all agree
	// on the same five literals without three copies of the list. Absent or
	// blank still means an activity; a word that is not a type is refused, by
	// the same check the edit path uses, where it used to become an activity
	// without a word.
	const sentType = typeof b.type === 'string' ? b.type.trim() || undefined : (b.type ?? undefined);
	const badType = typeProblem(sentType);
	if (badType) return fail(c, 400, badType);
	const type: EventType = (sentType as EventType | undefined) ?? 'activity';

	// Refused rather than dropped, as on edit: a misspelt mode used to be stored
	// as no mode, which hands the journey to the router the caller was trying
	// to overrule.
	const badMode = travelModeProblem(b.travelMode);
	if (badMode) return fail(c, 400, badMode);

	// A city id is only a pointer into this trip. One from another trip (or from
	// nowhere) used to be stored as sent and pointed the event at a city the
	// board does not have.
	const sentCity = str(b.cityId);
	if (sentCity && !trip.cities.some((city) => city.id === sentCity)) {
		return fail(c, 400, 'Pick a city on this trip.');
	}

	// A stay is picked by its dates, not by a clock: it is checked into on one
	// day and out of on another, and it is drawn as a band across every day in
	// between. Everything else is asked for a start time.
	const stay = type === 'stay';
	const start = stay ? STAY_CHECK_IN : num(b.start);
	if (start === null) return fail(c, 400, 'Pick a start time.');
	if (start < 0 || start >= DAY_END_MIN) return fail(c, 400, 'Pick a start time within the day.');
	const endDay = stay ? isoDay(b.endDay) || shiftDay(day, 1) : null;
	if (endDay && endDay <= day) return fail(c, 400, 'Check-out must be after check-in.');
	// A stay on the trip's last night checks out the morning after it ends, so
	// the checkout is allowed one day past the range the check-in must sit in.
	if (endDay && checkoutOutsideTrip(trip, endDay)) {
		return fail(c, 400, outsideTripMessage(trip));
	}

	// Anything else may end on a later day, and a journey may land in another
	// city whose clock its end is read on. Absent or null is the old answer: it
	// ends on its own day, on its own clock. A non-journey's arrival city is
	// ignored rather than refused, because the dialog keeps the field's value
	// while the type is switched back and forth.
	const spanDay = stay ? undefined : sentEndDay(b.endDay);
	if (!stay && b.endDay !== undefined && spanDay === undefined) {
		return fail(c, 400, 'Pick an end date.');
	}
	const endCityId = type === 'travel' ? (sentEndCity(b.endCityId) ?? null) : null;
	// Neither client used to send a city, and the first city was stored, so on
	// a trip through Tokyo and Los Angeles a flight out of Tokyo had its start
	// read on whichever city was listed first. The day's city is the answer the
	// board gives for the day the block is on.
	const cityId = sentCity || cityOfDay(trip, day);

	// The name is optional on the wire: picking a place is how most things get
	// added, so one is derived rather than demanded. A name that was typed is
	// still checked, because that is a field the organiser can see and fix; a
	// derived one is shortened instead of refused.
	const sentTitle = str(b.title);
	if (sentTitle && !isNameLength(sentTitle)) return fail(c, 400, nameTooLong());

	const notes = str(b.notes);
	if (notes && !isNotesLength(notes)) return fail(c, 400, notesTooLong());

	// Free time is deliberately nowhere, so it is the one type with no link. A
	// journey's link is the far end of it: where it lands.
	const place = isLocatedType(type)
		? placeFor(trip.id, type, str(b.poiId), str(b.placeName))
		: null;
	const title = sentTitle || derivedTitle(type, placeName(place), notes);

	// Every event, a stay included, occupies real time, so the end is a length
	// from the start for a block on one day. A length is asked for rather than
	// an end time precisely so an end cannot land before its start, but the
	// number still arrives from the network and a negative or absurd one would
	// otherwise be quietly clamped into something the organiser never chose.
	//
	// A block that ends on a later day, or on another city's clock, has no
	// length on one clock to give, so its end is read as a clock reading on its
	// last day, in the arrival city's zone for a journey: `endMin` when sent,
	// else `start + duration`, the same sum a one-day block has always been
	// stored by (so a red-eye from 22:00 to 07:00 may send a duration of -900).
	// A one-day block may send `endMin` too, and is then held to the same floor.
	const duration = num(b.duration) ?? 60;
	const endMin = num(b.endMin);
	if (sent(b.endMin) && b.endMin !== null && endMin === null) {
		return fail(c, 400, 'Pick an end time.');
	}
	if (endMin !== null && (endMin < 0 || endMin > DAY_END_MIN)) {
		return fail(c, 400, 'Pick an end time within the day.');
	}
	const draft: SpanRow = {
		type,
		day,
		end_day: spanDay ?? null,
		start_min: start,
		end_min: endMin ?? start + duration,
		city_id: cityId,
		end_city_id: endCityId
	};
	let end: number;
	const onOneDay = stay || oneClock(trip, draft);
	if (!onOneDay && (draft.end_min < 0 || draft.end_min > DAY_END_MIN)) {
		return fail(c, 400, 'Pick an end time within the day.');
	}
	const refusal = spanRefusal(trip, draft);
	if (refusal) return fail(c, 400, refusal);
	if (onOneDay) {
		const length = stay ? duration : settled(trip, draft).end_min - start;
		if (length < MIN_EVENT_MINS) {
			return fail(c, 400, `An event needs to run at least ${MIN_EVENT_MINS} minutes.`);
		}
		if (!stay && start + length > DAY_END_MIN) {
			return fail(c, 400, 'That runs past the end of the day. Shorten it or start earlier.');
		}
		end = stay ? DAY_END_MIN : start + length;
	} else {
		end = draft.end_min;
	}

	const people = strList(b.people);
	if (allStrangers(trip, people)) return fail(c, 400, STRANGERS_MESSAGE);

	const id = createEvent(trip.id, c.get('user').id, {
		day,
		// A stay's checkout; else the end day, which a block settled onto one
		// day (one that runs to 00:00 tomorrow is one ending at 24:00) no longer has.
		endDay: stay ? endDay : onOneDay ? null : (spanDay ?? null),
		endCityId,
		title,
		type,
		startMin: start,
		endMin: end,
		poiId: place && 'poiId' in place ? place.poiId : null,
		lodgingId: place && 'lodgingId' in place ? place.lodgingId : null,
		placeText: place && 'text' in place ? place.text : null,
		cityId,
		lat: place?.lat ?? null,
		lng: place?.lng ?? null,
		notes: notes || null,
		travelMode: str(b.travelMode) || null,
		people,
		// A client that never sends this gets the old behaviour: a time nobody
		// chose is the exception, not the default.
		timeAuto: b.timeAuto === true
	});
	if (!id) return fail(c, 403, 'Could not add that event.');
	return c.json({ id }, 201);
});

/** Replace who is on an event. This is the whole of splitting and rejoining. */
schedule.put('/events/:eventId/people', async (c) => {
	const trip = c.get('trip');
	const eventId = c.req.param('eventId');
	if (foreignEvent(trip.id, eventId)) return fail(c, 404, goneMessage('event'));

	// Empty still means everyone here, as it does on create: this is the save the
	// people picker makes every time the whole group is on a block.
	const people = strList((await body(c)).people);
	if (allStrangers(trip, people)) return fail(c, 400, STRANGERS_MESSAGE);

	// The version the write left behind comes back with it. The dialog saves the
	// event first and the people second, each on its own request, so the number
	// the event save answered with is already stale by the time this lands; the
	// dialog keeps whatever this says so its next save is checked against the
	// row as it now is rather than refused against its own write.
	if (!setEventPeople(eventId, trip.id, c.get('user').id, people)) {
		return fail(c, 403, 'Not allowed');
	}
	return c.json({ ok: true, version: eventVersion(eventId) });
});

/**
 * Whether the body said anything at all about a field.
 *
 * Absent is a real answer on an edit: every field the dialog does not mention
 * is left exactly as it is, which is what keeps a save that only moved a block
 * from writing back a stale copy of everything else. `null` is not absent even
 * though it reads like it, and that distinction is the whole point of this
 * helper: `JSON.stringify` writes NaN and Infinity as null, so an emptied time
 * field arrives as an explicit null rather than as silence. Reading that as
 * "leave it alone" is how a time somebody typed went nowhere without a word.
 */
function sent(v: unknown): boolean {
	return v !== undefined;
}

/**
 * Whether a type the body named is one of core's five. Absent is not a problem:
 * create reads it as an activity and edit leaves the stored type alone. Shared
 * by both paths so a word one of them refuses cannot slip through the other.
 */
function typeProblem(v: unknown): string | null {
	if (!sent(v)) return null;
	return typeof v === 'string' && isEventType(v) ? null : 'Pick an event type.';
}

/**
 * Whether a travel mode the body named is a real one. Empty and null are the
 * reset (hand the journey back to the router), so only a word that is neither
 * is a mistake. Shared by create, edit and the leg editor.
 */
function travelModeProblem(v: unknown): string | null {
	if (!sent(v) || v === null || v === '') return null;
	return typeof v === 'string' && isTransportMode(v) ? null : 'Pick a travel mode.';
}

/**
 * What is wrong with an op payload, or null when nothing is.
 *
 * Each branch of the op switch reads a few fields off an untrusted body, and
 * only the dialog's two clock fields were ever checked. The rest were coerced,
 * and coercion turned two different mistakes into two different bad answers:
 *
 *  - A drag or a resize whose minute was unreadable became `NaN`, which is what
 *    `num(b.startMin) ?? NaN` was for. SQLite binds NaN as NULL, the minute
 *    columns are NOT NULL, and the refusal surfaced as a 500 "Something went
 *    wrong": a bad request reported as a broken server, with nothing a member
 *    could act on.
 *  - Everything else failed silently. An unreadable time, an unknown type, a
 *    misspelt travel mode and a malformed day were all dropped on the way to the
 *    store, so the save answered 200 and the board came back holding the old
 *    value with no explanation of why the new one did not stick.
 *
 * Both are requests the caller got wrong, so both are 400s with a sentence a
 * member can act on. This runs before the switch because the check is per
 * field, not per branch: the same day, the same minute and the same version
 * mean the same thing whichever op is carrying them.
 *
 * What is deliberately not refused: an unknown place id, which unlinks (see
 * `placeFor`), an empty travel mode, which hands the journey back to the
 * router, and an empty participant list, which means everyone. Those are
 * requests, not mistakes.
 *
 * `kind` is the type the block is ending up as, because `endDay` means two
 * things: a stay's checkout, which must come after its check-in, and any other
 * block's last day, which may be its own (null) and is judged with the rest of
 * its span by `spanRefusal`. `oneDay` says whether the edit leaves a block on
 * one clock on one day, the only shape the "end after start on the clock"
 * rule here is about, and `settledEnd` is its end once stored (a block sent as
 * ending at 00:00 tomorrow is stored as ending at 24:00 today).
 */
function opProblem(
	op: string,
	b: Record<string, unknown>,
	kind: EventType,
	oneDay: boolean,
	settledEnd?: number
): string | null {
	// Any op may name the day it is landing on. Absent leaves the block where it
	// is; unreadable would have moved it to a day that is not a day.
	if (sent(b.day) && !isoDay(b.day)) return 'Pick a day.';
	if (kind !== 'stay') {
		if (sent(b.endDay) && sentEndDay(b.endDay) === undefined) return 'Pick an end date.';
	} else {
		if (sent(b.endDay) && !isoDay(b.endDay)) return 'Pick a checkout date.';
		const from = isoDay(b.day);
		const to = isoDay(b.endDay);
		// Same rule create holds a stay to, and the same words the lodging form uses
		// for it. The store clamps an inverted range into the shortest real stay,
		// which is the right last resort and the wrong thing to tell somebody who
		// typed two dates and got a third.
		if (from && to && to <= from) return 'Check-out must be after check-in.';
	}

	// The version the editor had on screen. A version that is not a whole number
	// reads as "no version" and quietly turns the conflict check off, which is
	// the one field where being ignored costs somebody else's edit.
	if (sent(b.version) && b.version !== null && int(b.version) === null) {
		return 'Reload the page and try again.';
	}

	const start = num(b.startMin);
	const end = num(b.endMin);

	if (op === 'move') {
		// A drag carries exactly one minute and it is not optional: there is no
		// stored value to fall back on, because the drag is the new value.
		if (start === null) return 'Pick a start time.';
		if (start < 0 || start >= DAY_END_MIN) return 'Pick a start time within the day.';
		return null;
	}

	if (op === 'resize') {
		if (end === null) return 'Pick an end time.';
		if (end <= 0 || end > DAY_END_MIN) return 'Pick an end time within the day.';
		return null;
	}

	if (op !== 'edit') return null;

	// On an edit the two ends are optional, so only a field that was sent and
	// cannot be read is a mistake. A stay is edited by its dates and sends
	// neither.
	if (sent(b.startMin) && start === null) return 'Pick a start time.';
	if (sent(b.endMin) && end === null) return 'Pick an end time.';
	if (start !== null && (start < 0 || start >= DAY_END_MIN)) {
		return 'Pick a start time within the day.';
	}
	if (end !== null && end > DAY_END_MIN) return 'That runs past the end of the day.';
	// A dialog save carries both ends of the clock at once, so it is the one op
	// that can describe an event that ends before it begins. On one clock on
	// one day that is these two minutes; anything else is judged as a span.
	if (oneDay && start !== null && end !== null && (settledEnd ?? end) - start < MIN_EVENT_MINS) {
		return `An event needs to run at least ${MIN_EVENT_MINS} minutes.`;
	}

	// A type outside the five was dropped by the store, which left the block as
	// whatever it already was and reported success.
	const badType = typeProblem(b.type);
	if (badType) return badType;

	// Empty is the reset, and null is how a client writes the same thing. A word
	// that is neither was silently treated as the reset, so a misspelt mode
	// unpinned the journey instead of pinning it.
	const badMode = travelModeProblem(b.travelMode);
	if (badMode) return badMode;

	// A place is picked from a list, so anything that is not a string is not a
	// pick. An id that is a string and unknown still unlinks, deliberately.
	if (sent(b.poiId) && b.poiId !== null && typeof b.poiId !== 'string') {
		return 'Pick a place from the list.';
	}

	// Null reads as absent here, as it always has: it is how a client says it has
	// nothing to say about the name. An empty one is not that, but it is not a
	// refusal either: a cleared field is a request to derive a name again, by
	// exactly the order create uses, and the handler below does that. Only the
	// length is the validator's business, because an over-long typed name is the
	// one thing the organiser can see and fix.
	if (sent(b.title) && b.title !== null) {
		const title = str(b.title);
		if (title && !isNameLength(title)) return nameTooLong();
	}

	return null;
}

/**
 * Drag, resize, retitle, delete.
 *
 * These stay behind one `op` field rather than becoming four REST endpoints
 * because the schedule UI fires them from one drag handler, and the ownership
 * check is the same for all of them. Splitting them would spread that check
 * across four places for no gain.
 */
schedule.post('/events/:eventId/op', async (c) => {
	const trip = c.get('trip');
	const eventId = c.req.param('eventId');
	const userId = c.get('user').id;
	const b = await body(c);

	// Every mutation below is passed the trip and refuses an event belonging to
	// another one, so this is about the status, not the check: a cross-trip id is
	// a 404, not the 403 that a real permission failure inside this trip earns.
	if (foreignEvent(trip.id, eventId)) return fail(c, 404, goneMessage('event'));

	// Any op that names a day has to land inside the trip, for the same reason
	// creating one does: the board only offers days the trip has, so a block
	// pushed outside is a block nobody can get back to.
	const targetDay = isoDay(b.day);
	if (targetDay && outsideTrip(trip, targetDay)) {
		return fail(c, 400, outsideTripMessage(trip));
	}
	const op = str(b.op);
	// The type the block is ending up as, which decides what `endDay` means: a
	// stay's checkout, or any other block's last day.
	const kind = editedType(eventId, b.type);
	const targetEnd = isoDay(b.endDay);
	if (kind === 'stay' && targetEnd && checkoutOutsideTrip(trip, targetEnd)) {
		return fail(c, 400, outsideTripMessage(trip));
	}
	// A drag carries only the day it lands on, and a stay keeps its length in
	// nights, so the checkout it would end up with is not in the body at all.
	// Checking only a sent `endDay` let a four-night stay dragged onto the last
	// day check out three days after the trip, on days the board does not have.
	if (op === 'move' && targetDay) {
		const checkout = movedStayCheckout(eventId, targetDay);
		if (checkout && checkoutOutsideTrip(trip, checkout)) {
			return fail(c, 400, outsideTripMessage(trip));
		}
	}

	// The departure city of a block being edited: one of the trip's, like the
	// arrival and like `cityId` on create. Refused rather than dropped, because
	// a dropped one leaves the start read on the wrong clock with nothing said.
	if (op === 'edit' && sent(b.cityId) && !trip.cities.some((city) => city.id === str(b.cityId))) {
		return fail(c, 400, PICK_TRIP_CITY);
	}
	const sentCityId = op === 'edit' && sent(b.cityId) ? str(b.cityId) : undefined;

	// The span this op would leave a timed block with, merged with the stored
	// row by the same functions the store writes through, so what is judged
	// here is what would be written. Null for a stay, and for an op that does
	// not move either end.
	const startAt = num(b.startMin);
	const span =
		kind === 'stay'
			? null
			: op === 'edit'
				? editedSpan(eventId, {
						type: b.type != null ? String(b.type) : undefined,
						day: targetDay ?? undefined,
						endDay: sentEndDay(b.endDay),
						startMin: startAt ?? undefined,
						endMin: num(b.endMin) ?? undefined,
						cityId: sentCityId,
						endCityId: sentEndCity(b.endCityId)
					})
				: op === 'move' && startAt !== null
					? movedSpan(eventId, startAt, targetDay ?? undefined)
					: null;
	const spanOnOneDay = span === null || oneClock(trip, span);

	// A dialog save carries both ends of the clock at once, a drag carries one
	// minute, and either can arrive unreadable. Everything the switch below is
	// about to read is checked here, in one place, while there is still
	// somewhere to put the reason.
	const problem = opProblem(
		op,
		b,
		kind,
		spanOnOneDay,
		span && spanOnOneDay ? settled(trip, span).end_min : undefined
	);
	if (problem) return fail(c, 400, problem);
	// The bottom edge of a block is a minute on the day being looked at, which
	// for a block that ends on another day or another clock is not its end.
	// The board does not offer the handle on one; its dialog is where the end
	// of such a block is changed.
	if (op === 'resize' && resizable(eventId) === false) {
		return fail(c, 400, 'Open the event to change when it ends.');
	}
	// A journey between two clocks is not dragged either: the board draws it on
	// the arrival clock and stores its start on the departure one, so the
	// minute under the pointer is neither end. It is retimed in its dialog.
	if (op === 'move' && movable(eventId) === false) {
		return fail(c, 400, 'Open the event to change when it ends.');
	}
	if (span) {
		const refusal = spanRefusal(trip, span);
		if (refusal) return fail(c, 400, refusal);
	}

	// A drag and a resize are deliberately left unchecked. They carry exactly one
	// field each, so there is nothing stale riding along to overwrite, and
	// holding a gesture to a version the board refetches constantly would refuse
	// perfectly good drags whenever somebody else touched another event. The
	// dialog save is the one that writes a whole record back, and that is the one
	// that is checked. Both still bump the version, and answer with the new one,
	// so a dialog opened before the drag is refused rather than dragging the
	// block back when it saves.
	let okay = false;
	switch (str(b.op)) {
		case 'move':
			// A drag can cross days, so the target day rides along with the start.
			// Both were checked above, so the minute is a number and the day, if it
			// came at all, is a real one.
			okay = moveEvent(eventId, userId, num(b.startMin)!, trip.id, isoDay(b.day) ?? undefined);
			break;
		case 'resize':
			okay = resizeEvent(eventId, userId, num(b.endMin)!, trip.id);
			break;
		case 'edit': {
			// The type and the place this block is ending up as, read once: the
			// derived name needs both, and the edit itself needs them anyway. Which
			// list the id is looked up in follows the type it is ending up as, not
			// the one it had. Absent leaves the link alone, empty unlinks.
			const type = editedType(eventId, b.type);
			/* The place field moves in two ways now: a different saved place, or a
			   different typed name. Either one present means the body is speaking
			   about the place, and both are resolved together so picking a place
			   drops a name that was typed and vice versa. */
			const placeSent = b.poiId !== undefined || b.placeName !== undefined;
			const place = placeSent ? placeFor(trip.id, type, str(b.poiId), str(b.placeName)) : undefined;

			/* Three cases for the name, and the last two are not the same thing:
			   absent (or null) means the body is silent about it, so the stored name
			   stands and an edit that never mentions the name cannot rename an event
			   somebody deliberately named; explicitly blank means the organiser
			   cleared the field, which is a request to derive one again by exactly
			   the order create uses; anything else is used as typed.

			   A blank one derives from what this body carries, because the dialog
			   save writes the whole record back: the place it is ending up at and
			   the notes it is ending up with are both in front of us. The place is
			   only sent when the picker moved, so when it is absent the place the
			   event already sits at is read instead: otherwise clearing the label
			   on an untouched place would derive off the notes and rename the block
			   away from the very place it is at. If there is no place either way,
			   the type's own noun is still a real name, so clearing the field can
			   never leave the block nameless. */
			const sentTitle = b.title === undefined || b.title === null ? null : str(b.title);
			if (sentTitle && !isNameLength(sentTitle)) return fail(c, 400, nameTooLong());
			if (b.notes != null && !isNotesLength(String(b.notes))) {
				return fail(c, 400, notesTooLong());
			}
			const derivedFrom = place === undefined ? currentPlaceName(eventId) : placeName(place);
			const title =
				sentTitle === null ? undefined : sentTitle || derivedTitle(type, derivedFrom, str(b.notes));

			const result = editEvent(
				eventId,
				userId,
				{
					title,
					type: b.type != null ? String(b.type) : undefined,
					notes: b.notes === undefined ? undefined : b.notes === null ? null : String(b.notes),
					// Three cases, not two: absent means leave it alone, null or empty
					// means hand it back to the router, a mode means pin it.
					travelMode:
						b.travelMode === undefined
							? undefined
							: b.travelMode === null || b.travelMode === ''
								? null
								: String(b.travelMode),
					startMin: sent(b.startMin) ? num(b.startMin)! : undefined,
					endMin: sent(b.endMin) ? num(b.endMin)! : undefined,
					// A stay moves and stretches by its dates instead. Anything else
					// moves by `day` and ends on `endDay`: null is its own day, and
					// absent keeps the end day it had, carried with a new `day`.
					day: isoDay(b.day) ?? undefined,
					endDay: type === 'stay' ? (isoDay(b.endDay) ?? undefined) : sentEndDay(b.endDay),
					// A journey's arrival city: absent leaves it, null clears it.
					endCityId: sentEndCity(b.endCityId),
					// The city it starts in (a journey's departure): absent leaves it.
					cityId: sentCityId,
					place
				},
				trip.id,
				int(b.version)
			);
			if (!result.ok) {
				return result.reason === 'conflict'
					? fail(c, 409, 'Someone else changed this event. Reload to see their version.')
					: fail(c, 403, 'Not allowed');
			}
			return c.json({ ok: true, version: result.version });
		}
		case 'delete':
			okay = deleteEvent(eventId, userId, trip.id);
			return okOr(c, okay, 403, 'Not allowed');
		default:
			return fail(c, 400, 'Unknown op.');
	}

	if (!okay) return fail(c, 403, 'Not allowed');
	// A drag or a resize: the version it left behind, as the edit save answers.
	return c.json({ ok: true, version: eventVersion(eventId) });
});

// --- Travel -----------------------------------------------------------------

/**
 * Name a leg, pin its mode and minutes, or hand it back to the router.
 *
 * A leg has no id of its own until it has been planned once, so this only ever
 * addresses a row the last board load created. Sending the mode and the minutes
 * empty is the reset, which is why there is no separate delete. The title is
 * absent-means-leave-alone, so a reset does not also wipe the name.
 */
schedule.patch('/legs/:legId', async (c) => {
	const b = await body(c);
	const mode = str(b.mode);
	const mins = num(b.mins);
	// Same rule as an event's mode: empty is the reset, a word that is not a mode
	// is a mistake, and dropping it silently would reset a pinned journey.
	const badMode = travelModeProblem(b.mode);
	if (badMode) return fail(c, 400, badMode);
	// A journey's name is drawn on the board like an event's title, so it is held
	// to the same ceiling. Blank still clears it.
	const title = b.title === undefined ? undefined : str(b.title) || null;
	if (title && !isNameLength(title)) return fail(c, 400, nameTooLong());
	return okOr(
		c,
		editLeg(c.req.param('legId'), c.get('trip').id, c.get('user').id, mode || null, mins, title),
		404,
		goneMessage('journey')
	);
});

// Crews are written through `/trips/:id/people/crews`: a crew is a saved group
// of people, and the page that manages them is People. The board still reads
// them, so they stay in this payload.
