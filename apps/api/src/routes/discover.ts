import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { billingGate, quota429, QuotaError } from '../provider-quota';
import { body, int, isoDay, num, optStr, str } from '../parse';
import { fail, goneMessage, okOr } from '../respond';
import type { Env, Trip } from '../types';
import {
	addPoi,
	cityPois,
	poiTitleExists,
	removePoi,
	toggleVote,
	updatePoi
} from '@trippy/server/pois';
import {
	addOption,
	cityLodging,
	lockOption,
	removeOption,
	setDates,
	updateOption,
	vote as lodgingVote
} from '@trippy/server/lodging';
import { backfillTripPhotos } from '@trippy/server/photos';
import { ensureRatesFresh, knownCurrencies } from '@trippy/server/fx';
import { citySearchContext } from '@trippy/server/trips';
import {
	activeProvider,
	placeDetailsCached,
	searchPlaces,
	MIN_QUERY,
	type SearchKind
} from '@trippy/server/places';
import { isNameLength, nameTooLong, safeExternalUrl } from '@trippy/core/validate';
import { haversineKm } from '@trippy/core/geo';

export const discover = new Hono<Env>();

discover.use('*', requireMember);

/**
 * The link a place or stay carries, normalised, or an error when it is not a
 * link at all.
 *
 * Every write site shares this because the field is rendered straight into an
 * `href`: `javascript:alert(1)` used to be stored and drawn as a real link, and
 * a bare `banana` resolved against the app's own origin into a dead internal
 * one. Blank stays blank; the field is optional.
 */
function readLink(raw: unknown): { url: string | null } | { error: string } {
	const text = optStr(raw);
	if (!text) return { url: null };
	const safe = safeExternalUrl(text);
	return safe ? { url: safe } : { error: 'Enter a web address starting with http:// or https://.' };
}

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
	// A stay's price can be typed in any currency, so the popup needs the list.
	ensureRatesFresh();
	return c.json({
		cities: cityPois(trip.id, userId),
		stays: Object.fromEntries(stays.map((s) => [s.id, s.options])),
		currency: trip.home_currency,
		currencies: knownCurrencies().sort(),
		memberCount: trip.members.length,
		isOrganizer: trip.role === 'organizer',
		provider: activeProvider()
	});
});

// --- Search -----------------------------------------------------------------

/**
 * The token that ties one member's typing to the place they finally pick.
 *
 * Client-generated, so it is checked rather than trusted: it ends up in a
 * request to Google, and "whatever the caller sent" is not something to paste
 * into an outbound URL. A UUID passes; anything else is dropped, which costs
 * the session its free suggestions but cannot do any harm.
 */
function sessionToken(raw: string | undefined): string | undefined {
	const t = raw?.trim() ?? '';
	return /^[A-Za-z0-9-]{8,64}$/.test(t) ? t : undefined;
}

discover.get('/search', async (c) => {
	const trip = c.get('trip');
	const q = c.req.query('q')?.trim() ?? '';
	const kind: SearchKind = c.req.query('kind') === 'stay' ? 'stay' : 'place';

	// Short queries are not a client error, they are a query still being typed.
	if (q.length < MIN_QUERY) return c.json({ results: [] });

	// The city bias for the search, resolved only if the city is this trip's, so
	// an id from another trip cannot steer where we look.
	const city = citySearchContext(trip.id, c.req.query('cityId') ?? '');
	if (!city) return fail(c, 400, 'Could not find that city.');

	try {
		return c.json({
			results: await searchPlaces(
				q,
				{
					city: city.name,
					country: city.country,
					region: city.region,
					lat: city.lat,
					lng: city.lng
				},
				kind,
				sessionToken(c.req.query('token')),
				// Charged only when this search misses the cache and actually reaches
				// a provider; a repeat search served from cache spends no quota.
				billingGate(c, c.get('user').id)
			)
		});
	} catch (err) {
		return quota429(c, err);
	}
});

/**
 * The expensive half of the split search: ratings, price, hours, website and
 * photo for the one place a member has actually clicked. Kept off the search
 * endpoint so typing never buys this for eight results at once. Membership is
 * enforced (by the router-wide guard) even though the data is public, because
 * this endpoint spends our API quota and must not be an open proxy to Google.
 *
 * Sending the token the suggestions were made under closes that session, which
 * is what makes them free.
 */
