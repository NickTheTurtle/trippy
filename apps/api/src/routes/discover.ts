import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { billingGate, photoGate, quota429, QuotaError } from '../provider-quota';
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
	removeOption,
	setDates,
	updateOption,
	vote as lodgingVote
} from '@trippy/server/lodging';
import { backfillTripPhotos } from '@trippy/server/photos';
import { ensureRatesFresh, knownCurrencies } from '@trippy/server/fx';
import { citySearchContext } from '@trippy/server/trips';
import {
	providerStatus,
	placeDetailsCached,
	searchPlaces,
	MIN_QUERY,
	type SearchKind
} from '@trippy/server/places';
import {
	amountTooLarge,
	isAmountInRange,
	isNameLength,
	isNotesLength,
	nameTooLong,
	notesTooLong,
	safeExternalUrl,
	stayNightsProblem
} from '@trippy/core/validate';
import { isCurrencyCode, unknownCurrency } from '@trippy/core/currency';
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
	// bounded number in flight) because every lookup is billed by Google. The
	// gate is the ceiling those rules do not give: a caller who adds rows faster
	// than the backlog drains would otherwise buy a Places call per row forever.
	await backfillTripPhotos(trip.id, undefined, photoGate(userId));

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
		// The provider that is actually answering, not the one configured. This
		// drives the attribution line under the search box, and attributing an
		// OSM result to Google is both wrong and a licence problem.
		provider: providerStatus().serving
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
 * The provider details a place card carries, checked before they are stored.
 *
 * These come from the search result, not from a person, which is why they were
 * taken as sent: `num()` and `String()` and straight into the row. But the
 * client is only a client, and every one of them is drawn on a card: a
 * `ratingCount` of `1e300` rendered as a number nobody can read, a
 * `priceLevel` of 40 drew forty dollar signs, and a hundred-thousand-entry
 * `hours` array was a hundred thousand lines in one row. The bounds are the
 * provider's own: Google rates 1 to 5 and prices 0 to 4, publishes seven days
 * of hours, and names a photo `places/<id>/photos/<id>`.
 */
const MAX_RATING_COUNT = 100_000_000;
const MAX_HOURS_LINES = 14;
const MAX_PHOTO_NAME = 1024;
const PHOTO_NAME_RE = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

type PoiExtras = {
	rating: number | null;
	ratingCount: number | null;
	priceLevel: number | null;
	hours: string[] | null;
	photo: string | null;
};

