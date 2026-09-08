import { randomUUID } from 'node:crypto';
import { db } from './db';

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

export interface PendingInvite {
	id: string;
	email: string;
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

export function listPendingInvites(tripId: string): PendingInvite[] {
	return db
		.prepare(`SELECT id, email FROM trip_invites WHERE trip_id = ? ORDER BY created_at`)
		.all(tripId) as unknown as PendingInvite[];
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
	const placeholderId = randomUUID();
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
	return 'invited';
}

export function revokeInvite(tripId: string, actorId: string, inviteId: string): boolean {
	if (!isOrganizer(tripId, actorId)) return false;
	const inv = db
		.prepare(`SELECT placeholder_id FROM trip_invites WHERE id = ? AND trip_id = ?`)
		.get(inviteId, tripId) as { placeholder_id: string | null } | undefined;
	if (!inv) return false;
	// Deleting the placeholder user cascades to its membership and invite row.
	if (inv.placeholder_id) {
		db.prepare(`DELETE FROM users WHERE id = ?`).run(inv.placeholder_id);
	}
	db.prepare(`DELETE FROM trip_invites WHERE id = ? AND trip_id = ?`).run(inviteId, tripId);
	return true;
}

/** Remove a member. Organizers only; the organizer cannot be removed. */
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
		return true;
	}
	const res = db
		.prepare(`DELETE FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.run(tripId, userId);
	return res.changes > 0;
}

/** When a user registers, turn any pending invites for their email into memberships. */
export function consumeInvites(userId: string, email: string): void {
	const clean = email.trim().toLowerCase();
	const invites = db
		.prepare(`SELECT id, trip_id, placeholder_id FROM trip_invites WHERE email = ?`)
		.all(clean) as unknown as { id: string; trip_id: string; placeholder_id: string | null }[];
	const addMember = db.prepare(
		`INSERT OR IGNORE INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'member')`
	);
	const drop = db.prepare(`DELETE FROM trip_invites WHERE id = ?`);
	// Statements that hand a placeholder's data over to the real account.
	const relinks = [
		`UPDATE OR IGNORE memberships SET user_id = ? WHERE user_id = ?`,
		`UPDATE expenses SET payer_id = ? WHERE payer_id = ?`,
		`UPDATE OR IGNORE expense_participants SET user_id = ? WHERE user_id = ?`,
		`UPDATE OR IGNORE poi_votes SET user_id = ? WHERE user_id = ?`,
		`UPDATE OR IGNORE lodging_votes SET user_id = ? WHERE user_id = ?`
	].map((sql) => db.prepare(sql));
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
}
