import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, str } from '../parse';
import { fail, ok } from '../respond';
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
			return fail(c, 409, 'That person is already a member or invited.');
		default:
			// One message for a malformed address and for a member who is not the
			// organizer, so the two are not told apart by trying.
			return fail(c, 400, 'Enter a valid email address. Only the organizer can invite.');
	}
});

people.delete('/:userId', (c) => {
	if (!removeMember(c.get('trip').id, c.get('user').id, c.req.param('userId'))) {
		return fail(c, 403, 'Could not remove that member.');
	}
	return ok(c);
});
