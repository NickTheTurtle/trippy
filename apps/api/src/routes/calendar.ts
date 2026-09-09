import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, num, optStr, str, strList } from '../parse';
import type { Env, Trip } from '../types';
import { env } from '@trippy/server/env';
import {
	createItem,
	createTrack,
	cycleBooking,
	deleteItem,
	editItem,
	estimateCityTravel,
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
	assignMembership,
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

const ITEM_TYPES = ['poi', 'food', 'transport', 'travel', 'lodging', 'freetime'];

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
	const fallback = trip.cities[0]?.arrive ?? new Date().toISOString().slice(0, 10);
	const day = c.req.query('day') ?? days[0] ?? fallback;
	const viewRaw = c.req.query('view') ?? 'day';
	const view: ViewMode = VIEWS.includes(viewRaw as ViewMode) ? (viewRaw as ViewMode) : 'day';

	// Which city does a given day fall in? (arrive inclusive, depart inclusive)
	const cityForDay = (d: string) =>
		trip.cities.find((x) => d >= x.arrive && d <= x.depart) ?? trip.cities[0] ?? null;

	const cell = (city: Trip['cities'][number] | null | undefined) =>
		city ? { id: city.id, name: city.name, tz: city.tz, lat: city.lat, lng: city.lng } : null;

	const parties = partiesForTrip(trip.id);

	const board = [];
	for (const d of visibleDays(view, day, days)) {
		const tracks = tracksForDay(trip.id, d);
		// Refine straight-line legs into real road durations (falls back gracefully).
		await routeTracks(tracks);
		const city = cityForDay(d);
		const defaultCity = cell(city);
		const defaultLodging = city ? lodgingForDay(trip.id, city.id, d) : null;

		// Per-crew city + lodging for the day: a party_day override wins, else the
		// trip-wide city/lodging. Drives "view as" so a crew can be elsewhere.
		const pdMap = partyDayMap(trip.id, d);
		const partyCells: Record<
			string,
			{ city: typeof defaultCity; lodging: typeof defaultLodging }
		> = {};
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
		dayCity: cell(cityForDay(day)),
		mapsKey: env.GOOGLE_MAPS_KEY ?? '',
		saved: savedPoisForTrip(trip.id),
		parties,
		cities: trip.cities.map((x) => ({ id: x.id, name: x.name }))
	});
});

// --- Tracks and items -------------------------------------------------------

calendar.post('/tracks', async (c) => {
	const b = await body(c);
	const day = str(b.day);
	if (!day) return c.json({ error: 'Missing day' }, 400);

	const id = createTrack(
		c.get('trip').id,
		day,
		str(b.name) || 'New track',
		optStr(b.partyId) ?? undefined
	);
	return c.json({ id }, 201);
});

// Deleting a track takes its scheduled items with it, by cascade. That is the
// point rather than a side effect: a track is the thing the items belong to,
// and there is nowhere else to put them.
calendar.delete('/tracks/:trackId', (c) => {
	const okay = removeTrack(c.req.param('trackId'), c.get('trip').id, c.get('user').id);
	if (!okay) return c.json({ error: 'Track not found.' }, 404);
	return c.json({ ok: true });
});

calendar.post('/items', async (c) => {
	const trip = c.get('trip');
	const b = await body(c);

	const trackId = str(b.trackId);
	const start = num(b.start);
	if (!trackId || start === null) return c.json({ error: 'Missing track or start time' }, 400);

	const typeRaw = str(b.type) || 'poi';
	const type = ITEM_TYPES.includes(typeRaw) ? typeRaw : 'poi';
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
	if (!title) return c.json({ error: 'Give the item a title.' }, 400);

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
	if (!id) return c.json({ error: 'Could not add that item.' }, 403);
	return c.json({ id }, 201);
});

