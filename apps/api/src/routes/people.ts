import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, str, strList } from '../parse';
import { fail, goneMessage, ok, okOr } from '../respond';
import type { Env } from '../types';
import {
	addPerson,
	isOrganizer,
	listPeople,
	removeMember,
	renameMember,
	setMemberEmail
} from '@trippy/server/members';
import { createCrew, crewsForTrip, deleteCrew, editCrew } from '@trippy/server/schedule';
import { isNameLength, nameTooLong } from '@trippy/core/validate';

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
		people: listPeople(trip.id),
		// A crew is a saved group of members, so it is served beside the roster it
		// is drawn from. The schedule reads crews too, but only to fill its people
		// picker; nothing about a crew belongs to a day.
		crews: crewsForTrip(trip.id)
	});
});

// --- Crews ------------------------------------------------------------------
//
// Registered before the `/:userId` routes below so that "crews" is never read
// as a member id.

people.post('/crews', async (c) => {
	const b = await body(c);
	const name = str(b.name);
	if (!name) return fail(c, 400, 'Enter a name.');
	const id = createCrew(c.get('trip').id, c.get('user').id, name, strList(b.people));
	if (!id) return fail(c, 403, 'Not allowed');
	return c.json({ id }, 201);
});

people.patch('/crews/:crewId', async (c) => {
	const b = await body(c);
	const name = str(b.name);
	if (b.name !== undefined && !name) return fail(c, 400, 'Enter a name.');
	return okOr(
		c,
		editCrew(
			c.req.param('crewId'),
			c.get('trip').id,
			c.get('user').id,
			name || undefined,
			b.people === undefined ? undefined : strList(b.people)
		),
		404,
		goneMessage('crew')
	);
});

people.delete('/crews/:crewId', (c) =>
	okOr(
		c,
		deleteCrew(c.req.param('crewId'), c.get('trip').id, c.get('user').id),
		404,
		goneMessage('crew')
	)
);

people.post('/invites', async (c) => {
	const payload = await body(c);
	const name = str(payload.name);
	const email = str(payload.email);
	if (name && !isNameLength(name)) return fail(c, 400, nameTooLong());
	const result = addPerson(c.get('trip').id, c.get('user').id, name, email);

	switch (result) {
		case 'created':
			return c.json({ message: `${name} is on the trip.` });
		case 'added':
			return c.json({ message: `${email} is on the trip.` });
		case 'invited':
			// Nothing is emailed. The address is kept so that whoever registers at
			// it later is linked to this person rather than arriving as a stranger,
			// which is the whole of what it is for, so the message promises only
			// that.
			return c.json({ message: `${email} is on the trip. They'll join when they register.` });
		case 'exists':
			return fail(c, 409, 'That person is already a member or invited.');
		case 'forbidden':
			return fail(c, 403, 'Only the organizer can add people.');
		default:
			return fail(c, 400, name ? 'Enter a valid email address.' : 'Enter a display name.');
	}
});

/**
 * Set, change or clear the address an invited person will be recognised by.
 *
 * Nobody is emailed. The address is what `consumeInvites` matches a new
 * registration against, so editing it is editing who this person will turn out
 * to be.
 */
people.patch('/:userId/email', async (c) => {
	const userId = c.req.param('userId');
	const email = str((await body(c)).email);
	const result = setMemberEmail(c.get('trip').id, c.get('user').id, userId, email);

	switch (result) {
		case 'cleared':
			return c.json({ message: 'Email removed.' });
		case 'ok':
			return c.json({ message: "Saved. They'll join when they register." });
		case 'merged':
			// They already had an account, so nothing is waiting on a registration:
			// the placeholder's expenses, votes and assignments moved to them and
			// the roster now shows their own name.
			return c.json({ message: `${email} is on the trip.` });
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
	if (!name) return fail(c, 400, 'Enter a display name.');
	// Same limit as every other name, for the same reason and one of its own: a
	// display name is drawn in the header, in the account menu and against every
	// row the person touched, and a 500 character one with no space in it has
	// nothing to wrap on. It pushed the page out to 4454px on a 390px screen.
	if (!isNameLength(name)) return fail(c, 400, nameTooLong());
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