discover.get('/details', async (c) => {
	const id = c.req.query('id')?.trim() ?? '';
	if (!id) return fail(c, 400, 'Missing id.');
	try {
		return c.json({
			details: await placeDetailsCached(
				id,
				sessionToken(c.req.query('token')),
				billingGate(c, c.get('user').id)
			)
		});
	} catch (err) {
		// Over quota is a real refusal and must reach the caller as a 429; a
		// cached hit never gets here because the gate only runs on a miss.
		if (err instanceof QuotaError) return quota429(c, err);
		// Any other failed enrichment is not a failed search; the caller still has
		// the name, address and pin, so let it show the result without the extras.
		return c.json({ details: null });
	}
});

// --- Places -----------------------------------------------------------------

/**
 * How far from a city's centre a place may still be filed under that city.
 *
 * Generous on purpose. A city list is a list of places to go *from* a city, and
 * that legitimately includes the day trip an hour out of town and the airport
 * that is nowhere near the middle. What it is meant to catch is the search that
 * was still showing Lisbon results when the city dropdown had already moved to
 * Porto: those land hundreds of kilometres out, not eighty.
 */
const CITY_RADIUS_KM = 150;

/**
 * Why this place does not belong to this city, or null when it might.
 *
 * Returns null whenever it cannot know: a city the geocoder never placed, or a
 * place typed by hand with no coordinates. Refusing on a guess would block
 * perfectly good entries, and the only thing worth refusing here is the clearly
 * wrong one.
 */
function wrongCity(
	trip: Trip,
	cityId: string,
	lat: number | null,
	lng: number | null
): string | null {
	if (lat === null || lng === null) return null;
	const city = trip.cities.find((x) => x.id === cityId);
	if (!city || city.lat === null || city.lng === null) return null;
	if (haversineKm(lat, lng, city.lat, city.lng) <= CITY_RADIUS_KM) return null;
	return `That place is not near ${city.name}. Switch the city first, or pick a closer result.`;
}

