import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireMember } from '../middleware';
import { routingGate } from '../provider-quota';
import { body, int, isoDay, num, str, strList } from '../parse';
import { fail, goneMessage, okOr } from '../respond';
import type { Env, Trip } from '../types';
import { env } from '@trippy/server/env';
import { isEventType, isLocatedType, MIN_EVENT_MINS, type EventType } from '@trippy/core/types';
import { formatDayRange } from '@trippy/core/tz';
import { isNameLength, nameTooLong } from '@trippy/core/validate';
import {
	createEvent,
	crewsForTrip,
	currentType,
	deleteEvent,
	editEvent,
	editLeg,
	eventTrip,
	eventsForDay,
	incomingStays,
	legsForDay,
	moveEvent,
	plannedLegsForDay,
	resizeEvent,
	saveAutoLeg,
	scheduleDays,
	scheduledDayAfter,
	scheduledDayBefore,
	scheduledDayEdges,
	setEventPeople,
	shiftDay,
	staysOnBoard,
	strandedDayCount,
	dayHasEvents,
	STAY_CHECK_IN
} from '@trippy/server/schedule';
import { routeLegs } from '@trippy/server/routing';
import { savedPoisForTrip } from '@trippy/server/pois';
import { stayOptionsForTrip } from '@trippy/server/lodging';

export const schedule = new Hono<Env>();

schedule.use('*', requireMember);

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
 */
async function dayLegs(tripId: string, day: string, canBill?: () => boolean) {
	const planned = plannedLegsForDay(tripId, day);
	if (planned.length) {
		const stored = new Map(legsForDay(tripId, day).map((l) => [l.key, l]));
		const routed = await routeLegs(
			planned,
			(leg) => stored.get(leg.key)?.mode ?? undefined,
			canBill
		);
		for (const [key, r] of routed) saveAutoLeg(tripId, day, key, r.mode, r.mins);
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
function tripRange(start: string | null, end: string | null): { start: string; end: string } | null {
	const from = isoDay(start);
	const to = isoDay(end);
	return from && to && from <= to ? { start: from, end: to } : null;
}

/** Whole days from `start` to `end` inclusive. Arithmetic, so no walk. */
function spanDays(start: string, end: string): number {
	const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
	return Math.round(ms / 86400000) + 1;
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
 * Centred on `day` rather than started at `first` so that a trip long enough to
 * exceed the window still lists the days either side of where the reader is.
 */
function tripDays(
	tripId: string,
	range: { start: string; end: string } | null,
	reach: { first: string; last: string },
	day: string
): string[] {
	const half = Math.floor(MAX_DAY_LIST / 2);
	const back = shiftDay(day, -half);
	const from = back > reach.first ? back : reach.first;
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

	// Cities are dateless itinerary places, so the first city is the trip-wide
	// default rather than a schedule. It frames the day view's map; the pins
	// themselves come from the events, which do know where they are.
	const cell = (city: Trip['cities'][number] | null | undefined) =>
		city ? { id: city.id, name: city.name, tz: city.tz, lat: city.lat, lng: city.lng } : null;
	const defaultCity = trip.cities[0] ?? null;

	/* One day, held in an array. Every view reads a single day: the people view
	   is that day laid out sideways. The array is what the client iterates, and
	   keeping it is what lets a view that spans days be added back without
	   reshaping the payload. */
	const board = [
		{
			day,
			city: cell(defaultCity),
			events: eventsForDay(trip.id, day),
			// The day's lodgings, drawn as a band rather than a block: a stay is a
			// range of days, so it is on every day it covers, the morning of
			// checkout included, and there may be more than one when the group
			// sleeps in more than one place.
			stays: staysOnBoard(trip.id, day),
			// Where the morning starts. The client needs it to plan the day's travel
			// the same way the server does, which is what lets an unsaved change to
			// who is going redraw the journeys as it is typed. It overlaps `stays`
			// on every day but the first: the same row answers both questions.
			incoming: incomingStays(trip.id, day),
			legs: await dayLegs(trip.id, day, routingGate(c.get('user').id))
		}
	];

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
		prevDay: reach ? stepDay(trip.id, range, day, -1) : null,
		nextDay: reach ? stepDay(trip.id, range, day, 1) : null,
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
		mapsKey: env.GOOGLE_MAPS_KEY ?? ''
	});
});