calendar.put('/items/:itemId/assignees', async (c) => {
	const ok = setAssignees(
		c.req.param('itemId'),
		c.get('trip').id,
		c.get('user').id,
		strList((await body(c)).assignees)
	);
	if (!ok) return c.json({ error: 'Not allowed' }, 403);
	return c.json({ ok: true });
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
	const itemId = c.req.param('itemId');
	const userId = c.get('user').id;
	const b = await body(c);

	let ok = false;
	switch (str(b.op)) {
		case 'move':
			ok = moveItem(itemId, userId, num(b.startMin) ?? NaN);
			break;
		case 'resize':
			ok = resizeItem(itemId, userId, num(b.endMin) ?? NaN);
			break;
		case 'edit':
			ok = editItem(itemId, userId, {
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
			});
			break;
		case 'cycle':
			ok = cycleBooking(itemId, userId);
			break;
		case 'delete':
			ok = deleteItem(itemId, userId);
			break;
		default:
			return c.json({ error: 'Unknown op' }, 400);
	}

	if (!ok) return c.json({ error: 'Not allowed' }, 403);
	return c.json({ ok: true });
});

// --- Crews ------------------------------------------------------------------

calendar.post('/crews', async (c) => {
	const name = str((await body(c)).name);
	if (!name) return c.json({ error: 'Name the crew.' }, 400);
	const id = createParty(c.get('trip').id, c.get('user').id, name);
	if (!id) return c.json({ error: 'Could not create that crew.' }, 400);
	return c.json({ id }, 201);
});

calendar.patch('/crews/:partyId', async (c) => {
	const b = await body(c);
	editParty(
		c.get('trip').id,
		c.get('user').id,
		c.req.param('partyId'),
		optStr(b.name) ?? undefined,
		optStr(b.color) ?? undefined
	);
	return c.json({ ok: true });
});

calendar.delete('/crews/:partyId', (c) => {
	deleteParty(c.get('trip').id, c.get('user').id, c.req.param('partyId'));
	return c.json({ ok: true });
});

calendar.put('/crews/:partyId/day', async (c) => {
	const b = await body(c);
	const day = str(b.day);
	if (!day) return c.json({ error: 'Missing day' }, 400);
	setPartyDay(
		c.get('trip').id,
		c.get('user').id,
		c.req.param('partyId'),
		day,
		optStr(b.cityId),
		optStr(b.lodgingOptionId)
	);
	return c.json({ ok: true });
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

	const day = str(b.day);
	const userIds = strList(b.userIds);
	if (!day || !userIds.length) return c.json({ error: 'Pick a day and at least one person.' }, 400);

	const fromRaw = num(b.fromMin);
	const fromMin = fromRaw === null ? 0 : Math.max(0, Math.min(fromRaw, 24 * 60));

	let targetPartyId = str(b.partyId);
	const newName = str(b.newName);
	if (!targetPartyId && newName) targetPartyId = createParty(trip.id, userId, newName) ?? '';
	if (!targetPartyId) return c.json({ error: 'Pick or name a crew.' }, 400);

	for (const uid of userIds) {
		assignMembership(trip.id, userId, targetPartyId, uid, day, fromMin, 24 * 60);
	}

	// Auto-travel bridge: only when splitting mid-day and the target crew has a
	// city set that differs from the trip default, with coordinates available.
	if (fromMin > 0) {
		const trackId = firstTrackOfParty(targetPartyId, day);
		const pd = partyDayMap(trip.id, day).get(targetPartyId);
		const toCity = pd?.cityId ? trip.cities.find((x) => x.id === pd.cityId) : null;
		const fromCity = trip.cities.find((x) => day >= x.arrive && day <= x.depart) ?? trip.cities[0];
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

	const day = str(b.day);
	const userIds = strList(b.userIds);
	if (!day || !userIds.length) return c.json({ error: 'Pick a day and at least one person.' }, 400);

	const fromRaw = num(b.fromMin);
	const fromMin = fromRaw === null ? 0 : Math.max(0, Math.min(fromRaw, 24 * 60));

	const everyone = defaultPartyId(trip.id);
	for (const uid of userIds) {
		assignMembership(trip.id, userId, everyone, uid, day, fromMin, 24 * 60);
	}
	return c.json({ ok: true });
});
