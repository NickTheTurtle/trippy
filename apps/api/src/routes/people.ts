import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, str } from '../parse';
import { fail, ok } from '../respond';
import type { Env } from '../types';
import {
	addPerson,
	isOrganizer,
	listPeople,
	removeMember,
	renameMember,
	setMemberEmail
} from '@trippy/server/members';
import { sendMail, tripInviteMail } from '@trippy/server/mail';

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
	const trip = c.get('trip');
	const payload = await body(c);
	const name = str(payload.name);
	const email = str(payload.email);
	const result = addPerson(trip.id, c.get('user').id, name, email);

	switch (result) {
		case 'created':
			return c.json({ message: `${name} is on the trip.` });
		case 'added':
		case 'invited': {
			// Sent after the roster write, and awaited: the invitee is on the trip
			// either way, so a mail failure must not undo it, but the organizer is
			// told which of the two happened rather than being promised an email
			// that no key was configured to send.
			const sent = await sendMail(
				tripInviteMail({
					to: email,
					tripName: trip.name,
					inviterName: c.get('user').name,
					dates: trip.dates ?? null
				})
			);
			if (result === 'added') {
				return c.json({ message: `${email} was added to the trip.` });
			}
			return c.json({
				message:
					sent === 'sent'
						? `Invite emailed to ${email}. They'll join when they register.`
						: `${email} is on the trip. They'll join when they register.`
			});
		}
		case 'exists':
			return fail(c, 409, 'That person is already a member or invited.');
		case 'forbidden':
			return fail(c, 403, 'Only the organizer can add people.');
		default:
			return fail(c, 400, name ? 'Enter a valid email address.' : 'Enter a display name.');
	}
});

/**
 * Set, change, clear or re-send the address an invited person was invited at.
 *
 * Re-sending is the same call with the same address rather than a route of its
 * own, because the organizer's intent is one thing ("reach this person here")
 * and the two would otherwise differ only in whether the value happened to
 * change.
 */
people.patch('/:userId/email', async (c) => {
	const trip = c.get('trip');
	const userId = c.req.param('userId');
	const email = str((await body(c)).email);
	const result = setMemberEmail(trip.id, c.get('user').id, userId, email);

	switch (result) {
		case 'cleared':
			return c.json({ message: 'Email removed.' });
		case 'ok': {
			const sent = await sendMail(
				tripInviteMail({
					to: email,
					tripName: trip.name,
					inviterName: c.get('user').name,
					dates: trip.dates ?? null
				})
			);
			return c.json({
				message: sent === 'sent' ? `Invite emailed to ${email}.` : `Invite saved for ${email}.`
			});
		}
		case 'taken':
			return fail(c, 409, 'That person is already a member or invited.');
		case 'invalid':
			return fail(c, 400, 'Enter a valid email address.');
		default:
			// One message for "not the organizer", "not on this trip" and "that
			// person owns their own address", so none is discovered by trying another.
			return fail(c, 403, 'Could not change that email.');
	}
});

people.patch('/:userId', async (c) => {
	const name = str((await body(c)).name);
	if (!name) return fail(c, 400, 'Enter a name.');
	if (!renameMember(c.get('trip').id, c.get('user').id, c.req.param('userId'), name)) {
		// One message for "not the organizer" and for "that person owns their own
		// name", so neither is discovered by trying the other.
		return fail(c, 403, 'Could not rename that member.');
	}
	return ok(c);
});

people.delete('/:userId', (c) => {
	if (!removeMember(c.get('trip').id, c.get('user').id, c.req.param('userId'))) {
		return fail(c, 403, 'Could not remove that member.');
	}
	return ok(c);
});