discover.post('/pois', async (c) => {
	const trip = c.get('trip');
	const b = await body(c);

	const cityId = str(b.cityId);
	const placeName = str(b.name);
	// Optional activity label: "Sunset photos" at "Acropolis". When given it
	// becomes the card title and the place name is kept as context in the notes.
	const activity = str(b.activity);
	if (!placeName && !activity) return fail(c, 400, 'Enter a name.');

	const name = activity || placeName;
	if (!isNameLength(name)) return fail(c, 400, nameTooLong());
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

	const link = readLink(b.url);
	if ('error' in link) return fail(c, 400, link.error);

	const lat = num(b.lat);
	const lng = num(b.lng);
	const misfiled = wrongCity(trip, cityId, lat, lng);
	if (misfiled) return fail(c, 400, misfiled);

	const id = addPoi(
		trip.id,
		c.get('user').id,
		cityId,
		name,
		str(b.category),
		notes,
		link.url,
		lat,
		lng,
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
	if (!id) return fail(c, 400, 'Could not add that location.');
	return c.json({ id }, 201);
});

discover.patch('/pois/:poiId', async (c) => {
	const b = await body(c);
	const name = str(b.name);
	if (!name) return fail(c, 400, 'Enter a name.');
	if (!isNameLength(name)) return fail(c, 400, nameTooLong());

	const link = readLink(b.url);
	if ('error' in link) return fail(c, 400, link.error);

	return okOr(
		c,
		updatePoi(c.get('trip').id, c.get('user').id, c.req.param('poiId'), {
			name,
			notes: optStr(b.notes),
			url: link.url,
			// Patch semantics: only forwarded when the client actually sent it.
			// Defaulting it here would reclassify a food location as an attraction
			// every time someone renamed one.
			kind: b.kind === undefined ? undefined : optStr(b.kind)
		}),
		404,
		goneMessage('location')
	);
});

discover.delete('/pois/:poiId', (c) =>
	okOr(
		c,
		removePoi(c.get('trip').id, c.get('user').id, c.req.param('poiId')),
		404,
		goneMessage('location')
	)
);

// A toggle, so POST rather than PUT: the same request twice is a vote and then
// an un-vote, which is the intended behaviour and not idempotent.
discover.post('/pois/:poiId/vote', (c) =>
	okOr(
		c,
		toggleVote(c.get('trip').id, c.get('user').id, c.req.param('poiId')),
		404,
		goneMessage('location')
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
 * A stay covers at least one night, so a checkout on or before the check-in day
 * is refused. "After" is strict: an equal pair is a zero-night stay and a
 * reversed pair is negative, and neither is something a traveller can mean. This
 * mirrors the schedule stay path and the guard in `setDates`, so the same trip
 * cannot hold a stay one path would have rejected. Only meaningful once both
 * ends are set; a half-filled range is undated rather than invalid.
 */
function checkoutNotAfterCheckIn(checkIn: string | null, checkOut: string | null): boolean {
	return !!checkIn && !!checkOut && checkIn >= checkOut;
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
 * later from the stay's own editor, so it is not asked for here. The currency
 * is asked for beside the price, and falls back to the trip's home currency.
 */
discover.post('/stays', async (c) => {
	const trip = c.get('trip');
	const b = await body(c);

	const name = str(b.name);
	if (!name) return fail(c, 400, 'Enter a name.');
	if (!isNameLength(name)) return fail(c, 400, nameTooLong());

	const price = stayPriceCents(b);
	if (price === 'bad') return fail(c, 400, 'Enter a valid price, or leave it blank.');

	const checkIn = optDay(b.checkIn);
	const checkOut = optDay(b.checkOut);
	if (checkIn === 'bad' || checkOut === 'bad') return fail(c, 400, 'Pick valid dates.');
	if (checkoutNotAfterCheckIn(checkIn, checkOut)) {
		return fail(c, 400, 'Check-out must be after check-in.');
	}

	const stayLink = readLink(b.url);
	if ('error' in stayLink) return fail(c, 400, stayLink.error);

	const stayLat = num(b.lat);
	const stayLng = num(b.lng);
	const elsewhere = wrongCity(trip, str(b.cityId), stayLat, stayLng);
	if (elsewhere) return fail(c, 400, elsewhere);

	const id = addOption(trip.id, c.get('user').id, str(b.cityId), name, {
		// `notes` is the field name the add popup uses for the one free-text line
		// a stay carries; the column has always been called `tag`.
		tag: str(b.tag) || str(b.notes),
		priceCents: price,
		// Blank: the server falls back to the trip's home currency.
		currency: str(b.currency),
		url: stayLink.url,
		checkIn,
		checkOut,
		photo: optStr(b.photo),
		// Kept so the stay can be booked onto the calendar and the morning's first
		// journey has somewhere to start from. Null for a stay typed by hand.
		lat: stayLat,
		lng: stayLng
	});
	if (!id) return fail(c, 400, 'Could not add that stay.');
	return c.json({ id }, 201);
});

discover.post('/stays/:optionId/vote', (c) =>
	okOr(
		c,
		lodgingVote(c.get('trip').id, c.get('user').id, c.req.param('optionId')),
		404,
		goneMessage('stay')
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
		goneMessage('stay')
	)
);

/**
 * Edit a proposed stay: everything a proposer typed, in one write.
 *
 * A full replace rather than a patch of named fields, so the dialog's state is
 * what ends up stored and clearing a price or a link is expressible. The
 * narrower `/dates` route below predates this one and stays: the calendar
 * moves a stay's nights without opening the editor.
 */
discover.patch('/stays/:optionId', async (c) => {
	const b = await body(c);

	const name = str(b.name);
	if (!name) return fail(c, 400, 'Enter a name.');
	if (!isNameLength(name)) return fail(c, 400, nameTooLong());

	const price = stayPriceCents(b);
	if (price === 'bad') return fail(c, 400, 'Enter a valid price, or leave it blank.');

	const checkIn = optDay(b.checkIn);
	const checkOut = optDay(b.checkOut);
	if (checkIn === 'bad' || checkOut === 'bad') return fail(c, 400, 'Pick valid dates.');
	if (checkoutNotAfterCheckIn(checkIn, checkOut)) {
		return fail(c, 400, 'Check-out must be after check-in.');
	}

	const editLink = readLink(b.url);
	if ('error' in editLink) return fail(c, 400, editLink.error);

	return okOr(
		c,
		updateOption(c.get('trip').id, c.get('user').id, c.req.param('optionId'), {
			name,
			tag: str(b.tag) || str(b.notes),
			priceCents: price,
			currency: str(b.currency),
			url: editLink.url,
			checkIn,
			checkOut
		}),
		404,
		goneMessage('stay')
	);
});

discover.patch('/stays/:optionId/dates', async (c) => {
	const b = await body(c);
	const checkIn = optDay(b.checkIn);
	const checkOut = optDay(b.checkOut);
	if (checkIn === 'bad' || checkOut === 'bad') return fail(c, 400, 'Pick valid dates.');
	if (checkoutNotAfterCheckIn(checkIn, checkOut)) {
		return fail(c, 400, 'Check-out must be after check-in.');
	}
	return okOr(
		c,
		setDates(c.get('trip').id, c.get('user').id, c.req.param('optionId'), checkIn, checkOut),
		404,
		goneMessage('stay')
	);
});