function poiExtras(
	b: Record<string, unknown>,
	hours: string[] | null
): PoiExtras | { error: string } {
	const bad = { error: 'Those place details do not look right. Pick the place again.' };
	const rating = num(b.rating);
	if (rating !== null && (rating < 0 || rating > 5)) return bad;
	const ratingCount = int(b.ratingCount);
	if (b.ratingCount != null && b.ratingCount !== '' && ratingCount === null) return bad;
	if (ratingCount !== null && (ratingCount < 0 || ratingCount > MAX_RATING_COUNT)) return bad;
	const priceLevel = int(b.priceLevel);
	if (b.priceLevel != null && b.priceLevel !== '' && priceLevel === null) return bad;
	if (priceLevel !== null && (priceLevel < 0 || priceLevel > 4)) return bad;
	if (hours && (hours.length > MAX_HOURS_LINES || hours.some((h) => !isNameLength(h)))) return bad;
	const photo = optStr(b.photo);
	if (photo && (photo.length > MAX_PHOTO_NAME || !PHOTO_NAME_RE.test(photo))) return bad;
	return { rating, ratingCount, priceLevel, hours, photo };
}

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
	// Checked after the join, not before: the place name is prepended here, so
	// the value the limit has to hold is the one that ends up in the column.
	if (notes && !isNotesLength(notes)) return fail(c, 400, notesTooLong());

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
	const extras = poiExtras(b, hours);
	if ('error' in extras) return fail(c, 400, extras.error);

	const category = str(b.category);
	if (!isNameLength(category)) return fail(c, 400, nameTooLong());

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
		category,
		notes,
		link.url,
		lat,
		lng,
		extras,
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

	const notes = optStr(b.notes);
	if (notes && !isNotesLength(notes)) return fail(c, 400, notesTooLong());

	const link = readLink(b.url);
	if ('error' in link) return fail(c, 400, link.error);

	return okOr(
		c,
		updatePoi(c.get('trip').id, c.get('user').id, c.req.param('poiId'), {
			name,
			notes,
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
 * The night range a stay may carry, judged by the one rule in core
 * (`stayNightsProblem`), with the words each refusal has always used here.
 *
 * Two local copies used to live in this file: an order check, and a trip-range
 * check that capped checkout at the trip's last day. The board caps it at the
 * morning after the last day instead, so the same stay was accepted on the
 * calendar and refused on the Discover card, and a check-in on the last day
 * could never be given any checkout that passed here. Both paths now ask core.
 */
function nightsProblem(trip: Trip, checkIn: string | null, checkOut: string | null): string | null {
	switch (stayNightsProblem(checkIn, checkOut, trip.start_date, trip.end_date)) {
		case 'order':
			return 'Check-out must be after check-in.';
		case 'outside':
			return 'Those nights fall outside the trip.';
		default:
			return null;
	}
}

/**
 * The currency a stay's price is in, or an error for one nothing can convert.
 * Blank is allowed and means the trip's home currency, as it always has.
 */
function stayCurrency(raw: unknown): { code: string } | { error: string } {
	const code = str(raw).toUpperCase();
	if (code && !isCurrencyCode(code)) return { error: unknownCurrency() };
	return { code };
}

/**
 * The per-night price of a stay, in whole cents.
 *
 * `priceCents` is the field to send: it is what the column holds, and an
 * integer cannot pick up a rounding error on the way in. `price`, in major
 * units, is what the current web form posts and stays supported. Absent or
 * empty is null, which is the real state "proposed but not priced yet".
 * `'bad'` means present but not a non-negative amount; `'big'` means past the
 * ceiling every other money field is held to (`isAmountInRange`), which is what
 * keeps the lodging totals, and the page that reads them, from overflowing.
 */
function stayPriceCents(b: Record<string, unknown>): number | null | 'bad' | 'big' {
	const blank = (v: unknown) => v === null || v === undefined || v === '';
	let cents: number | null = null;
	if (!blank(b.priceCents)) {
		const raw = int(b.priceCents);
		if (raw === null || raw < 0) return 'bad';
		cents = raw;
	} else if (!blank(b.price)) {
		const major = num(b.price);
		if (major === null || major < 0) return 'bad';
		cents = Math.round(major * 100);
	}
	if (cents !== null && !isAmountInRange(cents)) return 'big';
	return cents;
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

	// A stay's `tag` is its one free-text line, and the add popup calls that
	// field notes, so it answers to the same limit.
	const stayTag = str(b.tag) || str(b.notes);
	if (stayTag && !isNotesLength(stayTag)) return fail(c, 400, notesTooLong());

	const price = stayPriceCents(b);
	if (price === 'bad') return fail(c, 400, 'Enter a valid price, or leave it blank.');
	if (price === 'big') return fail(c, 400, amountTooLarge());
	const currency = stayCurrency(b.currency);
	if ('error' in currency) return fail(c, 400, currency.error);

	const checkIn = optDay(b.checkIn);
	const checkOut = optDay(b.checkOut);
	if (checkIn === 'bad' || checkOut === 'bad') return fail(c, 400, 'Pick valid dates.');
	const strayNights = nightsProblem(trip, checkIn, checkOut);
	if (strayNights) return fail(c, 400, strayNights);

	const stayLink = readLink(b.url);
	if ('error' in stayLink) return fail(c, 400, stayLink.error);

	const stayLat = num(b.lat);
	const stayLng = num(b.lng);
	const elsewhere = wrongCity(trip, str(b.cityId), stayLat, stayLng);
	if (elsewhere) return fail(c, 400, elsewhere);
	// The same shape rule a place's photo is held to (see `poiExtras`).
	const stayPhoto = optStr(b.photo);
	if (stayPhoto && (stayPhoto.length > MAX_PHOTO_NAME || !PHOTO_NAME_RE.test(stayPhoto))) {
		return fail(c, 400, 'Those place details do not look right. Pick the place again.');
	}

	const id = addOption(trip.id, c.get('user').id, str(b.cityId), name, {
		tag: stayTag,
		priceCents: price,
		// Blank: the server falls back to the trip's home currency.
		currency: currency.code,
		url: stayLink.url,
		checkIn,
		checkOut,
		photo: stayPhoto,
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
 * what ends up stored and clearing a price or a link is expressible.
 *
 * The night range is not part of it. Which nights are spent in a room is
 * settled on the calendar, where the band is drawn, so it has its own route
 * below and this one leaves the stored range exactly as it found it.
 */
discover.patch('/stays/:optionId', async (c) => {
	const b = await body(c);

	const name = str(b.name);
	if (!name) return fail(c, 400, 'Enter a name.');
	if (!isNameLength(name)) return fail(c, 400, nameTooLong());

	const editTag = str(b.tag) || str(b.notes);
	if (editTag && !isNotesLength(editTag)) return fail(c, 400, notesTooLong());

	const price = stayPriceCents(b);
	if (price === 'bad') return fail(c, 400, 'Enter a valid price, or leave it blank.');
	if (price === 'big') return fail(c, 400, amountTooLarge());
	const editCurrency = stayCurrency(b.currency);
	if ('error' in editCurrency) return fail(c, 400, editCurrency.error);

	const editLink = readLink(b.url);
	if ('error' in editLink) return fail(c, 400, editLink.error);

	return okOr(
		c,
		updateOption(c.get('trip').id, c.get('user').id, c.req.param('optionId'), {
			name,
			tag: str(b.tag) || str(b.notes),
			priceCents: price,
			currency: editCurrency.code,
			url: editLink.url
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
	const dateStrays = nightsProblem(c.get('trip'), checkIn, checkOut);
	if (dateStrays) return fail(c, 400, dateStrays);
	return okOr(
		c,
		setDates(c.get('trip').id, c.get('user').id, c.req.param('optionId'), checkIn, checkOut),
		404,
		goneMessage('stay')
	);
});
