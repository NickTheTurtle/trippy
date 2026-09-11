import { randomUUID } from 'node:crypto';
import { isValidEmail } from '@trippy/core';
import { db } from '../db';
import { publish, publishMany } from '../events';
import { detachMemberFromLedger } from './expenses';

export interface Person {
	id: string;
	name: string;
	email: string;
	role: string;
	seeded: boolean;
	placeholder: boolean;
	invitedEmail?: string | null;
}

function membership(tripId: string, userId: string): { role: string } | undefined {
	return db
		.prepare(`SELECT role FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.get(tripId, userId) as { role: string } | undefined;
}

export function isOrganizer(tripId: string, userId: string): boolean {
	return membership(tripId, userId)?.role === 'organizer';
}

export function listPeople(tripId: string): Person[] {
	const rows = db
		.prepare(
			`SELECT u.id, u.name, u.email, m.role, u.password_hash,
			        (SELECT ti.email FROM trip_invites ti
			         WHERE ti.placeholder_id = u.id AND ti.trip_id = m.trip_id LIMIT 1) AS invited_email
			 FROM memberships m JOIN users u ON u.id = m.user_id
			 WHERE m.trip_id = ? ORDER BY m.role DESC, u.name`
		)
		.all(tripId) as unknown as {
		id: string;
		name: string;
		email: string;
		role: string;
		password_hash: string;
		invited_email: string | null;
	}[];
	return rows.map((r) => {
		const placeholder = r.password_hash.startsWith('placeholder:');
		return {
			id: r.id,
			name: r.name,
			// A placeholder shows the address it was invited at, and nothing at all
			// when it has none: its `users.email` is a synthetic value that exists
			// only to satisfy the UNIQUE index and means nothing to a reader.
			email: placeholder ? (r.invited_email ?? '') : r.email,
			role: r.role,
			// Seeded companions cannot log in; their hash is prefixed with "seed:".
			seeded: r.password_hash.startsWith('seed:'),
			placeholder,
			invitedEmail: r.invited_email
		};
	});
}

export type InviteResult = 'added' | 'invited' | 'created' | 'exists' | 'invalid' | 'forbidden';

/**
 * Put a person on a trip, by display name, with an email address optionally.
 *
 * Three outcomes, because there are three kinds of person the organizer can be
 * naming:
 *
 *  - **`added`** is somebody who already has an account. Their name comes from
 *    that account and the one typed here is discarded: a name shared across
 *    every trip they are on is not the organizer's to set.
 *  - **`invited`** is an address with no account behind it. A placeholder
 *    member is created so they are visible on the roster at once, and a
 *    `trip_invites` row waits for them to register.
 *  - **`created`** is a name with no address at all: somebody who is coming but
 *    is not going to use the app. They can be split with, assigned to and
 *    settled up with like anyone else, and an address can be added later.
 *
 * The email used to be the whole of an invite, which meant the roster was
 * populated with names guessed from the local part of an address ("Jamie Lee"
 * out of jamie.lee@) and anybody without an address could not be represented at
 * all, even though the money almost always involves one.
 */
export function addPerson(
	tripId: string,
	actorId: string,
	name: string,
	email: string
): InviteResult {
	if (!isOrganizer(tripId, actorId)) return 'forbidden';
	const cleanName = name.trim();
	if (!cleanName || cleanName.length > 80) return 'invalid';
	const clean = email.trim().toLowerCase();
	if (clean && !isValidEmail(clean)) return 'invalid';

	if (clean) {
		const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get(clean) as
			| { id: string }
			| undefined;
		if (user) {
			if (membership(tripId, user.id)) return 'exists';
			db.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'member')`).run(
				tripId,
				user.id
			);
			publish(tripId, 'members');
			return 'added';
		}
		const already = db
			.prepare(`SELECT 1 FROM trip_invites WHERE trip_id = ? AND email = ?`)
			.get(tripId, clean);
		if (already) return 'exists';
	}

	// Create a placeholder member so the person is visible on the trip right away.
	// The placeholder has a synthetic address (a real email is UNIQUE and must stay
	// free for when they register); its hash is prefixed "placeholder:" so it cannot
	// log in and is easy to detect. consumeInvites() relinks it on registration.
	//
	// The writes are one unit: a failure partway through would otherwise
	// leave a placeholder user with no invite (a ghost member nobody can revoke)
	// or an invite pointing at a member that was never created.
	const placeholderId = randomUUID();
	db.exec('BEGIN');
	try {
		db.prepare(
			`INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`
		).run(
			placeholderId,
			cleanName,
			`placeholder-${placeholderId}@waypoint.invalid`,
			`placeholder:${clean}`,
			Date.now()
		);
		db.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'member')`).run(
			tripId,
			placeholderId
		);
		if (clean) {
			db.prepare(
				`INSERT INTO trip_invites (id, trip_id, email, invited_by, placeholder_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			).run(randomUUID(), tripId, clean, actorId, placeholderId, Date.now());
		}
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	// After COMMIT: an invalidation that names a change readers cannot see yet
	// would send every client to refetch the old roster and never correct itself.
	publish(tripId, 'members');
	return clean ? 'invited' : 'created';
}

