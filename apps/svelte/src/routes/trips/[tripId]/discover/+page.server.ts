import { fail, redirect } from '@sveltejs/kit';
import { getTripForUser } from '$lib/server/trips';
import {
	addPoi,
	cityPois,
	poisNeedingPhotos,
	poiTitleExists,
	removePoi,
	setPoiPhoto,
	toggleVote,
	updatePoi
} from '$lib/server/pois';
import {
	addOption,
	cityLodging,
	lockOption,
	removeOption,
	setDates,
	vote as lodgingVote
} from '$lib/server/lodging';
import { activeProvider, lookupPhoto } from '$lib/server/places';
import type { Actions, PageServerLoad } from './$types';

/**
 * Fills in cover photos for places that never had one: seeded demo data, and
 * anything added through the keyless OSM provider. Each place is looked up at
 * most once ever (the result, hit or miss, is written back), so this is a
 * one-off cost on the first view of a trip and free afterwards. Failures are
 * swallowed: a missing picture must never stop the page from rendering.
 */
async function backfillPhotos(tripId: string): Promise<void> {
	const pending = poisNeedingPhotos(tripId);
	if (!pending.length) return;
	await Promise.allSettled(
		pending.map(async (p) => {
			const photo = await lookupPhoto(p.name, { city: p.city, country: p.country }, p.lat, p.lng);
			setPoiPhoto(p.id, photo);
		})
	);
}

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) throw redirect(303, '/login');
	const trip = getTripForUser(params.tripId, locals.user.id);
	if (!trip) throw redirect(303, '/trips');

	await backfillPhotos(trip.id);

	// Stays live in their own table (they carry prices, night ranges and a single
	// exclusive vote per city) but are presented alongside places on this page.
	const stays = cityLodging(trip.id, locals.user.id);
	return {
		cities: cityPois(trip.id, locals.user.id),
		stays: Object.fromEntries(stays.map((c) => [c.id, c.options])),
		staysVoted: Object.fromEntries(stays.map((c) => [c.id, c.voted])),
		currency: trip.home_currency,
		memberCount: trip.members.length,
		isOrganizer: trip.role === 'organizer',
		provider: activeProvider()
	};
};

