import { Hono } from 'hono';
import { requireUser, requireMember } from '../middleware';
import { body, optStr, str } from '../parse';
import type { Env } from '../types';
import { listTripsForUser, getTripForUser, createTrip, updateTrip } from '@trippy/server/trips';
import { discover } from './discover';
import { calendar } from './calendar';
import { expenses } from './expenses';
import { pretrip } from './pretrip';
import { people } from './people';

export const trips = new Hono<Env>();

trips.use('*', requireUser);

trips.get('/', (c) => c.json({ trips: listTripsForUser(c.get('user').id) }));

trips.post('/', async (c) => {
	const b = await body(c);
	const name = str(b.name);
	if (!name) return c.json({ error: 'Name is required' }, 400);

	const id = createTrip(c.get('user').id, name, str(b.dates), str(b.homeCurrency) || 'USD');
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
		startDate: optStr(b.startDate),
		endDate: optStr(b.endDate),
		currency: str(b.currency)
	});
	if (problem) return c.json({ error: problem }, 400);
	return c.json({ trip: getTripForUser(c.get('trip').id, c.get('user').id) });
});

// Each section router applies `requireMember` itself, so membership is checked
// exactly once per request whichever path reaches it.
trips.route('/:tripId/discover', discover);
trips.route('/:tripId/calendar', calendar);
trips.route('/:tripId/expenses', expenses);
trips.route('/:tripId/pretrip', pretrip);
trips.route('/:tripId/people', people);