export type EmailEditResult = 'ok' | 'cleared' | 'taken' | 'invalid' | 'forbidden' | 'missing';

/**
 * Set, change or clear the address an invited person was invited at. Organizers
 * only, and only on a placeholder.
 *
 * Only a placeholder, because for anybody else the address is their own
 * account's: it is how they sign in, and it is shared with every other trip
 * they are on. A seeded sample companion is excluded for the opposite reason,
 * that it is not a person at all.
 *
 * The address lives in two places, `trip_invites.email` (what the invite is
 * addressed to) and the `placeholder:<email>` hash (what `consumeInvites` and
 * `removeMember` read), so both move together or the invite becomes unrevocable
 * or unconsumable.
 */
export function setMemberEmail(
	tripId: string,
	actorId: string,
	userId: string,
	email: string
): EmailEditResult {
	if (!isOrganizer(tripId, actorId)) return 'forbidden';
	if (!membership(tripId, userId)) return 'missing';
	const user = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(userId) as
		| { password_hash: string }
		| undefined;
	if (!user?.password_hash.startsWith('placeholder:')) return 'forbidden';

	const clean = email.trim().toLowerCase();
	const previous = user.password_hash.slice('placeholder:'.length);
	if (clean && !isValidEmail(clean)) return 'invalid';

	if (clean && clean !== previous) {
		// An address with an account behind it cannot be attached to a placeholder:
		// the two would be one person with two rows, and the ledger has no way to
		// say which of them owes what. The organizer removes the placeholder and
		// adds the real person, which merges nothing and loses nothing.
		if (db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(clean)) return 'taken';
		// UNIQUE (trip_id, email) would reject this anyway; catching it here says
		// which of the two things went wrong.
		if (db.prepare(`SELECT 1 FROM trip_invites WHERE trip_id = ? AND email = ?`).get(tripId, clean))
			return 'taken';
	}

	db.exec('BEGIN');
	try {
		db.prepare(`DELETE FROM trip_invites WHERE trip_id = ? AND placeholder_id = ?`).run(
			tripId,
			userId
		);
		if (clean) {
			db.prepare(
				`INSERT INTO trip_invites (id, trip_id, email, invited_by, placeholder_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			).run(randomUUID(), tripId, clean, actorId, userId, Date.now());
		}
		db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(
			`placeholder:${clean}`,
			userId
		);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	publish(tripId, 'members');
	return clean ? 'ok' : 'cleared';
}




/**
 * Rename a member of the trip. Organizers only.
 *
 * Only people who cannot log in can be renamed here: an invited placeholder,
 * whose name the app invented from their email address, and a seeded sample
 * companion. A registered member's name is their own account's, shared with
 * every other trip they are on, so it is theirs to change in Account and not
 * the organizer's to change from here.
 */
export function renameMember(
	tripId: string,
	actorId: string,
	userId: string,
	name: string
): boolean {
	if (!isOrganizer(tripId, actorId)) return false;
	if (!membership(tripId, userId)) return false;
	const clean = name.trim();
	if (!clean || clean.length > 80) return false;

	const user = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(userId) as
		{ password_hash: string } | undefined;
	if (!user) return false;
	const editable =
		user.password_hash.startsWith('placeholder:') || user.password_hash.startsWith('seed:');
	if (!editable) return false;

	db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(clean, userId);
	// The name is on rows all over the trip: expenses name their payer, tasks and
	// estimates name who they are for, and the header draws initials.
	publishMany(tripId, ['members', 'expenses', 'schedule', 'pois', 'lodging', 'tasks', 'costs']);
	return true;
}

/**
 * Does this person appear anywhere in the trip's money?
 *
 * Either as the payer of an expense or as somebody charged a share of one.
 * Votes, assignments and completions deliberately do not count: those can be
 * recast or reassigned, whereas a ledger entry is a record of what was agreed.
 */
function inLedger(tripId: string, userId: string): boolean {
	const row = db
		.prepare(
			`SELECT EXISTS (
			   SELECT 1 FROM expenses WHERE trip_id = ? AND payer_id = ?
			   UNION ALL
			   SELECT 1 FROM expense_participants p
			     JOIN expenses e ON e.id = p.expense_id
			    WHERE e.trip_id = ? AND p.user_id = ?
			 ) AS present`
		)
		.get(tripId, userId, tripId, userId) as { present: number } | undefined;
	return !!row?.present;
}

/**
 * Remove a member. Organizers only; the organizer cannot be removed.
 *
 * This is also how an invite is revoked: a pending invite always has a
 * placeholder member, so removing that row is the same operation.
 *
 * What it does depends on who it is pointed at, and only one of the three is
 * destructive:
 *
 *  - **A placeholder who never touched the money** (invited, never registered,
 *    named on no expense) has no life outside the invite, so the `users` row
 *    itself is deleted. Every foreign key that references `users(id)` with ON
 *    DELETE CASCADE then fires, and the rows are gone with no undo. Derived
 *    from `db.ts`, those are: `sessions.user_id`, `trips.organizer_id` (the
 *    whole trip), `memberships.user_id`, `trip_invites.invited_by`,
 *    `expenses.payer_id` (the expense and all of its shares),
 *    `expense_participants.user_id`, `lodging_votes.user_id`,
 *    `poi_votes.user_id`, `item_assignees.user_id`, `task_assignees.user_id`,
 *    `task_done.user_id`, `party_membership.user_id`.
 *    `trip_invites.placeholder_id` is ON DELETE SET NULL, so it does NOT
 *    cascade; this function deletes that row explicitly instead.
 *  - **A placeholder who is named on an expense** is treated as a member
 *    instead, because that cascade would take real money with it: an expense
 *    they paid would vanish from the trip entirely, and a share they were
 *    charged would silently be absorbed by whoever remains. The membership goes
 *    and the `users` row stays as a tombstone, so the ledger still reads and
 *    the expense can be flagged for a human.
 *  - **A registered member** loses only their `memberships` row. Nothing
 *    cascades: the expenses, votes, assignments and completions all survive,
 *    attached to a user who is no longer on the trip.
 */
export function removeMember(tripId: string, actorId: string, userId: string): boolean {
	if (!isOrganizer(tripId, actorId)) return false;
	const target = membership(tripId, userId);
	if (!target || target.role === 'organizer') return false;
	const user = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(userId) as
		{ password_hash: string } | undefined;
	// Revoking an invite always means deleting its trip_invites row, whichever
	// branch the placeholder takes below. It does not cascade: placeholder_id is
	// ON DELETE SET NULL, so it would survive as an orphan. That matters because
	// trip_invites is UNIQUE (trip_id, email), so the stale row would permanently
	// reject re-inviting that address while being invisible in the UI, and would
	// still turn into a membership if the person later registered.
	if (user?.password_hash.startsWith('placeholder:')) {
		// Delete the invite before the user: trip_invites is UNIQUE (trip_id,
		// email), so this row is unambiguous, and deleting it first avoids
		// relying on the state the SET NULL leaves behind.
		db.prepare(`DELETE FROM trip_invites WHERE trip_id = ? AND email = ?`).run(
			tripId,
			user.password_hash.slice('placeholder:'.length)
		);
		// Deleting the user is only safe while they owe and are owed nothing. The
		// cascade would take expenses they paid and shares they were charged with
		// them, which silently rewrites what the group already agreed and is the
		// one thing removal is not allowed to do. A placeholder with money against
		// their name is therefore kept as a tombstone: membership gone, row left
		// behind so the ledger still reads and `needsReview` can point at it.
		// Their synthetic @waypoint.invalid address means keeping it never blocks
		// the real address from registering later.
		if (inLedger(tripId, userId)) {
			db.prepare(`DELETE FROM memberships WHERE trip_id = ? AND user_id = ?`).run(tripId, userId);
			detachMemberFromLedger(tripId, userId);
		} else {
			db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
		}
		// Either branch can touch votes, assignments, crew segments and the
		// ledger, so every section that could have shown this person is
		// invalidated rather than guessing which ones moved.
		publishMany(tripId, ['members', 'expenses', 'schedule', 'pois', 'lodging', 'tasks']);
		return true;
	}
	const res = db
		.prepare(`DELETE FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.run(tripId, userId);
	if (res.changes > 0) {
		// Their money does not leave with them. Proportional splits are re-divided
		// across whoever is left; stated ones, and anything they paid for, are
		// flagged for a human instead of being guessed at. Done before the events
		// so the refetch they trigger already sees the settled state.
		detachMemberFromLedger(tripId, userId);
		publishMany(tripId, ['members', 'expenses', 'schedule']);
	}
	return res.changes > 0;
}

/**
 * When a user registers, turn any pending invites for their email into
 * memberships.
 *
 * Handing a placeholder's data over and then deleting it is a multi-table
 * rewrite, so it runs in one transaction: a failure partway through would leave
 * expenses or votes split between the placeholder and the real account, or an
 * invite whose placeholder is already gone.
 */
export function consumeInvites(userId: string, email: string): void {
	const clean = email.trim().toLowerCase();
	const invites = db
		.prepare(`SELECT id, trip_id, placeholder_id FROM trip_invites WHERE email = ?`)
		.all(clean) as unknown as { id: string; trip_id: string; placeholder_id: string | null }[];
	const addMember = db.prepare(
		`INSERT OR IGNORE INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'member')`
	);
	const drop = db.prepare(`DELETE FROM trip_invites WHERE id = ?`);
	// Statements that hand a placeholder's data over to the real account, in
	// order, each run as (realUserId, placeholderId).
	//
	// This list must cover every foreign key that references `users(id)` ON
	// DELETE CASCADE and carries trip history, because anything still pointing at
	// the placeholder when its `users` row is deleted below is destroyed by that
	// cascade with no undo. The authoritative set is in `db.ts`.
	//
	// Conflict handling is per table, not blanket. Every join table below has a
	// composite primary key containing `user_id`, so the real account can already
	// hold the identical row, and a plain UPDATE would violate that primary key
	// and abort the registration. `UPDATE OR IGNORE` skips exactly those
	// colliding rows and leaves them on the placeholder; the `DELETE FROM users`
	// that follows then cascades them away. So a collision resolves to the real
	// account's own row, one row per key, and nothing throws.
	const relinks = [
		// PK (trip_id, user_id): collides when the real account is already a member
		// of the trip they were invited to.
		`UPDATE OR IGNORE memberships SET user_id = ? WHERE user_id = ?`,
		// payer_id is a plain column under no unique index, so it cannot collide
		// and a plain UPDATE is correct: every expense the placeholder paid moves.
		`UPDATE expenses SET payer_id = ? WHERE payer_id = ?`,
		// PK (expense_id, user_id): collides when both identities were listed as
		// participants on one expense. Keeping the real account's row is also the
		// only safe answer for money, since merging two shares into one would
		// double-count a stake that the split already apportioned.
		`UPDATE OR IGNORE expense_participants SET user_id = ? WHERE user_id = ?`,
		// PK (poi_id, user_id): collides when both voted for the same POI. A vote
		// is a boolean per person, so the surviving single row is the right count.
		`UPDATE OR IGNORE poi_votes SET user_id = ? WHERE user_id = ?`,
		// PK (city_id, user_id): one vote per city, so a collision means both
		// identities voted for that city. The real account's choice wins; taking
		// the placeholder's instead would silently overwrite a live preference.
		`UPDATE OR IGNORE lodging_votes SET user_id = ? WHERE user_id = ?`,
		// PK (item_id, user_id): collides when the real account is already
		// assigned to the same calendar item. Assignment is set membership, so one
		// row is the whole meaning and the duplicate is dropped.
		`UPDATE OR IGNORE item_assignees SET user_id = ? WHERE user_id = ?`,
		// PK (task_id, user_id): same shape as item_assignees, one row per person
		// per task.
		`UPDATE OR IGNORE task_assignees SET user_id = ? WHERE user_id = ?`,
		// PK (task_id, user_id) plus a `done_at` payload. `done_at` is a timestamp,
		// never a counter or an accumulated total, so collapsing two rows into one
		// cannot double-count anything. On a collision the real account keeps its
		// own `done_at`: it ticked that task under its own identity, and that
		// timestamp is the truer record than the placeholder's.
		`UPDATE OR IGNORE task_done SET user_id = ? WHERE user_id = ?`,
		// party_membership is the one exception: it has a surrogate `id` primary
		// key and no unique index over (party_id, user_id, day), so an UPDATE here
		// can never raise a constraint error and OR IGNORE would be meaningless.
		// The risk is redundancy instead. Drop placeholder segments the real
		// account already holds byte for byte first, which loses no information,
		// then move the rest. Segments that overlap without being identical are
		// deliberately left alone: choosing which crew wins a contested window is a
		// product decision, and discarding one would be the same data loss this
		// change exists to stop.
		`DELETE FROM party_membership AS pm
		 WHERE EXISTS (
		   SELECT 1 FROM party_membership o
		   WHERE o.user_id = ? AND o.party_id = pm.party_id AND o.day = pm.day
		     AND o.start_min = pm.start_min AND o.end_min = pm.end_min
		 ) AND pm.user_id = ?`,
		`UPDATE party_membership SET user_id = ? WHERE user_id = ?`
	].map((sql) => db.prepare(sql));
	if (invites.length === 0) return;
	db.exec('BEGIN');
	try {
		for (const inv of invites) {
			if (inv.placeholder_id) {
				const exists = db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(inv.placeholder_id);
				if (exists) {
					for (const stmt of relinks) stmt.run(userId, inv.placeholder_id);
					db.prepare(`DELETE FROM users WHERE id = ?`).run(inv.placeholder_id);
				}
			}
			addMember.run(inv.trip_id, userId);
			drop.run(inv.id);
		}
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	// After COMMIT, and once per affected trip: a placeholder turning into a real
	// account changes the roster and re-points that person's expenses, votes,
	// calendar assignments, task assignments and completions, and crew segments,
	// so anyone with the trip open is looking at a stale name on stale rows.
	// Topics are the `TRIP_TOPICS` names from `events.ts`; `schedule` covers both
	// item assignees and party membership, which the calendar reads together.
	for (const inv of invites) {
		publishMany(inv.trip_id, ['members', 'expenses', 'schedule', 'pois', 'lodging', 'tasks']);
	}
}
