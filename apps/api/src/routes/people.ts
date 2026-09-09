import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, str } from '../parse';
import type { Env } from '../types';
import { inviteToTrip, isOrganizer, listPeople, removeMember } from '@trippy/server/members';

export const people = new Hono<Env>();

people.use('*', requireMember);

people.get('/', (c) => {
	const trip = c.get('trip');
	return c.json({
		me: c.get('user').id,
		organizer: isOrganizer(trip.id, c.get('user').id),
		// No separate pending-invite list: an invite always creates a placeholder
		// member, so it is already in `people` with its real email and an
		// `invited` tag, and removing that row deletes the invite with it. A
		// second representation of the same fact is a second thing to keep in
		// sync, and this one was never rendered by either client.
		people: listPeople(trip.id)
	});
});

people.post('/invites', async (c) => {
	const email = str((await body(c)).email);
	const result = inviteToTrip(c.get('trip').id, c.get('user').id, email);

	switch (result) {
		case 'added':
			return c.json({ message: `${email} was added to the trip.` });
		case 'invited':
			return c.json({ message: `Invite sent to ${email}. They'll join when they register.` });
		case 'exists':
			return c.json({ error: 'That person is already a member or invited.' }, 400);
		default:
			return c.json({ error: 'Enter a valid email address. Only the organizer can invite.' }, 400);
	}
});

people.delete('/:userId', (c) => {
	if (!removeMember(c.get('trip').id, c.get('user').id, c.req.param('userId'))) {
		return c.json({ error: 'Could not remove that member.' }, 400);
	}
	return c.json({ ok: true });
});
