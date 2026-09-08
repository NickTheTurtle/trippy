import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getTripForUser } from '@trippy/server/trips';
import {
	createItem,
	createTrack,
	estimateCityTravel,
	scheduleDays,
	setAssignees,
	tracksForDay
} from '@trippy/server/schedule';
import { routeTracks } from '@trippy/server/routing';
import { savedPoisForTrip } from '@trippy/server/pois';
import { lodgingForDay, lodgingOptionById } from '@trippy/server/lodging';
import {
	partiesForTrip,
	partyDayMap,
	membershipForDay,
	createParty,
	editParty,
	deleteParty,
	setPartyDay,
	assignMembership,
	firstTrackOfParty,
	defaultPartyId
} from '@trippy/server/parties';
import type { Actions, PageServerLoad } from './$types';

type ViewMode = 'day' | '3day' | 'people' | 'agenda';

/** Shift an ISO date (YYYY-MM-DD) by a number of days, staying in UTC. */
function shiftDay(iso: string, delta: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d + delta));
	return dt.toISOString().slice(0, 10);
}

/** The days visible for a given view, anchored on `day`. */
function visibleDays(view: ViewMode, day: string, scheduled: string[]): string[] {
	if (view === '3day') return [0, 1, 2].map((i) => shiftDay(day, i));
	if (view === 'agenda') return scheduled.length ? scheduled : [day];
	return [day];
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	if (!locals.user) throw redirect(303, '/login');
	const trip = getTripForUser(params.tripId, locals.user.id);
	if (!trip) throw redirect(303, '/trips');

	const days = scheduleDays(trip.id);
	const fallback = trip.cities[0]?.arrive ?? new Date().toISOString().slice(0, 10);
	const day = url.searchParams.get('day') ?? days[0] ?? fallback;
	const viewRaw = url.searchParams.get('view') ?? 'day';
	const view: ViewMode = (['day', '3day', 'people', 'agenda'] as const).includes(viewRaw as ViewMode)
		? (viewRaw as ViewMode)
		: 'day';

	// Which city does a given day fall in? (arrive inclusive, depart inclusive)
	const cityForDay = (d: string) =>
		trip.cities.find((c) => d >= c.arrive && d <= c.depart) ?? trip.cities[0] ?? null;

	const cityCell = (cityId: string | null) => {
		const c = cityId ? trip.cities.find((x) => x.id === cityId) ?? null : null;
		return c ? { id: c.id, name: c.name, tz: c.tz, lat: c.lat, lng: c.lng } : null;
	};

	const parties = partiesForTrip(trip.id);

	const wanted = visibleDays(view, day, days);
	const board = [];
	for (const d of wanted) {
		const tracks = tracksForDay(trip.id, d);
		// Refine straight-line legs into real road durations (falls back gracefully).
		await routeTracks(tracks);
		const c = cityForDay(d);
		const defaultCity = c ? { id: c.id, name: c.name, tz: c.tz, lat: c.lat, lng: c.lng } : null;
		const defaultLodging = c ? lodgingForDay(trip.id, c.id, d) : null;

		// Per-crew city + lodging for the day: a party_day override wins, else the
		// trip-wide city/lodging. Drives "view as" so a crew can be elsewhere.
		const pdMap = partyDayMap(trip.id, d);
		const cells: Record<string, { city: typeof defaultCity; lodging: typeof defaultLodging }> = {};
		for (const p of parties) {
			const pd = pdMap.get(p.id);
			const cityId = pd?.cityId ?? c?.id ?? null;
			const cell = pd?.cityId ? cityCell(pd.cityId) : defaultCity;
			const lodging = pd?.lodgingOptionId
				? lodgingOptionById(trip.id, pd.lodgingOptionId)
				: cityId
					? lodgingForDay(trip.id, cityId, d)
					: null;
			cells[p.id] = { city: cell, lodging };
		}

		board.push({
			day: d,
			city: defaultCity,
			lodging: defaultLodging,
			partyCells: cells,
			membership: membershipForDay(trip.id, d),
			tracks
		});
	}

	const anchorCity = cityForDay(day);

	return {
		days,
		day,
		view,
		board,
		members: trip.memberList,
		dayCity: anchorCity
			? { id: anchorCity.id, name: anchorCity.name, tz: anchorCity.tz, lat: anchorCity.lat, lng: anchorCity.lng }
			: null,
		mapsKey: env.GOOGLE_MAPS_KEY ?? '',
		saved: savedPoisForTrip(trip.id),
		parties,
		cities: trip.cities.map((c) => ({ id: c.id, name: c.name }))
	};
};

