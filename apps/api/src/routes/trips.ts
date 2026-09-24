import { Hono, type Context } from 'hono';
import { requireUser, requireMember } from '../middleware';
import { body, bool, num, optStr, str } from '../parse';
import { fail, goneMessage, ok } from '../respond';
import type { Env } from '../types';
import {
	listTripsForUser,
	getTripForUser,
	createTrip,
	updateTrip,
	addCityResult,
	updateCityResult,
	removeCityResult,
	deleteTrip,
	leaveTrip,
	type CityInput,
	type CityRefusal
} from '@trippy/server/trips';
import { backfillTripListPhotos } from '@trippy/server/photos';
import { photoGate } from '../provider-quota';
import { discover } from './discover';
import { schedule } from './schedule';
import { expenses } from './expenses';
import { pretrip } from './pretrip';
import { people } from './people';
import { events } from './events';

export const trips = new Hono<Env>();

trips.use('*', requireUser);

/**
 * The trip list, with a cover photo found for any trip whose first city has
 * never had one looked up. The helper owns how much of that backlog a single
 * request is allowed to pay Google for; each city costs at most one lookup ever,
 * so this settles down to nothing. Failures are swallowed: the card falls back
 * to its gradient.
 */
trips.get('/', async (c) => {
	const userId = c.get('user').id;
	await backfillTripListPhotos(userId, undefined, photoGate(userId));
	return c.json({ trips: listTripsForUser(userId) });
});

trips.post('/', async (c) => {
	const b = await body(c);
	const { id, error } = createTrip(c.get('user').id, {
		name: str(b.name),
		startDate: str(b.startDate),
		endDate: str(b.endDate),
		homeCurrency: str(b.homeCurrency) || 'USD'
	});
	if (error !== null) return fail(c, 400, error);
	return c.json({ trip: getTripForUser(id, c.get('user').id) }, 201);
});

// getTripForUser already returns cities and memberList, so there is no separate
// members call to make here.
trips.get('/:tripId', requireMember, (c) => c.json({ trip: c.get('trip') }));

/**
 * What a member who is not the organizer is told, per action. A 403 in the
 * `respond.ts` sense: the caller is on the trip, so there is nothing to hide,
 * only a permission they do not have. These used to come back as 400 with
 * sentences like "Could not add that city.", which read as a problem with the
 * values and sent members hunting for a typo that was not there.
 */
const NOT_ORGANIZER = {
	edit: 'Only the organizer can edit this trip.',
	cities: 'Only the organizer can change the cities on this trip.'
};

/**
 * Rename / re-date / re-denominate. Organizer only, which `updateTrip` also
 * enforces; the role is checked here first so the refusal can be a 403 rather
 * than a 400 that reads like a bad value.
 *
 * `scheduleLocked` is optional. Absent keeps the stored lock: it used to be
 * read as `=== true`, so any edit that did not restate it unfroze the board.
 */
trips.patch('/:tripId', requireMember, async (c) => {
	const trip = c.get('trip');
	if (trip.role !== 'organizer') return fail(c, 403, NOT_ORGANIZER.edit);
	const b = await body(c);
	const problem = updateTrip(trip.id, c.get('user').id, {
		name: str(b.name),
		startDate: str(b.startDate),
		endDate: str(b.endDate),
		currency: str(b.currency),
		scheduleLocked: bool(b.scheduleLocked) ?? undefined
	});
	if (problem) return fail(c, 400, problem);
	return c.json({ trip: getTripForUser(trip.id, c.get('user').id) });
});

/**
 * Delete the whole trip, organizer only, and leave it, everyone else only.
 *
 * Two routes rather than one that branches on role: they destroy different
 * amounts of data and a member must never be one permission check away from
 * wiping the group's trip. Both refusals are 403 with the other option named,
 * since the caller is a member either way and there is nothing to hide.
 */
