import { Hono } from 'hono';
import { requireUser, requireMember } from '../middleware';
import { body, num, optStr, str } from '../parse';
import { fail, ok } from '../respond';
import type { Env } from '../types';
import {
	listTripsForUser,
	getTripForUser,
	createTrip,
	updateTrip,
	addCity,
	updateCity,
	removeCity,
	cityOnTrip,
	deleteTrip,
	leaveTrip,
	type CityInput
} from '@trippy/server/trips';
import { backfillTripListPhotos } from '@trippy/server/photos';
import { discover } from './discover';
import { calendar } from './calendar';
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
	await backfillTripListPhotos(userId);
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
 * Rename / re-date / re-denominate. Organizer only, which `updateTrip` enforces
 * itself and reports as a message string, so the check and the wording it
 * produces stay in one place rather than being restated here.
 */
trips.patch('/:tripId', requireMember, async (c) => {
	const b = await body(c);
	const problem = updateTrip(c.get('trip').id, c.get('user').id, {
		name: str(b.name),
		startDate: str(b.startDate),
		endDate: str(b.endDate),
		currency: str(b.currency)
	});
	if (problem) return fail(c, 400, problem);
	return c.json({ trip: getTripForUser(c.get('trip').id, c.get('user').id) });
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
 * functions, which is also where the shape of a city is validated.
 */
trips.post('/:tripId/cities', requireMember, async (c) => {
	const b = await body(c);
	const input = cityInput(b);
	// Asked separately from the add so the refusal can say which city, and why.
	if (cityOnTrip(c.get('trip').id, input))
		return fail(c, 400, `${input.name.trim()} is already on this trip.`);
	const id = addCity(c.get('trip').id, c.get('user').id, input);
	if (!id) return fail(c, 400, 'Could not add that city.');
	return c.json({ trip: getTripForUser(c.get('trip').id, c.get('user').id) }, 201);
});

trips.patch('/:tripId/cities/:cityId', requireMember, async (c) => {
	const b = await body(c);
	const input = cityInput(b);
	if (cityOnTrip(c.get('trip').id, input, c.req.param('cityId')))
		return fail(c, 400, `${input.name.trim()} is already on this trip.`);
	const okay = updateCity(c.get('trip').id, c.get('user').id, c.req.param('cityId'), input);
	if (!okay) return fail(c, 400, 'Could not save that city.');
	return c.json({ trip: getTripForUser(c.get('trip').id, c.get('user').id) });
});

trips.delete('/:tripId/cities/:cityId', requireMember, (c) => {
	// The last city cannot go: removing it would leave the trip in exactly the
	// dead-end state the add route exists to get out of.
	if (!removeCity(c.get('trip').id, c.get('user').id, c.req.param('cityId'))) {
		return fail(c, 400, 'A trip needs at least one city.');
	}
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
trips.route('/:tripId/calendar', calendar);
trips.route('/:tripId/expenses', expenses);
trips.route('/:tripId/pretrip', pretrip);
trips.route('/:tripId/people', people);

// The one exception to the line above: the event stream is authenticated here
// (by `requireUser`, at the top of this router) but authorized by `subscribe`,
// which owns membership for the life of the connection rather than for one
// request. Adding `requireMember` would be a second, staler answer to the same
// question. See routes/events.ts.
trips.route('/:tripId/events', events);
