import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, isoDay, num, optStr, str, strList } from '../parse';
import { fail, ok, okOr } from '../respond';
import type { Env, Trip } from '../types';
import { env } from '@trippy/server/env';
import { isItemType } from '@trippy/core/types';
import {
	createItem,
	createTrack,
	cycleBooking,
	deleteItem,
	editItem,
	estimateCityTravel,
	itemTrip,
	moveItem,
	removeTrack,
	resizeItem,
	scheduleDays,
	setAssignees,
	tracksForDay
} from '@trippy/server/schedule';
import { routeTracks } from '@trippy/server/routing';
import { savedPoisForTrip } from '@trippy/server/pois';
import { lodgingForDay, lodgingOptionById } from '@trippy/server/lodging';
import {
	assignMemberships,
	createParty,
	defaultPartyId,
	deleteParty,
	editParty,
	firstTrackOfParty,
	membershipForDay,
	partiesForTrip,
	partyDayMap,
	setPartyDay
} from '@trippy/server/parties';

export const calendar = new Hono<Env>();

calendar.use('*', requireMember);

const VIEWS = ['day', '3day', 'people', 'agenda'] as const;
type ViewMode = (typeof VIEWS)[number];

/**
 * The 404 an item mutation answers with when the item is not this trip's.
 *
 * The mutations enforce this themselves now (they take the trip id and refuse a
 * foreign item), so this is not the security boundary; it only decides which
 * refusal the caller is told about. Without it a cross-trip id would come back
 * as the generic 403 "Not allowed", which is the wrong story: the item is not
 * missing permission in this trip, it is not in this trip at all. `itemTrip`
 * also returns null for an id that exists nowhere, and that is the same 404,
 * which is deliberate: it keeps a stranger from probing for real item ids.
 */
function foreignItem(tripId: string, itemId: string): boolean {
	return itemTrip(itemId) !== tripId;
}

/** Whether a crew belongs to this trip. Guards ids that arrive in a body. */
function partyInTrip(tripId: string, partyId: string): boolean {
	return partiesForTrip(tripId).some((p) => p.id === partyId);
}