export const actions: Actions = {
	addTrack: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');

		const form = await request.formData();
		const day = String(form.get('day') ?? '');
		const name = String(form.get('name') ?? '').trim() || 'New track';
		const partyId = String(form.get('partyId') ?? '').trim() || undefined;
		if (day) createTrack(trip.id, day, name, partyId);
		return { ok: true };
	},

	addItem: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');

		const form = await request.formData();
		const trackId = String(form.get('trackId') ?? '');
		const poiId = String(form.get('poiId') ?? '');
		let title = String(form.get('title') ?? '').trim();
		const start = Number(form.get('start'));
		const durationMin = Number(form.get('duration')) || 60;
		const typeRaw = String(form.get('type') ?? 'poi');
		const type = ['poi', 'food', 'transport', 'travel', 'lodging', 'freetime'].includes(typeRaw)
			? typeRaw
			: 'poi';
		const travelRaw = Number(form.get('travelBefore'));
		const travelBefore = Number.isFinite(travelRaw) && travelRaw > 0 ? travelRaw : null;
		const assignees = String(form.get('assignees') ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (!trackId || !Number.isFinite(start)) return { ok: false };

		let lat: number | null = null;
		let lng: number | null = null;
		let linkedPoi: string | null = null;
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
		if (!title) {
			title = type === 'travel' ? 'Travel' : type === 'freetime' ? 'Free time' : '';
		}
		if (!title) return { ok: false };

		createItem(trackId, trip.id, locals.user.id, {
			title,
			startMin: start,
			endMin: start + durationMin,
			type,
			poiId: linkedPoi,
			lat,
			lng,
			travelBefore,
			assignees
		});
		return { ok: true };
	},

	setAssignees: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const itemId = String(form.get('itemId') ?? '');
		const assignees = String(form.get('assignees') ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (itemId) setAssignees(itemId, trip.id, locals.user.id, assignees);
		return { ok: true };
	},

	createCrew: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (name) createParty(trip.id, locals.user.id, name);
		return { ok: true };
	},

	editCrew: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const partyId = String(form.get('partyId') ?? '');
		const name = String(form.get('name') ?? '');
		const color = String(form.get('color') ?? '');
		if (partyId) editParty(trip.id, locals.user.id, partyId, name || undefined, color || undefined);
		return { ok: true };
	},

	deleteCrew: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const partyId = String(form.get('partyId') ?? '');
		if (partyId) deleteParty(trip.id, locals.user.id, partyId);
		return { ok: true };
	},

	setCrewDay: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const partyId = String(form.get('partyId') ?? '');
		const day = String(form.get('day') ?? '');
		const cityId = String(form.get('cityId') ?? '').trim() || null;
		const lodgingOptionId = String(form.get('lodgingOptionId') ?? '').trim() || null;
		if (partyId && day) setPartyDay(trip.id, locals.user.id, partyId, day, cityId, lodgingOptionId);
		return { ok: true };
	},

	// Move people into a crew from a start time to end of day (a "split off"). If
	// the crews are in different cities and the split is mid-day, drop a travel
	// bridge onto the target crew's lane so the seam is visible.
	splitOff: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const day = String(form.get('day') ?? '');
		let targetPartyId = String(form.get('partyId') ?? '').trim();
		const newName = String(form.get('newName') ?? '').trim();
		const fromRaw = Number(form.get('fromMin'));
		const fromMin = Number.isFinite(fromRaw) ? Math.max(0, Math.min(fromRaw, 24 * 60)) : 0;
		const userIds = String(form.get('userIds') ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (!day || !userIds.length) return { ok: false };

		if (!targetPartyId && newName) {
			targetPartyId = createParty(trip.id, locals.user.id, newName) ?? '';
		}
		if (!targetPartyId) return { ok: false };

		for (const uid of userIds) {
			assignMembership(trip.id, locals.user.id, targetPartyId, uid, day, fromMin, 24 * 60);
		}

		// Auto-travel bridge: only when splitting mid-day and the target crew has a
		// city set that differs from the trip default, with coordinates available.
		if (fromMin > 0) {
			const trackId = firstTrackOfParty(targetPartyId, day);
			const pd = partyDayMap(trip.id, day).get(targetPartyId);
			const toCity = pd?.cityId ? trip.cities.find((c) => c.id === pd.cityId) : null;
			const fromCity = trip.cities.find((c) => day >= c.arrive && day <= c.depart) ?? trip.cities[0];
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
				createItem(trackId, trip.id, locals.user.id, {
					title: `Travel to ${toCity.name}`,
					startMin: Math.max(0, fromMin - dur),
					endMin: fromMin,
					type: 'travel',
					assignees: userIds
				});
			}
		}
		return { ok: true };
	},

	// Return people to the Everyone party from a start time (a "rejoin").
	rejoin: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const day = String(form.get('day') ?? '');
		const fromRaw = Number(form.get('fromMin'));
		const fromMin = Number.isFinite(fromRaw) ? Math.max(0, Math.min(fromRaw, 24 * 60)) : 0;
		const userIds = String(form.get('userIds') ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (!day || !userIds.length) return { ok: false };
		const everyone = defaultPartyId(trip.id);
		for (const uid of userIds) {
			assignMembership(trip.id, locals.user.id, everyone, uid, day, fromMin, 24 * 60);
		}
		return { ok: true };
	}
};