trips.delete('/:tripId', requireMember, (c) => {
	if (!deleteTrip(c.get('trip').id, c.get('user').id)) {
		return fail(c, 403, 'Only the organizer can delete this trip. You can leave it instead.');
	}
	return ok(c);
});

trips.post('/:tripId/leave', requireMember, (c) => {
	if (!leaveTrip(c.get('trip').id, c.get('user').id)) {
		return fail(c, 403, 'The organizer cannot leave a trip. Delete it instead.');
	}
	return ok(c);
});

/**
 * Itinerary. A trip's cities are what every other section is scoped to, so a
 * trip without one is a dead end: `POST` is what turns a freshly created trip
 * into a usable one. All three are organizer-only, enforced inside the server
 * functions, which is also where the shape of a city is validated. Each
 * refusal carries its reason, so a member is told 403 (not the organizer), a
 * vanished city 404, and a bad value 400.
 */
function cityRefusal(c: Context<Env>, reason: CityRefusal, input?: CityInput) {
	switch (reason) {
		case 'forbidden':
			return fail(c, 403, NOT_ORGANIZER.cities);
		case 'missing':
			return fail(c, 404, goneMessage('city'));
		case 'duplicate':
			return fail(c, 400, `${input?.name.trim() ?? 'That city'} is already on this trip.`);
		case 'last':
			return fail(c, 400, 'A trip needs at least one city.');
		default:
			return fail(c, 400, 'Enter a city name, a country and a time zone from the list.');
	}
}

trips.post('/:tripId/cities', requireMember, async (c) => {
	const b = await body(c);
	const input = cityInput(b);
	const res = addCityResult(c.get('trip').id, c.get('user').id, input);
	if (!res.ok) return cityRefusal(c, res.reason, input);
	return c.json({ trip: getTripForUser(c.get('trip').id, c.get('user').id) }, 201);
});

trips.patch('/:tripId/cities/:cityId', requireMember, async (c) => {
	const b = await body(c);
	const input = cityInput(b);
	const res = updateCityResult(c.get('trip').id, c.get('user').id, c.req.param('cityId'), input);
	if (!res.ok) return cityRefusal(c, res.reason, input);
	return c.json({ trip: getTripForUser(c.get('trip').id, c.get('user').id) });
});

trips.delete('/:tripId/cities/:cityId', requireMember, (c) => {
	// The last city cannot go: removing it would leave the trip in exactly the
	// dead-end state the add route exists to get out of.
	const res = removeCityResult(c.get('trip').id, c.get('user').id, c.req.param('cityId'));
	if (!res.ok) return cityRefusal(c, res.reason);
	return c.json({ trip: getTripForUser(c.get('trip').id, c.get('user').id) });
});

/**
 * The six fields a city carries. The region and the coordinates are optional:
 * a city added by hand may have neither, some places genuinely have no region
 * at all, and `num` reads a numeric string as well as a number, so a client
 * posting form-style values keeps its pin. `optStr` turns a missing or blank
 * region into null, so the literal string 'undefined' can never be stored.
 */
function cityInput(b: Record<string, unknown>): CityInput {
	return {
		name: str(b.name),
		country: str(b.country),
		region: optStr(b.region),
		tz: str(b.tz),
		lat: num(b.lat),
		lng: num(b.lng)
	};
}

// Each section router applies `requireMember` itself, so membership is checked
// exactly once per request whichever path reaches it.
trips.route('/:tripId/discover', discover);
trips.route('/:tripId/schedule', schedule);
trips.route('/:tripId/expenses', expenses);
trips.route('/:tripId/pretrip', pretrip);
trips.route('/:tripId/people', people);

// The one exception to the line above: the event stream is authenticated here
// (by `requireUser`, at the top of this router) but authorized by `subscribe`,
// which owns membership for the life of the connection rather than for one
// request. Adding `requireMember` would be a second, staler answer to the same
// question. See routes/events.ts.
trips.route('/:tripId/events', events);
