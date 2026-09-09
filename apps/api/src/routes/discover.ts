import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, int, isoDay, num, optStr, str } from '../parse';
import { fail, okOr } from '../respond';
import type { Env } from '../types';
import { addPoi, cityPois, poiTitleExists, removePoi, toggleVote, updatePoi } from '@trippy/server/pois';
import {
	addOption,
	cityLodging,
	lockOption,
	removeOption,
	setDates,
	vote as lodgingVote
} from '@trippy/server/lodging';
import { backfillTripPhotos } from '@trippy/server/photos';
import { citySearchContext } from '@trippy/server/trips';
import {
	activeProvider,
	placeDetailsCached,
	searchPlaces,
	MIN_QUERY,
	type SearchKind
} from '@trippy/server/places';

export const discover = new Hono<Env>();

discover.use('*', requireMember);

discover.get('/', async (c) => {
	const trip = c.get('trip');
	const userId = c.get('user').id;

	// Cover photos for places and stays that have never had one looked up:
	// seeded demo data, and anything added through the keyless OSM provider.
	// The helper owns the rules (one lookup per row ever, a cap per request, a
	// bounded number in flight) because every lookup is billed by Google.
	await backfillTripPhotos(trip.id);

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

	// The city bias for the search, resolved only if the city is this trip's, so
	// an id from another trip cannot steer where we look.
	const city = citySearchContext(trip.id, c.req.query('cityId') ?? '');
	if (!city) return fail(c, 400, 'Unknown city');

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
	if (!id) return fail(c, 400, 'Missing id');
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
	if (!placeName && !activity) return fail(c, 400, 'Name the place.');

	const name = activity || placeName;
	let notes = optStr(b.notes);
	if (activity && placeName) notes = notes ? `${placeName} · ${notes}` : placeName;

	if (poiTitleExists(trip.id, cityId, name)) {
		return fail(
			c,
			400,
			activity
				? `“${name}” is already on the list for this city. Give this one a different activity.`
				: `“${name}” is already on the list. Add an activity to tell the two apart.`
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
		},
		// The Discover bucket. Passing undefined rather than a guess when the
		// client did not send one is the whole point: the server then derives it
		// from the provider category, which is better than defaulting to
		// `attraction` and dropping every restaurant into the wrong tab.
		optStr(b.kind) ?? undefined
	);
	if (!id) return fail(c, 400, 'Could not add place. Check the city.');
	return c.json({ id }, 201);
});

discover.patch('/pois/:poiId', async (c) => {
	const b = await body(c);
	const name = str(b.name);
	if (!name) return fail(c, 400, 'Name the place.');

	return okOr(
		c,
		updatePoi(c.get('trip').id, c.get('user').id, c.req.param('poiId'), {
			name,
			notes: optStr(b.notes),
			url: optStr(b.url),
			// Patch semantics: only forwarded when the client actually sent it.
			// Defaulting it here would reclassify a food place as an attraction
			// every time someone renamed one.
			kind: b.kind === undefined ? undefined : optStr(b.kind)
		}),
		404,
		'Could not save that place.'
	);
});

discover.delete('/pois/:poiId', (c) =>
	okOr(
		c,
		removePoi(c.get('trip').id, c.get('user').id, c.req.param('poiId')),
		404,
		'Could not remove that place.'
	)
);

// A toggle, so POST rather than PUT: the same request twice is a vote and then
// an un-vote, which is the intended behaviour and not idempotent.
discover.post('/pois/:poiId/vote', (c) =>
	okOr(
		c,
		toggleVote(c.get('trip').id, c.get('user').id, c.req.param('poiId')),
		404,
		'Could not vote on that place.'
	)
);

// --- Stays ------------------------------------------------------------------

/**
 * An optional night-range date from a body field: null when blank (a stay with
 * no range applies to the whole city stay), `'bad'` when it is not a real day.
 * These end up in string comparisons against the board's days, so a value that
 * only looks like a date would silently never match.
 */
