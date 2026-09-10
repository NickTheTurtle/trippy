import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from '../db';
import { consumeInvites } from '../persistence/members';
import { seedExampleTrips } from '../seeds/seed-example';

const SESSION_DAYS = 30;

export interface SessionUser {
	id: string;
	email: string;
	name: string;
	homeTz: string;
}

export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	const derived = scryptSync(password, salt, 64);
	return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const [saltHex, keyHex] = stored.split(':');
	if (!saltHex || !keyHex) return false;
	const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
	const expected = Buffer.from(keyHex, 'hex');
	return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function createUser(email: string, name: string, password: string): SessionUser {
	const id = randomUUID();
	db.prepare(
		`INSERT INTO users (id, email, name, password_hash, home_tz, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, email.toLowerCase(), name, hashPassword(password), 'UTC', Date.now());
	consumeInvites(id, email);
	return { id, email: email.toLowerCase(), name, homeTz: 'UTC' };
}

/**
 * Dev convenience: make sure a known demo account exists, pre-loaded with the two
 * sample trips, so there is something to click around in without hand-building data.
 * The seeding itself lives in `seed-example.ts`; this module owns credentials and
 * sessions only. Real registrations start empty (see `createUser`).
 */
export const DEMO_EMAIL = 'demo@waypoint.test';
export const DEMO_PASSWORD = 'WaypointDemo2026!';

export function ensureDemoAccount(): void {
	const existing = findUserByEmail(DEMO_EMAIL);
	if (existing) return;
	const id = randomUUID();
	db.prepare(
		`INSERT INTO users (id, email, name, password_hash, home_tz, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, DEMO_EMAIL, 'Demo Traveller', hashPassword(DEMO_PASSWORD), 'UTC', Date.now());
	seedExampleTrips(id);
}

export function findUserByEmail(email: string) {
	return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase()) as
		{ id: string; email: string; name: string; password_hash: string; home_tz: string } | undefined;
}

export function findUserById(id: string) {
	return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
		{ id: string; email: string; name: string; password_hash: string; home_tz: string } | undefined;
}

/** Update a user's display name, email, and home time zone. Email must stay unique. */
export function updateProfile(
	userId: string,
	name: string,
	email: string,
	homeTz: string
): { ok: true } | { ok: false; error: string } {
	const cleanName = name.trim();
	const cleanEmail = email.trim().toLowerCase();
	if (!cleanName) return { ok: false, error: 'Name is required.' };
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail))
		return { ok: false, error: 'Enter a valid email address.' };
	const clash = findUserByEmail(cleanEmail);
	if (clash && clash.id !== userId)
		return { ok: false, error: 'Another account already uses that email.' };
	const before = findUserById(userId);
	db.prepare(`UPDATE users SET name = ?, email = ?, home_tz = ? WHERE id = ?`).run(
		cleanName,
		cleanEmail,
		homeTz,
		userId
	);
	// An invite is addressed to an email, not to an account, so one sent to an
	// address you add later is waiting for you and nothing would ever pick it
	// up: registration was the only place that looked. Someone invited at their
	// work address who then corrects their profile should land in the trip, not
	// be told the invite had expired.
	if (before && before.email !== cleanEmail) consumeInvites(userId, cleanEmail);
	return { ok: true };
}

/** Change a user's password after verifying their current one. */
export function changePassword(
	userId: string,
	currentPassword: string,
	newPassword: string
): { ok: true } | { ok: false; error: string } {
	const user = findUserById(userId);
	if (!user) return { ok: false, error: 'Account not found.' };
	if (!verifyPassword(currentPassword, user.password_hash))
		return { ok: false, error: 'Your current password is incorrect.' };
	if (newPassword.length < 8)
		return { ok: false, error: 'New password must be at least 8 characters.' };
	db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(
		hashPassword(newPassword),
		userId
	);
	return { ok: true };
}

export function createSession(userId: string): string {
	const id = randomUUID();
	const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
	db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).run(
		id,
		userId,
		expires
	);
	return id;
}

export function getSessionUser(sessionId: string): SessionUser | null {
	const row = db
		.prepare(
			`SELECT u.id, u.email, u.name, u.home_tz AS homeTz, s.expires_at AS expiresAt
			 FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.id = ?`
		)
		.get(sessionId) as
		{ id: string; email: string; name: string; homeTz: string; expiresAt: number } | undefined;
	if (!row) return null;
	if (row.expiresAt < Date.now()) {
		deleteSession(sessionId);
		return null;
	}
	return { id: row.id, email: row.email, name: row.name, homeTz: row.homeTz };
}

export function deleteSession(sessionId: string): void {
	db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
}

/**
 * Sign every *other* device out for this user, keeping the one that asked.
 *
 * Called on a password change. The usual reason to change a password is that
 * someone else may know it, and a change that left their session alive would
 * do nothing about that: sessions here are bearer credentials with a 30 day
 * life and no link back to the password they were issued against.
 */
export function deleteOtherSessions(userId: string, keepSessionId: string | null): void {
	db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?`).run(userId, keepSessionId);
}

/**
 * Drop sessions that have already expired.
 *
 * `getSessionUser` only clears the one row it happens to look at, so an
 * abandoned session is never read again and stays in the table forever. This
 * sweeps the rest.
 */
export function purgeExpiredSessions(): void {
	db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now());
}
