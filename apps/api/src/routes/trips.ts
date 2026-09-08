import { Hono } from 'hono';
import { requireUser, requireMember } from '../middleware';
import { listTripsForUser, getTripForUser, createTrip } from '@trippy/server/trips';
import type { SessionUser } from '@trippy/server/auth';

type Env = { Variables: { user: SessionUser; trip: NonNullable<ReturnType<typeof getTripForUser>> } };

export const trips = new Hono<Env>();

trips.use('*', requireUser);

trips.get('/', (c) => c.json({ trips: listTripsForUser(c.get('user').id) }));

trips.post('/', async (c) => {
	const body = await c.req.json().catch(() => null);
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	if (!name) return c.json({ error: 'Name is required' }, 400);

	const id = createTrip(
		c.get('user').id,
		name,
		typeof body?.dates === 'string' ? body.dates : '',
		typeof body?.homeCurrency === 'string' ? body.homeCurrency : 'USD'
	);
	return c.json({ trip: getTripForUser(id, c.get('user').id) }, 201);
});

// getTripForUser already returns cities and memberList, so there is no separate
// members call to make here.
trips.get('/:tripId', requireMember, (c) => c.json({ trip: c.get('trip') }));
