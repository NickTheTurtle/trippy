import { Hono } from 'hono';
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
	setEventPeople,
	shiftDay,
	staysOnBoard,
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
 * The days the trip offers, which is its date range plus anything scheduled
 * outside it.
 *
 * The range alone is not enough: a trip's dates can be edited after the fact,
 * and an event stranded outside the new range would become unreachable rather
 * than visibly wrong. `scheduleDays` alone is not enough either, since a trip
 * with nothing on it yet would offer no days to put the first event on.
 */
function tripDays(tripId: string, start: string | null, end: string | null): string[] {
	const days = new Set(scheduleDays(tripId));
	const from = isoDay(start);
	const to = isoDay(end);
	if (from && to) {
		// Guard against a reversed or absurd range walking forever.
		for (let d = from, i = 0; d <= to && i < 400; d = shiftDay(d, 1), i++) days.add(d);
	}
	return [...days].sort();
}

schedule.get('/', async (c) => {
	const trip = c.get('trip');

	const days = tripDays(trip.id, trip.start_date, trip.end_date);
	// `day` is fed to shiftDay(), so a malformed one would build an Invalid Date
	// and throw inside toISOString(), turning a mistyped url into a 500. Anything
	// that is not a real calendar day falls back to a day the trip really has.
	//
	// The trip's own start comes first, ahead of the earliest scheduled day. It
	// used to be the other way around, and a single event saved on a mistyped
	// date was then enough to make a bare /schedule open on the year 1900 for
	// every member of the trip, with no previous arrow and nothing but empty
	// board ahead. The stray day is still reachable, because `tripDays` still
	// lists it; it just no longer decides where everybody starts.
	const fallback =
		isoDay(trip.start_date) ?? isoDay(days[0]) ?? new Date().toISOString().slice(0, 10);
	const viewRaw = c.req.query('view') ?? 'day';
	const view: ViewMode = VIEWS.includes(viewRaw as ViewMode) ? (viewRaw as ViewMode) : 'day';

	/* Outside the trip is not a place you can be.
	 *
	 * Clamped here rather than only in the toolbar because the day is a url, and
	 * a url can be typed, bookmarked or left behind by a trip whose dates were
	 * shortened afterwards. Answering those with an empty board would show a day
	 * the trip does not have and offer no clue which way is back.
	 *
	 * `tripDays` already includes anything scheduled outside the range, so a
	 * stranded event stays reachable: the bound is what the trip offers, not its
	 * dates. */
	const requested = isoDay(c.req.query('day')) ?? fallback;
	const last = days[days.length - 1];
	const day = !days.length
		? requested
		: requested < days[0]
			? days[0]
			: last && requested > last
				? last
				: requested;

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
 * Reads are deliberately more forgiving than writes: `tripDays` still lists
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

	// The type's own noun for the two types that are their own description. The
	// words come from core so the picker, the board and this fallback cannot
	// drift apart.
	if (!title) title = type === 'travel' || type === 'freetime' ? EVENT_TYPE_LABELS[type] : '';
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

	const people = strList(b.people);
	if (allStrangers(trip, people)) return fail(c, 400, STRANGERS_MESSAGE);

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
		people
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

	return okOr(c, setEventPeople(eventId, trip.id, c.get('user').id, people), 403, 'Not allowed');
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
 */
function opProblem(op: string, b: Record<string, unknown>): string | null {
	// Any op may name the day it is landing on. Absent leaves the block where it
	// is; unreadable would have moved it to a day that is not a day.
	if (sent(b.day) && !isoDay(b.day)) return 'Pick a day.';
	if (sent(b.endDay) && !isoDay(b.endDay)) return 'Pick a checkout date.';
	const from = isoDay(b.day);
	const to = isoDay(b.endDay);
	// Same rule create holds a stay to. The store clamps an inverted range into
	// the shortest real stay, which is the right last resort and the wrong thing
	// to tell somebody who typed two dates and got a third.
	if (from && to && to <= from) return 'Check out after you check in.';

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
	// that can describe an event that ends before it begins.
	if (start !== null && end !== null && end - start < MIN_EVENT_MINS) {
		return `An event needs to run at least ${MIN_EVENT_MINS} minutes.`;
	}

	// A type outside the five was dropped by the store, which left the block as
	// whatever it already was and reported success.
	if (sent(b.type) && !(typeof b.type === 'string' && isEventType(b.type))) {
		return 'Pick an event type.';
	}

	// Empty is the reset, and null is how a client writes the same thing. A word
	// that is neither was silently treated as the reset, so a misspelt mode
	// unpinned the journey instead of pinning it.
	if (sent(b.travelMode) && b.travelMode !== null && b.travelMode !== '') {
		if (typeof b.travelMode !== 'string' || !isTransportMode(b.travelMode)) {
			return 'Pick a travel mode.';
		}
	}

	// A place is picked from a list, so anything that is not a string is not a
	// pick. An id that is a string and unknown still unlinks, deliberately.
	if (sent(b.poiId) && b.poiId !== null && typeof b.poiId !== 'string') {
		return 'Pick a place from the list.';
	}

	// Null reads as absent here, as it always has: it is how a client says it has
	// nothing to say about the name. An empty one is not that. Every event has a
	// name, create refuses a blank one, and an edit that blanks it was ignored
	// rather than refused, so the old name came back on the next load looking
	// like the save had not happened.
	if (sent(b.title) && b.title !== null) {
		const title = str(b.title);
		if (!title) return 'Enter a title.';
		if (!isNameLength(title)) return nameTooLong();
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
	const targetEnd = isoDay(b.endDay);
	if (targetEnd && outsideTrip(trip, shiftDay(targetEnd, -1))) {
		return fail(c, 400, outsideTripMessage(trip));
	}

	// A dialog save carries both ends of the clock at once, a drag carries one
	// minute, and either can arrive unreadable. Everything the switch below is
	// about to read is checked here, in one place, while there is still
	// somewhere to put the reason.
	const problem = opProblem(str(b.op), b);
	if (problem) return fail(c, 400, problem);

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
			// Both were checked above, so the minute is a number and the day, if it
			// came at all, is a real one.
			okay = moveEvent(eventId, userId, num(b.startMin)!, trip.id, isoDay(b.day) ?? undefined);
			break;
		case 'resize':
			okay = resizeEvent(eventId, userId, num(b.endMin)!, trip.id);
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
					startMin: sent(b.startMin) ? num(b.startMin)! : undefined,
					endMin: sent(b.endMin) ? num(b.endMin)! : undefined,
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