function optDay(v: unknown): string | null | 'bad' {
	if (optStr(v) === null) return null;
	return isoDay(v) ?? 'bad';
}

/**
 * The per-night price of a stay, in whole cents.
 *
 * `priceCents` is the field to send: it is what the column holds, and an
 * integer cannot pick up a rounding error on the way in. `price`, in major
 * units, is what the current web form posts and stays supported. Absent or
 * empty is null, which is the real state "proposed but not priced yet".
 * `'bad'` means present but not a non-negative amount.
 */
function stayPriceCents(b: Record<string, unknown>): number | null | 'bad' {
	const blank = (v: unknown) => v === null || v === undefined || v === '';
	if (!blank(b.priceCents)) {
		const cents = int(b.priceCents);
		return cents === null || cents < 0 ? 'bad' : cents;
	}
	if (!blank(b.price)) {
		const major = num(b.price);
		return major === null || major < 0 ? 'bad' : Math.round(major * 100);
	}
	return null;
}

/**
 * Propose a stay for a city.
 *
 * Only `cityId` and `name` are required. A stay is worth putting up for a vote
 * with nothing but a name and what it costs per night: the night range is set
 * later from the stay's own editor, and the currency is the trip's home
 * currency, so neither is asked for here.
 */
discover.post('/stays', async (c) => {
	const trip = c.get('trip');
	const b = await body(c);

	const name = str(b.name);
	if (!name) return fail(c, 400, 'Name the stay.');

	const price = stayPriceCents(b);
	if (price === 'bad') return fail(c, 400, 'Enter a valid price.');

	const checkIn = optDay(b.checkIn);
	const checkOut = optDay(b.checkOut);
	if (checkIn === 'bad' || checkOut === 'bad') return fail(c, 400, 'Enter valid dates.');
	if (checkIn && checkOut && checkIn > checkOut) {
		return fail(c, 400, 'Check-out must be after check-in.');
	}

	const id = addOption(
		trip.id,
		c.get('user').id,
		str(b.cityId),
		name,
		// `notes` is the field name the add popup uses for the one free-text line
		// a stay carries; the column has always been called `tag`.
		str(b.tag) || str(b.notes),
		price,
		// Blank: the server falls back to the trip's home currency, which is what
		// a price typed on this page is denominated in.
		'',
		optStr(b.url),
		checkIn,
		checkOut,
		optStr(b.photo)
	);
	if (!id) return fail(c, 400, 'Could not add stay. Check the city and the name.');
	return c.json({ id }, 201);
});

discover.post('/stays/:optionId/vote', (c) =>
	okOr(
		c,
		lodgingVote(c.get('trip').id, c.get('user').id, c.req.param('optionId')),
		404,
		'Could not vote on that stay.'
	)
);

// Organizer only, which `lockOption` enforces and reports as false. Returning
// success regardless told a member their pick had been locked when it had not.
discover.post('/stays/:optionId/lock', (c) =>
	okOr(
		c,
		lockOption(c.get('trip').id, c.get('user').id, c.req.param('optionId')),
		403,
		'Only the organizer can lock a stay.'
	)
);

discover.delete('/stays/:optionId', (c) =>
	okOr(
		c,
		removeOption(c.get('trip').id, c.get('user').id, c.req.param('optionId')),
		404,
		'Could not remove that stay.'
	)
);

discover.patch('/stays/:optionId/dates', async (c) => {
	const b = await body(c);
	const checkIn = optDay(b.checkIn);
	const checkOut = optDay(b.checkOut);
	if (checkIn === 'bad' || checkOut === 'bad') return fail(c, 400, 'Enter valid dates.');
	if (checkIn && checkOut && checkIn > checkOut) {
		return fail(c, 400, 'Check-out must be after check-in.');
	}
	return okOr(
		c,
		setDates(c.get('trip').id, c.get('user').id, c.req.param('optionId'), checkIn, checkOut),
		404,
		'Could not save those dates.'
	);
});
