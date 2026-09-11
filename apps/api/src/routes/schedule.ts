import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, isoDay, num, str, strList } from '../parse';
import { fail, okOr } from '../respond';
import type { Env, Trip } from '../types';
import { env } from '@trippy/server/env';
import { isEventType } from '@trippy/core/types';
import {
	createEvent,
	createCrew,
	crewsForTrip,
	deleteCrew,
	deleteEvent,
	editCrew,
	editEvent,
	editLeg,
	eventTrip,
	eventsForDay,
	incomingStay,
	legsForDay,
	moveEvent,
	plannedLegsForDay,
	resizeEvent,
	saveAutoLeg,
	scheduleDays,
	setEventPeople,
	shiftDay,
	STAY_CHECK_IN,
	STAY_CHECK_OUT
} from '@trippy/server/schedule';
import { routeLegs } from '@trippy/server/routing';
import { savedPoisForTrip } from '@trippy/server/pois';
import { lodgingForDay } from '@trippy/server/lodging';

export const schedule = new Hono<Env>();

schedule.use('*', requireMember);

const VIEWS = ['day', '3day', 'people'] as const;
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

/** The days visible for a given view, anchored on `day`. */
function visibleDays(view: ViewMode, day: string): string[] {
	// The people view is one day laid out sideways, so it loads the same day the
	// day view would. Only the 3-day view needs neighbours.
	return view === '3day' ? [0, 1, 2].map((i) => shiftDay(day, i)) : [day];
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
async function dayLegs(tripId: string, day: string) {
	const planned = plannedLegsForDay(tripId, day);
	if (planned.length) {
		const stored = new Map(legsForDay(tripId, day).map((l) => [l.key, l]));
		const routed = await routeLegs(planned, (leg) => stored.get(leg.key)?.mode ?? undefined);
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
	// that is not a real calendar day falls back to the first scheduled day, then
	// the trip start, which is what a bare /schedule shows.
	const fallback =
		isoDay(days[0]) ?? isoDay(trip.start_date) ?? new Date().toISOString().slice(0, 10);
	const day = isoDay(c.req.query('day')) ?? fallback;
	const viewRaw = c.req.query('view') ?? 'day';
	const view: ViewMode = VIEWS.includes(viewRaw as ViewMode) ? (viewRaw as ViewMode) : 'day';

	// Cities are dateless itinerary places, so the first city is the trip-wide
	// default rather than a schedule. It frames the day view's map; the pins
	// themselves come from the events, which do know where they are.
	const cell = (city: Trip['cities'][number] | null | undefined) =>
		city ? { id: city.id, name: city.name, tz: city.tz, lat: city.lat, lng: city.lng } : null;
	const defaultCity = trip.cities[0] ?? null;

	const board = [];
	for (const d of visibleDays(view, day)) {
		board.push({
			day: d,
			city: cell(defaultCity),
			lodging: defaultCity ? lodgingForDay(trip.id, defaultCity.id, d) : null,
			events: eventsForDay(trip.id, d),
			// Last night's stay is sent alongside rather than among the events: it
			// belongs to the previous day and only its tail lands on this one.
			incoming: incomingStay(trip.id, d),
			legs: await dayLegs(trip.id, d)
		});
	}

	return c.json({
		days,
		day,
		view,
		board,
		members: trip.memberList,
		crews: crewsForTrip(trip.id),
		saved: savedPoisForTrip(trip.id),
		cities: trip.cities.map((x) => cell(x)),
		defaults: { checkIn: STAY_CHECK_IN, checkOut: STAY_CHECK_OUT },
		mapsKey: env.GOOGLE_MAPS_KEY ?? ''
	});
});

// --- Events -----------------------------------------------------------------

schedule.post('/events', async (c) => {
	const trip = c.get('trip');
	const b = await body(c);

	const day = isoDay(b.day);
	const start = num(b.start);
	if (!day || start === null) return fail(c, 400, 'Pick a day and a start time.');

	const typeRaw = str(b.type) || 'activity';
	// The vocabulary is core's, so the API, the server and the client all agree
	// on the same five literals without three copies of the list.
	const type = isEventType(typeRaw) ? typeRaw : 'activity';

	let title = str(b.title);
	let lat: number | null = null;
	let lng: number | null = null;
	let linkedPoi: string | null = null;

	const poiId = str(b.poiId);
	if (poiId && type !== 'freetime') {
		const poi = savedPoisForTrip(trip.id).find((p) => p.id === poiId);
		if (poi) {
			title = title || poi.name;
			lat = poi.lat;
			lng = poi.lng;
			linkedPoi = poi.id;
		}
	}

	if (!title) title = type === 'travel' ? 'Travel' : type === 'freetime' ? 'Free time' : '';
	if (!title) return fail(c, 400, 'Enter a title.');

	// A stay runs to the next morning, so its end is a checkout time rather than
	// a length. Everything else is a duration on its own day.
	const end = type === 'stay' ? (num(b.end) ?? STAY_CHECK_OUT) : start + (num(b.duration) || 60);

	const id = createEvent(trip.id, c.get('user').id, {
		day,
		title,
		type,
		startMin: start,
		endMin: end,
		poiId: linkedPoi,
		cityId: str(b.cityId) || trip.cities[0]?.id || null,
		lat,
		lng,
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
	if (foreignEvent(trip.id, eventId)) return fail(c, 404, 'Could not find that event.');

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
	if (foreignEvent(trip.id, eventId)) return fail(c, 404, 'Could not find that event.');

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
		case 'edit':
			okay = editEvent(
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
					endMin: b.endMin === undefined ? undefined : (num(b.endMin) ?? undefined)
				},
				trip.id
			);
			break;
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
 * Pin a leg's mode and minutes, or hand it back to the router.
 *
 * A leg has no id of its own until it has been planned once, so this only ever
 * addresses a row the last board load created. Sending both fields empty is the
 * reset, which is why there is no separate delete.
 */
schedule.patch('/legs/:legId', async (c) => {
	const b = await body(c);
	const mode = str(b.mode);
	const mins = num(b.mins);
	return okOr(
		c,
		editLeg(c.req.param('legId'), c.get('trip').id, c.get('user').id, mode || null, mins),
		404,
		'Could not find that journey.'
	);
});

// --- Crews ------------------------------------------------------------------

schedule.post('/crews', async (c) => {
	const b = await body(c);
	const name = str(b.name);
	if (!name) return fail(c, 400, 'Enter a name.');
	const id = createCrew(c.get('trip').id, c.get('user').id, name, strList(b.people));
	if (!id) return fail(c, 403, 'Not allowed');
	return c.json({ id }, 201);
});

schedule.patch('/crews/:crewId', async (c) => {
	const b = await body(c);
	const name = str(b.name);
	if (b.name !== undefined && !name) return fail(c, 400, 'Enter a name.');
	return okOr(
		c,
		editCrew(
			c.req.param('crewId'),
			c.get('trip').id,
			c.get('user').id,
			name || undefined,
			b.people === undefined ? undefined : strList(b.people)
		),
		404,
		'Could not find that crew.'
	);
});

schedule.delete('/crews/:crewId', (c) =>
	okOr(
		c,
		deleteCrew(c.req.param('crewId'), c.get('trip').id, c.get('user').id),
		404,
		'Could not find that crew.'
	)
);