// --- Events -----------------------------------------------------------------

/**
 * Turn a picked id into the place an event sits at.
 *
 * A stay is booked into a proposed stay and everything else is scheduled at a
 * saved place, so the type decides which list the id is looked up in and which
 * column the link is written to. Mixing the two would let a stay claim a museum
 * and a lunch claim a hotel room, and the Discover card that counts what is on
 * the calendar would count neither.
 *
 * An unknown id unlinks rather than fails: the alternative is an event that
 * claims a place the trip no longer saves.
 */
function placeFor(tripId: string, type: EventType, pickedId: string) {
	if (!pickedId) return null;
	if (type === 'stay') {
		const stay = stayOptionsForTrip(tripId).find((s) => s.id === pickedId);
		return stay && { lodgingId: stay.id, name: stay.name, lat: stay.lat, lng: stay.lng };
	}
	const poi = savedPoisForTrip(tripId).find((p) => p.id === pickedId);
	return poi && { poiId: poi.id, name: poi.name, lat: poi.lat, lng: poi.lng };
}

/** The type an edited block is ending up as: the one it was sent, or the stored one. */
function editedType(eventId: string, sent: unknown): EventType {
	const raw = sent == null ? currentType(eventId) : String(sent);
	return isEventType(raw) ? raw : 'activity';
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
	const from = isoDay(trip.start_date);
	const to = isoDay(trip.end_date);
	if (!from || !to || from > to) return false;
	return day < from || day > to;
}

/** What a day outside the trip is told, with the range quoted back. */
function outsideTripMessage(trip: Trip): string {
	return `That date is outside the trip, which runs ${trip.start_date} to ${trip.end_date}.`;
}

schedule.post('/events', async (c) => {
	const trip = c.get('trip');
	const b = await body(c);

	const day = isoDay(b.day);
	if (!day) return fail(c, 400, 'Pick a day.');
	if (outsideTrip(trip, day)) return fail(c, 400, outsideTripMessage(trip));

	const typeRaw = str(b.type) || 'activity';
	// The vocabulary is core's, so the API, the server and the client all agree
	// on the same five literals without three copies of the list.
	const type = isEventType(typeRaw) ? typeRaw : 'activity';

	// A stay is picked by its dates, not by a clock: it is checked into on one
	// day and out of on another, and it is drawn as a band across every day in
	// between. Everything else is asked for a start time.
	const stay = type === 'stay';
	const start = stay ? STAY_CHECK_IN : num(b.start);
	if (start === null) return fail(c, 400, 'Pick a start time.');
	if (start < 0 || start >= 24 * 60) return fail(c, 400, 'Pick a start time within the day.');
	const endDay = stay ? isoDay(b.endDay) || shiftDay(day, 1) : null;
	if (endDay && endDay <= day) return fail(c, 400, 'Check out after you check in.');
	// A stay on the trip's last night checks out the morning after it ends, so
	// the checkout is allowed one day past the range the check-in must sit in.
	if (endDay && outsideTrip(trip, shiftDay(endDay, -1))) {
		return fail(c, 400, outsideTripMessage(trip));
	}

	let title = str(b.title);
	// Free time is deliberately nowhere, so it is the one type with no link. A
	// journey's link is the far end of it: where it lands.
	const place = isLocatedType(type) ? placeFor(trip.id, type, str(b.poiId)) : null;
	if (place && !title) title = place.name;

	if (!title) title = type === 'travel' ? 'Travel' : type === 'freetime' ? 'Free time' : '';
	if (!title) return fail(c, 400, 'Enter a title.');
	if (!isNameLength(title)) return fail(c, 400, nameTooLong());

	// Every event, a stay included, occupies real time on its own day, so the
	// end is always a length from the start. A length is asked for rather than
	// an end time precisely so an end cannot land before its start, but the
	// number still arrives from the network and a negative or absurd one would
	// otherwise be quietly clamped into something the organiser never chose.
	const duration = num(b.duration) ?? 60;
	if (duration < MIN_EVENT_MINS) {
		return fail(c, 400, `An event needs to run at least ${MIN_EVENT_MINS} minutes.`);
	}
	if (!stay && start + duration > 24 * 60) {
		return fail(c, 400, 'That runs past the end of the day. Shorten it or start earlier.');
	}
	const end = stay ? 24 * 60 : start + duration;

	const id = createEvent(trip.id, c.get('user').id, {
		day,
		endDay,
		title,
		type,
		startMin: start,
		endMin: end,
		poiId: place && 'poiId' in place ? place.poiId : null,
		lodgingId: place && 'lodgingId' in place ? place.lodgingId : null,
		cityId: str(b.cityId) || trip.cities[0]?.id || null,
		lat: place?.lat ?? null,
		lng: place?.lng ?? null,
		notes: str(b.notes) || null,
		travelMode: str(b.travelMode) || null,
		people: strList(b.people)
	});
	if (!id) return fail(c, 403, 'Could not add that event.');
	return c.json({ id }, 201);
});

