import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, str } from '../parse';
import type { Env } from '../types';
import {
	inviteToTrip,
	isOrganizer,
	listPeople,
	listPendingInvites,
	removeMember,
	revokeInvite
} from '@trippy/server/members';

export const people = new Hono<Env>();

people.use('*', requireMember);

people.get('/', (c) => {
	const trip = c.get('trip');
	const organizer = isOrganizer(trip.id, c.get('user').id);
	return c.json({
		me: c.get('user').id,
		organizer,
		people: listPeople(trip.id),
		// Pending invites are addresses of people who are not members yet, so only
		// the organizer who sent them gets to see the list.
		invites: organizer ? listPendingInvites(trip.id) : []
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

people.delete('/invites/:inviteId', (c) => {
	revokeInvite(c.get('trip').id, c.get('user').id, c.req.param('inviteId'));
	return c.json({ ok: true });
});

people.delete('/:userId', (c) => {
	if (!removeMember(c.get('trip').id, c.get('user').id, c.req.param('userId'))) {
		return c.json({ error: 'Could not remove that member.' }, 400);
	}
	return c.json({ ok: true });
});