export const actions: Actions = {
	add: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');

		const form = await request.formData();
		const cityId = String(form.get('cityId') ?? '');
		const placeName = String(form.get('name') ?? '').trim();
		// Optional activity label: "Sunset photos" at "Acropolis". When given it
		// becomes the card title and the place name is kept as context in the notes.
		const activity = String(form.get('activity') ?? '').trim();
		const category = String(form.get('category') ?? '').trim();
		let notes = String(form.get('notes') ?? '').trim() || null;
		const url = String(form.get('url') ?? '').trim() || null;
		const photo = String(form.get('photo') ?? '').trim() || null;
		const latRaw = String(form.get('lat') ?? '').trim();
		const lngRaw = String(form.get('lng') ?? '').trim();
		const lat = latRaw ? Number(latRaw) : null;
		const lng = lngRaw ? Number(lngRaw) : null;
		if (!placeName && !activity) return fail(400, { error: 'Name the place.' });

		const name = activity || placeName;
		if (activity && placeName) notes = notes ? `${placeName} · ${notes}` : placeName;

		if (poiTitleExists(trip.id, cityId, name)) {
			return fail(400, {
				error: activity
					? `“${name}” is already on the list for this city. Give this one a different activity.`
					: `“${name}” is already on the list. Add an activity to tell the two apart.`
			});
		}

		const ratingRaw = String(form.get('rating') ?? '').trim();
		const ratingCountRaw = String(form.get('ratingCount') ?? '').trim();
		const priceRaw = String(form.get('priceLevel') ?? '').trim();
		const hoursRaw = String(form.get('hours') ?? '').trim();
		let hours: string[] | null = null;
		if (hoursRaw) {
			try {
				const parsed = JSON.parse(hoursRaw);
				if (Array.isArray(parsed)) hours = parsed.map(String);
			} catch {
				hours = null;
			}
		}
		const rating = ratingRaw ? Number(ratingRaw) : null;
		const ratingCount = ratingCountRaw ? Number(ratingCountRaw) : null;
		const priceLevel = priceRaw ? Number(priceRaw) : null;

		const id = addPoi(
			trip.id,
			locals.user.id,
			cityId,
			name,
			category,
			notes,
			url,
			Number.isFinite(lat as number) ? lat : null,
			Number.isFinite(lng as number) ? lng : null,
			{
				rating: Number.isFinite(rating as number) ? rating : null,
				ratingCount: Number.isFinite(ratingCount as number) ? ratingCount : null,
				priceLevel: Number.isFinite(priceLevel as number) ? priceLevel : null,
				hours,
				photo
			}
		);
		if (!id) return fail(400, { error: 'Could not add place.' });
		return { ok: true };
	},

	vote: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		if (id) toggleVote(trip.id, locals.user.id, id);
		return { ok: true };
	},

	update: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');

		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const name = String(form.get('name') ?? '').trim();
		const notes = String(form.get('notes') ?? '').trim() || null;
		const url = String(form.get('url') ?? '').trim() || null;
		if (!id) return fail(400, { error: 'Unknown place.' });
		if (!name) return fail(400, { error: 'Name the place.' });
		updatePoi(trip.id, locals.user.id, id, { name, notes, url });
		return { ok: true };
	},

	remove: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		if (id) removePoi(trip.id, locals.user.id, id);
		return { ok: true };
	},

	// --- Stays --------------------------------------------------------------

	addStay: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');

		const form = await request.formData();
		const cityId = String(form.get('cityId') ?? '');
		const name = String(form.get('name') ?? '').trim();
		const tag = String(form.get('tag') ?? '').trim();
		const url = String(form.get('url') ?? '').trim() || null;
		const checkIn = String(form.get('checkIn') ?? '').trim() || null;
		const checkOut = String(form.get('checkOut') ?? '').trim() || null;
		const priceRaw = form.get('price');
		const price = priceRaw === null || priceRaw === '' ? null : Number(priceRaw);
		if (!name) return fail(400, { error: 'Name the stay.' });
		if (price !== null && (!Number.isFinite(price) || price < 0)) {
			return fail(400, { error: 'Enter a valid price.' });
		}
		if (checkIn && checkOut && checkIn > checkOut) {
			return fail(400, { error: 'Check-out must be after check-in.' });
		}

		const id = addOption(
			trip.id,
			locals.user.id,
			cityId,
			name,
			tag,
			price === null ? null : Math.round(price * 100),
			trip.home_currency,
			url,
			checkIn,
			checkOut
		);
		if (!id) return fail(400, { error: 'Could not add stay.' });
		return { ok: true };
	},

	voteStay: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const optionId = String(form.get('optionId') ?? '');
		if (optionId) lodgingVote(trip.id, locals.user.id, optionId);
		return { ok: true };
	},

	lockStay: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const optionId = String(form.get('optionId') ?? '');
		if (optionId) lockOption(trip.id, locals.user.id, optionId);
		return { ok: true };
	},

	removeStay: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const optionId = String(form.get('optionId') ?? '');
		if (optionId) removeOption(trip.id, locals.user.id, optionId);
		return { ok: true };
	},

	stayDates: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/login');
		const trip = getTripForUser(params.tripId, locals.user.id);
		if (!trip) throw redirect(303, '/trips');
		const form = await request.formData();
		const optionId = String(form.get('optionId') ?? '');
		const checkIn = String(form.get('checkIn') ?? '').trim() || null;
		const checkOut = String(form.get('checkOut') ?? '').trim() || null;
		if (checkIn && checkOut && checkIn > checkOut) {
			return fail(400, { error: 'Check-out must be after check-in.' });
		}
		if (optionId) setDates(trip.id, locals.user.id, optionId, checkIn, checkOut);
		return { ok: true };
	}
};