/** Replace who is on an event. This is the whole of splitting and rejoining. */
schedule.put('/events/:eventId/people', async (c) => {
	const trip = c.get('trip');
	const eventId = c.req.param('eventId');
	if (foreignEvent(trip.id, eventId)) return fail(c, 404, goneMessage('event'));

	return okOr(
		c,
		setEventPeople(eventId, trip.id, c.get('user').id, strList((await body(c)).people)),
		403,
		'Not allowed'
	);
});

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
	const targetEnd = isoDay(b.endDay);
	if (targetEnd && outsideTrip(trip, shiftDay(targetEnd, -1))) {
		return fail(c, 400, outsideTripMessage(trip));
	}

	// A dialog save carries both ends of the clock at once, so it is the one op
	// that can describe an event that ends before it begins. The store clamps
	// such a pair into something legal, which is the right last resort but the
	// wrong answer to give an organiser: they typed a time and would be shown a
	// different one with no explanation. Refuse it here, where there is still
	// somewhere to put the reason.
	if (str(b.op) === 'edit') {
		const from = num(b.startMin);
		const to = num(b.endMin);
		if (from !== null && (from < 0 || from >= 24 * 60)) {
			return fail(c, 400, 'Pick a start time within the day.');
		}
		if (to !== null && to > 24 * 60) {
			return fail(c, 400, 'That runs past the end of the day.');
		}
		if (from !== null && to !== null && to - from < MIN_EVENT_MINS) {
			return fail(c, 400, `An event needs to run at least ${MIN_EVENT_MINS} minutes.`);
		}
	}

	// A drag and a resize are deliberately left unversioned. They carry exactly
	// one field each, so there is nothing stale riding along to overwrite, and
	// holding a gesture to a version the board refetches constantly would refuse
	// perfectly good drags whenever somebody else touched another event. The
	// dialog save is the one that writes a whole record back, and that is the one
	// that is checked.
	let okay = false;
	switch (str(b.op)) {
		case 'move':
			// A drag can cross days, so the target day rides along with the start.
			okay = moveEvent(
				eventId,
				userId,
				num(b.startMin) ?? NaN,
				trip.id,
				isoDay(b.day) ?? undefined
			);
			break;
		case 'resize':
			okay = resizeEvent(eventId, userId, num(b.endMin) ?? NaN, trip.id);
			break;
		case 'edit': {
			const result = editEvent(
				eventId,
				userId,
				{
					title: b.title != null ? String(b.title) : undefined,
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
					startMin: b.startMin === undefined ? undefined : (num(b.startMin) ?? undefined),
					endMin: b.endMin === undefined ? undefined : (num(b.endMin) ?? undefined),
					// A stay moves and stretches by its dates instead.
					day: isoDay(b.day) ?? undefined,
					endDay: isoDay(b.endDay) ?? undefined,
					// Same three cases again: absent leaves the link, empty unlinks.
					// Which list the id is looked up in follows the type the block is
					// ending up as, not the one it had.
					place:
						b.poiId === undefined
							? undefined
							: placeFor(trip.id, editedType(eventId, b.type), str(b.poiId))
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
			break;
		default:
			return fail(c, 400, 'Unknown op.');
	}

	return okOr(c, okay, 403, 'Not allowed');
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
	return okOr(
		c,
		editLeg(
			c.req.param('legId'),
			c.get('trip').id,
			c.get('user').id,
			mode || null,
			mins,
			b.title === undefined ? undefined : str(b.title) || null
		),
		404,
		goneMessage('journey')
	);
});

// Crews are written through `/trips/:id/people/crews`: a crew is a saved group
// of people, and the page that manages them is People. The board still reads
// them, so they stay in this payload.
