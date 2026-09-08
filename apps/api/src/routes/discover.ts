import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, num, optStr, str } from '../parse';
import type { Env } from '../types';
import { db } from '@trippy/server/db';
import {
	addPoi,
	cityPois,
	poisNeedingPhotos,
	poiTitleExists,
	removePoi,
	setPoiPhoto,
	toggleVote,
	updatePoi
} from '@trippy/server/pois';
import {
	addOption,
	cityLodging,
	lockOption,
	removeOption,
	setDates,
	vote as lodgingVote
} from '@trippy/server/lodging';
import {
	activeProvider,
	lookupPhoto,
	placeDetailsCached,
	searchPlaces,
	MIN_QUERY,
	type SearchKind
} from '@trippy/server/places';

export const discover = new Hono<Env>();

discover.use('*', requireMember);

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

discover.get('/', async (c) => {
	const trip = c.get('trip');
	const userId = c.get('user').id;

	await backfillPhotos(trip.id);

	// Stays live in their own table (they carry prices, night ranges and a single
	// exclusive vote per city) but are presented alongside places on this page.
	const stays = cityLodging(trip.id, userId);
	return c.json({
		cities: cityPois(trip.id, userId),
		stays: Object.fromEntries(stays.map((s) => [s.id, s.options])),
		staysVoted: Object.fromEntries(stays.map((s) => [s.id, s.voted])),
		currency: trip.home_currency,
		memberCount: trip.members.length,
		isOrganizer: trip.role === 'organizer',
		provider: activeProvider()
	});
});

// --- Search -----------------------------------------------------------------

discover.get('/search', async (c) => {
	const trip = c.get('trip');
	const q = c.req.query('q')?.trim() ?? '';
	const kind: SearchKind = c.req.query('kind') === 'stay' ? 'stay' : 'place';

	// Short queries are not a client error, they are a query still being typed.
	if (q.length < MIN_QUERY) return c.json({ results: [] });

	const city = db
		.prepare(`SELECT name, country FROM cities WHERE id = ? AND trip_id = ?`)
		.get(c.req.query('cityId') ?? '', trip.id) as { name: string; country: string } | undefined;
	if (!city) return c.json({ error: 'Unknown city' }, 400);

	return c.json({ results: await searchPlaces(q, { city: city.name, country: city.country }, kind) });
});

/**
 * The expensive half of the split search: ratings, price, hours, website and
 * photo for the one place a member has actually clicked. Kept off the search
 * endpoint so typing never buys this for eight results at once. Membership is
 * enforced (by the router-wide guard) even though the data is public, because
 * this endpoint spends our API quota and must not be an open proxy to Google.
 */
discover.get('/details', async (c) => {
	const id = c.req.query('id')?.trim() ?? '';
	if (!id) return c.json({ error: 'Missing id' }, 400);
	try {
		return c.json({ details: await placeDetailsCached(id) });
	} catch {
		// A failed enrichment is not a failed search; the caller still has the
		// name, address and pin, so let it show the result without the extras.
		return c.json({ details: null });
	}
});

// --- Places -----------------------------------------------------------------

discover.post('/pois', async (c) => {
	const trip = c.get('trip');
	const b = await body(c);

	const cityId = str(b.cityId);
	const placeName = str(b.name);
	// Optional activity label: "Sunset photos" at "Acropolis". When given it
	// becomes the card title and the place name is kept as context in the notes.
	const activity = str(b.activity);
	if (!placeName && !activity) return c.json({ error: 'Name the place.' }, 400);

	const name = activity || placeName;
	let notes = optStr(b.notes);
	if (activity && placeName) notes = notes ? `${placeName} · ${notes}` : placeName;

	if (poiTitleExists(trip.id, cityId, name)) {
		return c.json(
			{
				error: activity
					? `“${name}” is already on the list for this city. Give this one a different activity.`
					: `“${name}” is already on the list. Add an activity to tell the two apart.`
			},
			400
		);
	}

	const hours = Array.isArray(b.hours) ? b.hours.map(String) : null;

	const id = addPoi(
		trip.id,
		c.get('user').id,
		cityId,
		name,
		str(b.category),
		notes,
		optStr(b.url),
		num(b.lat),
		num(b.lng),
		{
			rating: num(b.rating),
			ratingCount: num(b.ratingCount),
			priceLevel: num(b.priceLevel),
			hours,
			photo: optStr(b.photo)
		}
	);
	if (!id) return c.json({ error: 'Could not add place.' }, 400);
	return c.json({ id }, 201);
});

discover.patch('/pois/:poiId', async (c) => {
	const b = await body(c);
	const name = str(b.name);
	if (!name) return c.json({ error: 'Name the place.' }, 400);

	const ok = updatePoi(c.get('trip').id, c.get('user').id, c.req.param('poiId'), {
		name,
		notes: optStr(b.notes),
		url: optStr(b.url)
	});
	if (!ok) return c.json({ error: 'Could not save that place.' }, 400);
	return c.json({ ok: true });
});

discover.delete('/pois/:poiId', (c) => {
	removePoi(c.get('trip').id, c.get('user').id, c.req.param('poiId'));
	return c.json({ ok: true });
});

// A toggle, so POST rather than PUT: the same request twice is a vote and then
// an un-vote, which is the intended behaviour and not idempotent.
discover.post('/pois/:poiId/vote', (c) => {
	toggleVote(c.get('trip').id, c.get('user').id, c.req.param('poiId'));
	return c.json({ ok: true });
});

// --- Stays ------------------------------------------------------------------

discover.post('/stays', async (c) => {
	const trip = c.get('trip');
	const b = await body(c);

	const name = str(b.name);
	if (!name) return c.json({ error: 'Name the stay.' }, 400);

	const price = b.price === null || b.price === undefined || b.price === '' ? null : num(b.price);
	if (b.price !== null && b.price !== undefined && b.price !== '' && (price === null || price < 0)) {
		return c.json({ error: 'Enter a valid price.' }, 400);
	}

	const checkIn = optStr(b.checkIn);
	const checkOut = optStr(b.checkOut);
	if (checkIn && checkOut && checkIn > checkOut) {
		return c.json({ error: 'Check-out must be after check-in.' }, 400);
	}

	const id = addOption(
		trip.id,
		c.get('user').id,
		str(b.cityId),
		name,
		str(b.tag),
		price === null ? null : Math.round(price * 100),
		trip.home_currency,
		optStr(b.url),
		checkIn,
		checkOut
	);
	if (!id) return c.json({ error: 'Could not add stay.' }, 400);
	return c.json({ id }, 201);
});

discover.post('/stays/:optionId/vote', (c) => {
	lodgingVote(c.get('trip').id, c.get('user').id, c.req.param('optionId'));
	return c.json({ ok: true });
});

discover.post('/stays/:optionId/lock', (c) => {
	lockOption(c.get('trip').id, c.get('user').id, c.req.param('optionId'));
	return c.json({ ok: true });
});

discover.delete('/stays/:optionId', (c) => {
	removeOption(c.get('trip').id, c.get('user').id, c.req.param('optionId'));
	return c.json({ ok: true });
});

discover.patch('/stays/:optionId/dates', async (c) => {
	const b = await body(c);
	const checkIn = optStr(b.checkIn);
	const checkOut = optStr(b.checkOut);
	if (checkIn && checkOut && checkIn > checkOut) {
		return c.json({ error: 'Check-out must be after check-in.' }, 400);
	}
	setDates(c.get('trip').id, c.get('user').id, c.req.param('optionId'), checkIn, checkOut);
	return c.json({ ok: true });
});
