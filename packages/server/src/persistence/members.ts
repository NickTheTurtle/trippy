import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { publish, publishMany } from '../events';

export interface Person {
	id: string;
	name: string;
	email: string;
	role: string;
	seeded: boolean;
	placeholder: boolean;
	invitedEmail?: string | null;
}

/** Turn "jamie.lee@x.com" into a friendly display name like "Jamie Lee". */
function nameFromEmail(email: string): string {
	const local = email.split('@')[0] || 'Guest';
	return (
		local
			.split(/[._-]+/)
			.filter(Boolean)
			.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
			.join(' ') || 'Guest'
	);
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
			// A placeholder shows the address it was invited at, not the internal one.
			email: placeholder ? r.invited_email || r.email : r.email,
			role: r.role,
			// Seeded companions cannot log in; their hash is prefixed with "seed:".
			seeded: r.password_hash.startsWith('seed:'),
			placeholder,
			invitedEmail: r.invited_email
		};
	});
}

export type InviteResult = 'added' | 'invited' | 'exists' | 'invalid';

/**
 * Invite an email to a trip. If a user with that email already exists they are
 * added straight away; otherwise a pending invite is recorded and consumed when
 * they register (see `consumeInvites`).
 */
export function inviteToTrip(tripId: string, actorId: string, email: string): InviteResult {
	if (!isOrganizer(tripId, actorId)) return 'invalid';
	const clean = email.trim().toLowerCase();
	if (!clean || !clean.includes('@')) return 'invalid';

	const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get(clean) as
		| { id: string }
		| undefined;
	if (user) {
		const existing = membership(tripId, user.id);
		if (existing) return 'exists';
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

	// Create a placeholder member so the invitee is visible on the trip right away.
	// The placeholder has a synthetic address (the real email is UNIQUE and must stay
	// free for when they register); its hash is prefixed "placeholder:" so it cannot
	// log in and is easy to detect. consumeInvites() relinks it on registration.
	//
	// The three writes are one unit: a failure partway through would otherwise
	// leave a placeholder user with no invite (a ghost member nobody can revoke)
	// or an invite pointing at a member that was never created.
	const placeholderId = randomUUID();
	db.exec('BEGIN');
	try {
		db.prepare(
			`INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`
		).run(
			placeholderId,
			nameFromEmail(clean),
			`placeholder-${placeholderId}@waypoint.invalid`,
			`placeholder:${clean}`,
			Date.now()
		);
		db.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'member')`).run(
			tripId,
			placeholderId
		);
		db.prepare(
			`INSERT INTO trip_invites (id, trip_id, email, invited_by, placeholder_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run(randomUUID(), tripId, clean, actorId, placeholderId, Date.now());
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	// After COMMIT: an invalidation that names a change readers cannot see yet
	// would send every client to refetch the old roster and never correct itself.
	publish(tripId, 'members');
	return 'invited';
}

/**
 * Everything a removal touches, counted per table. Every field corresponds to
 * one foreign key that references `users(id)`; see `removalImpact` for the
 * cascade table it was derived from.
 */
export interface RemovalCounts {
	/** Expenses this person PAID. The whole expense row goes, with everyone's shares on it. */
	expensesPaid: number;
	/** Sum of those expenses, in their own currencies' minor units. Indicative only when currencies are mixed. */
	expensesPaidCents: number;
	/** Shares this person owes (their `expense_participants` rows). */
	expenseShares: number;
	/** OTHER members' shares that disappear with the expenses this person paid. */
	otherPeopleSharesLost: number;
	poiVotes: number;
	lodgingVotes: number;
	/** Calendar items they are assigned to (`item_assignees`). */
	itemAssignments: number;
	/** Pre-trip tasks assigned to them (`task_assignees`). */
	taskAssignments: number;
	/** Their per-person task completions (`task_done`). */
	taskCompletions: number;
	/** Crew membership segments (`party_membership`). */
	partySegments: number;
	/** Invites they sent (`trip_invites.invited_by`), which cascade with the user row. */
	invitesSent: number;
	/** Membership rows. */
	memberships: number;
	/** Trips they organize. Deleting the user deletes the whole trip. */
	tripsOrganized: number;
}

/** The blast radius of removing one member, as real numbers. */
export interface RemovalImpact {
	userId: string;
	name: string;
	/** Invited but never registered: removal deletes the user row itself. */
	isPlaceholder: boolean;
	/** A seeded demo companion. Cannot log in, but is a normal user row. */
	isSeeded: boolean;
	/**
	 * True when the `users` row is deleted (placeholders only), which is what
	 * makes every cascade below fire. False means only the membership row goes.
	 */
	deletesUserRow: boolean;
	/** Rows in THIS trip that removal permanently destroys. */
	destroyed: RemovalCounts;
	/** The same, in the member's OTHER trips. Non-zero only when the user row is deleted. */
	destroyedElsewhere: RemovalCounts;
	/**
	 * Rows in this trip that SURVIVE the removal but lose their member. All zero
	 * for a placeholder. For a registered member these are what stays behind:
	 * their expenses and shares remain in the ledger, their votes still count,
	 * their name stays on calendar items and tasks.
	 */
	retained: RemovalCounts;
	/** Login sessions ended. Only non-zero if the user row is deleted. */
	sessionsEnded: number;
	/**
	 * True when removal genuinely changes who owes whom on this trip.
	 *
	 * For a placeholder it is destructive: their expenses and shares are deleted
	 * and everyone else's balances move. For a registered member the rows stay,
	 * but `balances()` builds its result from the CURRENT member list, so a
	 * non-member's net silently drops out of the answer and the reported balances
	 * stop summing to zero. Either way the settlement a member sees changes, so
	 * either way this is true when they have any expense involvement.
	 */
	affectsSettlement: boolean;
}

const ZERO_COUNTS: RemovalCounts = {
	expensesPaid: 0,
	expensesPaidCents: 0,
	expenseShares: 0,
	otherPeopleSharesLost: 0,
	poiVotes: 0,
	lodgingVotes: 0,
	itemAssignments: 0,
	taskAssignments: 0,
	taskCompletions: 0,
	partySegments: 0,
	invitesSent: 0,
	memberships: 0,
	tripsOrganized: 0
};

function countOne(sql: string, ...args: (string | number)[]): number {
	const row = db.prepare(sql).get(...args) as { n: number } | undefined;
	return Number(row?.n ?? 0);
}

/**
 * Count everything owned by `userId` either inside this trip (`scope: 'trip'`)
 * or in every other trip (`scope: 'elsewhere'`).
 *
 * The scope is a comparison operator chosen here, never taken from a caller, so
 * the two variants stay one query each instead of two near-identical copies that
 * can drift apart. Every value is a single aggregate; nothing runs per row.
 */
function countRows(tripId: string, userId: string, scope: 'trip' | 'elsewhere'): RemovalCounts {
	const op = scope === 'trip' ? '=' : '<>';
	const paid = db
		.prepare(
			`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents
			 FROM expenses WHERE payer_id = ? AND trip_id ${op} ?`
		)
		.get(userId, tripId) as { n: number; cents: number } | undefined;
	return {
		expensesPaid: Number(paid?.n ?? 0),
		expensesPaidCents: Number(paid?.cents ?? 0),
		expenseShares: countOne(
			`SELECT COUNT(*) AS n FROM expense_participants p
			 JOIN expenses e ON e.id = p.expense_id
			 WHERE p.user_id = ? AND e.trip_id ${op} ?`,
			userId,
			tripId
		),
		otherPeopleSharesLost: countOne(
			`SELECT COUNT(*) AS n FROM expense_participants p
			 JOIN expenses e ON e.id = p.expense_id
			 WHERE e.payer_id = ? AND e.trip_id ${op} ? AND p.user_id <> ?`,
			userId,
			tripId,
			userId
		),
		poiVotes: countOne(
			`SELECT COUNT(*) AS n FROM poi_votes v JOIN pois p ON p.id = v.poi_id
			 WHERE v.user_id = ? AND p.trip_id ${op} ?`,
			userId,
			tripId
		),
		lodgingVotes: countOne(
			`SELECT COUNT(*) AS n FROM lodging_votes v JOIN cities c ON c.id = v.city_id
			 WHERE v.user_id = ? AND c.trip_id ${op} ?`,
			userId,
			tripId
		),
		itemAssignments: countOne(
			`SELECT COUNT(*) AS n FROM item_assignees a
			 JOIN schedule_items i ON i.id = a.item_id
			 JOIN tracks t ON t.id = i.track_id
			 WHERE a.user_id = ? AND t.trip_id ${op} ?`,
			userId,
			tripId
		),
		taskAssignments: countOne(
			`SELECT COUNT(*) AS n FROM task_assignees a JOIN trip_tasks t ON t.id = a.task_id
			 WHERE a.user_id = ? AND t.trip_id ${op} ?`,
			userId,
			tripId
		),
		taskCompletions: countOne(
			`SELECT COUNT(*) AS n FROM task_done d JOIN trip_tasks t ON t.id = d.task_id
			 WHERE d.user_id = ? AND t.trip_id ${op} ?`,
			userId,
			tripId
		),
		partySegments: countOne(
			`SELECT COUNT(*) AS n FROM party_membership pm JOIN parties p ON p.id = pm.party_id
			 WHERE pm.user_id = ? AND p.trip_id ${op} ?`,
			userId,
			tripId
		),
		invitesSent: countOne(
			`SELECT COUNT(*) AS n FROM trip_invites WHERE invited_by = ? AND trip_id ${op} ?`,
			userId,
			tripId
		),
		memberships: countOne(
			`SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND trip_id ${op} ?`,
			userId,
			tripId
		),
		tripsOrganized: countOne(
			`SELECT COUNT(*) AS n FROM trips WHERE organizer_id = ? AND id ${op} ?`,
			userId,
			tripId
		)
	};
}

/**
 * What removing this member would actually destroy. Read-only; writes nothing.
 *
 * `removeMember` does two completely different things depending on who it is
 * pointed at, and only one of them is destructive:
 *
 *  - **A placeholder** (invited, never registered) has no life outside the
 *    invite, so the `users` row itself is deleted. Every foreign key that
 *    references `users(id)` with ON DELETE CASCADE then fires, and the rows are
 *    gone with no undo. Derived from `db.ts`, those are:
 *    `sessions.user_id`, `trips.organizer_id` (the whole trip),
 *    `memberships.user_id`, `trip_invites.invited_by`, `expenses.payer_id`
 *    (the expense and all of its shares), `expense_participants.user_id`,
 *    `lodging_votes.user_id`, `poi_votes.user_id`, `item_assignees.user_id`,
 *    `task_assignees.user_id`, `task_done.user_id`, `party_membership.user_id`.
 *    `trip_invites.placeholder_id` is ON DELETE SET NULL, so it does NOT
 *    cascade; `removeMember` deletes that row explicitly instead.
 *  - **A registered member** loses only their `memberships` row. Nothing
 *    cascades: the expenses, votes, assignments and completions all survive,
 *    attached to a user who is no longer on the trip.
 *
 * Returns null under exactly the conditions that make `removeMember` return
 * false: the actor is not the organizer, there is no such member, or the target
 * is the organizer. So a caller can treat null as "not removable" and never has
 * to ask twice.
 */
export function removalImpact(
	tripId: string,
	memberUserId: string,
	actorId: string
): RemovalImpact | null {
	if (!isOrganizer(tripId, actorId)) return null;
	const target = membership(tripId, memberUserId);
	if (!target || target.role === 'organizer') return null;
	const user = db.prepare(`SELECT name, password_hash FROM users WHERE id = ?`).get(memberUserId) as
		| { name: string; password_hash: string }
		| undefined;
	if (!user) return null;

	const isPlaceholder = user.password_hash.startsWith('placeholder:');
	const inTrip = countRows(tripId, memberUserId, 'trip');
	const elsewhere = isPlaceholder ? countRows(tripId, memberUserId, 'elsewhere') : ZERO_COUNTS;

	// The membership row is deleted either way; it is the only thing the
	// registered path touches, so it is destroyed in both branches.
	const destroyed = isPlaceholder ? inTrip : { ...ZERO_COUNTS, memberships: inTrip.memberships };
	const retained = isPlaceholder ? ZERO_COUNTS : { ...inTrip, memberships: 0 };

	return {
		userId: memberUserId,
		name: user.name,
		isPlaceholder,
		isSeeded: user.password_hash.startsWith('seed:'),
		deletesUserRow: isPlaceholder,
		destroyed,
		destroyedElsewhere: elsewhere,
		retained,
		sessionsEnded: isPlaceholder
			? countOne(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, memberUserId)
			: 0,
		// Paying and owing both move balances, so either alone is enough.
		affectsSettlement: inTrip.expensesPaid > 0 || inTrip.expenseShares > 0
	};
}

/**
 * Remove a member. Organizers only; the organizer cannot be removed.
 *
 * This is also how an invite is revoked: a pending invite always has a
 * placeholder member, so removing that row is the same operation.
 *
 * Destructive for a placeholder, by decision: see `removalImpact`, which
 * reports exactly what this will delete so the confirmation can state numbers.
 */
export function removeMember(tripId: string, actorId: string, userId: string): boolean {
	if (!isOrganizer(tripId, actorId)) return false;
	const target = membership(tripId, userId);
	if (!target || target.role === 'organizer') return false;
	const user = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(userId) as
		| { password_hash: string }
		| undefined;
	// A placeholder exists only for this trip, so removing it deletes the user,
	// which cascades to its membership and votes. The invite row does not
	// cascade: its placeholder_id is ON DELETE SET NULL, so it would survive as
	// an orphan. That matters because trip_invites is UNIQUE (trip_id, email),
	// so the stale row would permanently reject re-inviting that address while
	// being invisible in the UI, and would still turn into a membership if the
	// person later registered.
	if (user?.password_hash.startsWith('placeholder:')) {
		// Delete the invite before the user: trip_invites is UNIQUE (trip_id,
		// email), so this row is unambiguous, and deleting it first avoids
		// relying on the state the SET NULL leaves behind.
		db.prepare(`DELETE FROM trip_invites WHERE trip_id = ? AND email = ?`).run(
			tripId,
			user.password_hash.slice('placeholder:'.length)
		);
		db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
		// The cascade reaches expense shares, expenses they paid, both vote
		// tables, item and task assignments and crew segments, so every section
		// that could have shown them is invalidated. `removalImpact` reports the
		// same set as counts, before the fact.
		publishMany(tripId, ['members', 'expenses', 'schedule', 'pois', 'lodging', 'tasks']);
		return true;
	}
	const res = db
		.prepare(`DELETE FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.run(tripId, userId);
	if (res.changes > 0) publishMany(tripId, ['members', 'expenses', 'schedule']);
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
	// cascade with no undo. The authoritative set is in `db.ts`; `removalImpact`
	// enumerates the same one.
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