/** Shift an ISO date (YYYY-MM-DD) by a number of days, staying in UTC. */
function shiftDay(iso: string, delta: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** The days visible for a given view, anchored on `day`. */
function visibleDays(view: ViewMode, day: string, scheduled: string[]): string[] {
	if (view === '3day') return [0, 1, 2].map((i) => shiftDay(day, i));
	if (view === 'agenda') return scheduled.length ? scheduled : [day];
	return [day];
}

calendar.get('/', async (c) => {
	const trip = c.get('trip');

	const days = scheduleDays(trip.id);
	// `day` is fed to shiftDay(), so a malformed one would build an Invalid Date
	// and throw inside toISOString(), turning a mistyped url into a 500. Anything
	// that is not a real calendar day falls back to the first scheduled day, then
	// the trip start, which is what a bare /calendar shows.
	const fallback =
		isoDay(days[0]) ?? isoDay(trip.start_date) ?? new Date().toISOString().slice(0, 10);
	const day = isoDay(c.req.query('day')) ?? fallback;
	const viewRaw = c.req.query('view') ?? 'day';
	const view: ViewMode = VIEWS.includes(viewRaw as ViewMode) ? (viewRaw as ViewMode) : 'day';

	// Cities are dateless itinerary places now. Until the calendar redesign adds
	// real day-to-city assignment, the first city is only the trip-wide default;
	// party_day is the one deliberate override, so we do not fabricate a schedule
	// by slicing the trip date range across cities.
	const tripDefaultCity = trip.cities[0] ?? null;

	const cell = (city: Trip['cities'][number] | null | undefined) =>
		city ? { id: city.id, name: city.name, tz: city.tz, lat: city.lat, lng: city.lng } : null;

	const parties = partiesForTrip(trip.id);

	const board = [];
	for (const d of visibleDays(view, day, days)) {
		const tracks = tracksForDay(trip.id, d);
		// Refine straight-line legs into real road durations (falls back gracefully).
		await routeTracks(tracks);
		const city = tripDefaultCity;
		const defaultCity = cell(city);
		const defaultLodging = city ? lodgingForDay(trip.id, city.id, d) : null;

		// Per-crew city + lodging for the day: a party_day override wins, else the
		// trip-wide city/lodging. Drives "view as" so a crew can be elsewhere.
		const pdMap = partyDayMap(trip.id, d);
		const partyCells: Record<string, { city: typeof defaultCity; lodging: typeof defaultLodging }> =
			{};
		for (const p of parties) {
			const pd = pdMap.get(p.id);
			const cityId = pd?.cityId ?? city?.id ?? null;
			partyCells[p.id] = {
				city: pd?.cityId ? cell(trip.cities.find((x) => x.id === pd.cityId)) : defaultCity,
				lodging: pd?.lodgingOptionId
					? lodgingOptionById(trip.id, pd.lodgingOptionId)
					: cityId
						? lodgingForDay(trip.id, cityId, d)
						: null
			};
		}

		board.push({
			day: d,
			city: defaultCity,
			lodging: defaultLodging,
			partyCells,
			membership: membershipForDay(trip.id, d),
			tracks
		});
	}

	return c.json({
		days,
		day,
		view,
		board,
		members: trip.memberList,
		dayCity: cell(tripDefaultCity),
		mapsKey: env.GOOGLE_MAPS_KEY ?? '',
		saved: savedPoisForTrip(trip.id),
		parties,
		cities: trip.cities.map((x) => ({ id: x.id, name: x.name }))
	});
});

// --- Tracks and items -------------------------------------------------------

calendar.post('/tracks', async (c) => {
	const trip = c.get('trip');
	const b = await body(c);
	const day = isoDay(b.day);
	if (!day) return fail(c, 400, 'Pick a valid day.');

	// A crew id from the body is a cross-trip reference waiting to happen: the
	// column has no trip of its own, and the board joins the crew's name and
	// colour by id, so an id borrowed from another trip would show that trip's
	// crew here. Nothing but this trip's own crews is accepted.
	const partyId = optStr(b.partyId);
	if (partyId && !partyInTrip(trip.id, partyId)) return fail(c, 400, 'Could not find that crew.');

	const id = createTrack(trip.id, day, str(b.name) || 'New track', partyId ?? undefined);
	return c.json({ id }, 201);
});

// Deleting a track takes its scheduled items with it, by cascade. That is the
// point rather than a side effect: a track is the thing the items belong to,
// and there is nowhere else to put them.
calendar.delete('/tracks/:trackId', (c) =>
	okOr(
		c,
		removeTrack(c.req.param('trackId'), c.get('trip').id, c.get('user').id),
		404,
		'Could not find that track.'
	)
);

calendar.post('/items', async (c) => {
	const trip = c.get('trip');
	const b = await body(c);

	const trackId = str(b.trackId);
	const start = num(b.start);
	if (!trackId || start === null) return fail(c, 400, 'Pick a track and a start time.');

	const typeRaw = str(b.type) || 'poi';
	// The vocabulary is core's, so the API, the server and the calendar all agree
	// on the same six literals without three copies of the list.
	const type = isItemType(typeRaw) ? typeRaw : 'poi';
	const travelRaw = num(b.travelBefore);

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

	// Sensible default titles for placeholder activities.
	if (!title) title = type === 'travel' ? 'Travel' : type === 'freetime' ? 'Free time' : '';
	if (!title) return fail(c, 400, 'Enter a title.');

	const id = createItem(trackId, trip.id, c.get('user').id, {
		title,
		startMin: start,
		endMin: start + (num(b.duration) || 60),
		type,
		poiId: linkedPoi,
		lat,
		lng,
		travelBefore: travelRaw !== null && travelRaw > 0 ? travelRaw : null,
		assignees: strList(b.assignees)
	});
	if (!id) return fail(c, 403, 'Could not add that item.');
	return c.json({ id }, 201);
});

calendar.put('/items/:itemId/assignees', async (c) => {
	const trip = c.get('trip');
	const itemId = c.req.param('itemId');
	// `setAssignees` refuses a foreign item on its own; this only keeps the
	// answer a 404 rather than a 403.
	if (foreignItem(trip.id, itemId)) return fail(c, 404, 'Could not find that item.');

	return okOr(
		c,
		setAssignees(itemId, trip.id, c.get('user').id, strList((await body(c)).assignees)),
		403,
		'Not allowed'
	);
});

/**
 * Drag, resize, retitle, cycle booking state, delete.
 *
 * These stay behind one `op` field rather than becoming five REST endpoints
 * because the calendar UI fires them from one drag handler, and the ownership
 * check is the same for all of them. Splitting them would spread that check
 * across five places for no gain.
 */
calendar.post('/items/:itemId/op', async (c) => {
	const trip = c.get('trip');
	const itemId = c.req.param('itemId');
	const userId = c.get('user').id;
	const b = await body(c);

	// Every mutation below is passed the trip and refuses an item belonging to
	// another one, so this is about the status, not the check: a cross-trip id is
	// a 404, not the 403 that a real permission failure inside this trip earns.
	if (foreignItem(trip.id, itemId)) return fail(c, 404, 'Could not find that item.');

	let okay = false;
	switch (str(b.op)) {
		case 'move':
			okay = moveItem(itemId, userId, num(b.startMin) ?? NaN, trip.id);
			break;
		case 'resize':
			okay = resizeItem(itemId, userId, num(b.endMin) ?? NaN, trip.id);
			break;
		case 'edit':
			okay = editItem(
				itemId,
				userId,
				{
					title: b.title != null ? String(b.title) : undefined,
					type: b.type != null ? String(b.type) : undefined,
					// Three cases, not two: absent means leave it alone, null or empty
					// means clear it, a number means set it.
					travelBefore:
						b.travelBefore === undefined
							? undefined
							: b.travelBefore === null || b.travelBefore === ''
								? null
								: num(b.travelBefore)
				},
				trip.id
			);
			break;
		case 'cycle':
			okay = cycleBooking(itemId, userId, trip.id);
			break;
		case 'delete':
			okay = deleteItem(itemId, userId, trip.id);
			break;
		default:
			return fail(c, 400, 'Unknown op.');
	}

	return okOr(c, okay, 403, 'Not allowed');
});

// --- Crews ------------------------------------------------------------------

calendar.post('/crews', async (c) => {
	const name = str((await body(c)).name);
	if (!name) return fail(c, 400, 'Enter a name.');
	const id = createParty(c.get('trip').id, c.get('user').id, name);
	if (!id) return fail(c, 403, 'Could not create that crew.');
	return c.json({ id }, 201);
});

calendar.patch('/crews/:partyId', async (c) => {
	const b = await body(c);
	// False here means the crew is not this trip's, or it is the Everyone party,
	// or neither field was usable. All three are refusals, not successes.
	return okOr(
		c,
		editParty(
			c.get('trip').id,
			c.get('user').id,
			c.req.param('partyId'),
			optStr(b.name) ?? undefined,
			optStr(b.color) ?? undefined
		),
		400,
		'Could not save that crew.'
	);
});

calendar.delete('/crews/:partyId', (c) =>
	okOr(
		c,
		deleteParty(c.get('trip').id, c.get('user').id, c.req.param('partyId')),
		400,
		'Could not delete that crew.'
	)
);

calendar.put('/crews/:partyId/day', async (c) => {
	const b = await body(c);
	const day = isoDay(b.day);
	if (!day) return fail(c, 400, 'Pick a valid day.');

	// `setPartyDay` returns false for a city or a stay that is not this trip's,
	// and for a stay that is not in the chosen city. Those are bad references in
	// the request, so 400, not a server fault and not a silent success.
	return okOr(
		c,
		setPartyDay(
			c.get('trip').id,
			c.get('user').id,
			c.req.param('partyId'),
			day,
			optStr(b.cityId),
			optStr(b.lodgingOptionId)
		),
		400,
		'Could not set that crew’s day.'
	);
});

/**
 * Move people into a crew from a start time to end of day (a "split off"). If
 * the crews are in different cities and the split is mid-day, drop a travel
 * bridge onto the target crew's lane so the seam is visible.
 */
calendar.post('/crews/split', async (c) => {
	const trip = c.get('trip');
	const userId = c.get('user').id;
	const b = await body(c);

	const day = isoDay(b.day);
	const userIds = strList(b.userIds);
	if (!day || !userIds.length) return fail(c, 400, 'Pick a day and at least one person.');

	// Everyone named has to be on this trip. Checked before anything is written,
	// so a bad id cannot leave half the group moved and half not.
	const memberIds = new Set(trip.memberList.map((m) => m.id));
	if (userIds.some((uid) => !memberIds.has(uid))) {
		return fail(c, 400, 'That person is not on this trip.');
	}

	const fromRaw = num(b.fromMin);
	const fromMin = fromRaw === null ? 0 : Math.max(0, Math.min(fromRaw, 24 * 60));

	let targetPartyId = str(b.partyId);
	const newName = str(b.newName);
	if (!targetPartyId && newName) targetPartyId = createParty(trip.id, userId, newName) ?? '';
	if (!targetPartyId) return fail(c, 400, 'Pick or name a crew.');
	// A crew id from the body, like a track's, has to be this trip's own.
	if (!partyInTrip(trip.id, targetPartyId)) return fail(c, 400, 'Could not find that crew.');

	if (!assignMemberships(trip.id, userId, targetPartyId, userIds, day, fromMin, 24 * 60)) {
		// Everything it validates has been validated above, so a false here is a
		// state change we did not expect rather than a normal refusal.
		return fail(c, 400, 'Could not move everyone into that crew.');
	}

	// Auto-travel bridge: only when splitting mid-day and the target crew has a
	// city set that differs from the trip default, with coordinates available.
	if (fromMin > 0) {
		const trackId = firstTrackOfParty(targetPartyId, day);
		const pd = partyDayMap(trip.id, day).get(targetPartyId);
		const toCity = pd?.cityId ? trip.cities.find((x) => x.id === pd.cityId) : null;
		const fromCity = trip.cities[0] ?? null;
		if (
			trackId &&
			toCity &&
			fromCity &&
			toCity.id !== fromCity.id &&
			fromCity.lat != null &&
			fromCity.lng != null &&
			toCity.lat != null &&
			toCity.lng != null
		) {
			const est = estimateCityTravel(fromCity.lat, fromCity.lng, toCity.lat, toCity.lng);
			const dur = Math.min(est.mins, 12 * 60);
			createItem(trackId, trip.id, userId, {
				title: `Travel to ${toCity.name}`,
				startMin: Math.max(0, fromMin - dur),
				endMin: fromMin,
				type: 'travel',
				assignees: userIds
			});
		}
	}

	return c.json({ partyId: targetPartyId });
});

/** Return people to the Everyone party from a start time (a "rejoin"). */
calendar.post('/crews/rejoin', async (c) => {
	const trip = c.get('trip');
	const userId = c.get('user').id;
	const b = await body(c);

	const day = isoDay(b.day);
	const userIds = strList(b.userIds);
	if (!day || !userIds.length) return fail(c, 400, 'Pick a day and at least one person.');

	const memberIds = new Set(trip.memberList.map((m) => m.id));
	if (userIds.some((uid) => !memberIds.has(uid))) {
		return fail(c, 400, 'That person is not on this trip.');
	}

	const fromRaw = num(b.fromMin);
	const fromMin = fromRaw === null ? 0 : Math.max(0, Math.min(fromRaw, 24 * 60));

	const everyone = defaultPartyId(trip.id);
	if (!assignMemberships(trip.id, userId, everyone, userIds, day, fromMin, 24 * 60)) {
		return fail(c, 400, 'Could not bring everyone back.');
	}
	return ok(c);
});
