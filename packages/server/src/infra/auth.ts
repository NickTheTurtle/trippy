import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { isValidEmail } from '@trippy/core';
import { db } from '../db';
import { hashToken, mintToken, RESET_TTL_MS, VERIFY_TTL_MS } from './tokens';
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
	if (!cleanName) return { ok: false, error: 'Enter a name.' };
	if (!isValidEmail(cleanEmail)) return { ok: false, error: 'Enter a valid email address.' };	const clash = findUserByEmail(cleanEmail);
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
 * Registration, in two halves: nothing is written to `users` until the address
 * has been proven.
 *
 * The alternative (create the account, mark it unverified) leaves a real row
 * holding an address its owner never agreed to, which is enough to deny that
 * person the account forever, since `users.email` is UNIQUE. Parking the
 * attempt in `pending_registrations` instead means an unproven address costs a
 * row that expires, and nothing else.
 *
 * The password is hashed here rather than at the end, so the plaintext never
 * outlives the request that carried it.
 */
export function startRegistration(
	email: string,
	name: string,
	password: string
): { token: string } {
	const clean = email.trim().toLowerCase();
	const token = mintToken();
	// Asking twice replaces the first attempt: two live links to the same
	// address is one more than anybody needs, and the newest is the one the
	// person is looking at.
	db.prepare(
		`INSERT INTO pending_registrations (email, name, password_hash, token_hash, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (email) DO UPDATE SET
		   name = excluded.name,
		   password_hash = excluded.password_hash,
		   token_hash = excluded.token_hash,
		   expires_at = excluded.expires_at,
		   created_at = excluded.created_at`
	).run(
		clean,
		name.trim(),
		hashPassword(password),
		hashToken(token),
		Date.now() + VERIFY_TTL_MS,
		Date.now()
	);
	return { token };
}

/**
 * Finish a registration from the emailed link.
 *
 * Looked up by token hash, not by email: the link is the only thing the caller
 * has, and asking them for the address again would make the link alone
 * insufficient without making it any safer.
 */
export function completeRegistration(
	token: string
): { ok: true; user: SessionUser } | { ok: false; error: string } {
	const row = db
		.prepare(
			`SELECT email, name, password_hash, expires_at FROM pending_registrations
			 WHERE token_hash = ?`
		)
		.get(hashToken(token)) as
		| { email: string; name: string; password_hash: string; expires_at: number }
		| undefined;
	// One message for a token that is wrong, spent or stale. They are the same
	// thing to the person holding it (ask again), and telling them which would
	// let someone probe for links that once existed.
	if (!row) return { ok: false, error: 'That link is no longer valid. Ask for a new one.' };

	db.prepare(`DELETE FROM pending_registrations WHERE token_hash = ?`).run(hashToken(token));
	if (row.expires_at < Date.now())
		return { ok: false, error: 'That link is no longer valid. Ask for a new one.' };

	// The address can have been taken since the link was sent, by somebody who
	// proved it first. The pending row is already gone, so this is terminal.
	if (findUserByEmail(row.email))
		return { ok: false, error: 'That email is already registered.' };

	const id = randomUUID();
	db.prepare(
		`INSERT INTO users (id, email, name, password_hash, home_tz, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, row.email, row.name, row.password_hash, 'UTC', Date.now());
	consumeInvites(id, row.email);
	return { ok: true, user: { id, email: row.email, name: row.name, homeTz: 'UTC' } };
}

/**
 * Begin a password reset. Returns null when no account has that address.
 *
 * The caller must answer identically either way: a forgot-password form that
 * says "no such account" is a membership oracle for any address someone cares
 * to try, and the only person inconvenienced by the silence is one who mistyped
 * their own address, who will notice when no mail arrives.
 */
export function startPasswordReset(email: string): { token: string; user: SessionUser } | null {
	const user = findUserByEmail(email.trim().toLowerCase());
	if (!user) return null;
	// A placeholder or a seeded companion has no password to reset and cannot
	// log in, so a reset link would mint a way into a row that is not an account.
	if (user.password_hash.startsWith('placeholder:') || user.password_hash.startsWith('seed:'))
		return null;

	const token = mintToken();
	db.prepare(
		`INSERT INTO password_resets (token_hash, user_id, expires_at, created_at)
		 VALUES (?, ?, ?, ?)`
	).run(hashToken(token), user.id, Date.now() + RESET_TTL_MS, Date.now());
	return {
		token,
		user: { id: user.id, email: user.email, name: user.name, homeTz: user.home_tz }
	};
}

/**
 * Finish a password reset.
 *
 * Every session for the user is dropped, not just the other ones. Whoever is
 * resetting is not holding a session (that is the whole reason they are here),
 * so there is none to keep, and the person this protects against might well be.
 */
export function completePasswordReset(
	token: string,
	newPassword: string
): { ok: true } | { ok: false; error: string } {
	if (newPassword.length < 8) return { ok: false, error: 'Use at least 8 characters.' };

	const hash = hashToken(token);
	const row = db
		.prepare(`SELECT user_id, expires_at FROM password_resets WHERE token_hash = ?`)
		.get(hash) as { user_id: string; expires_at: number } | undefined;
	if (!row) return { ok: false, error: 'That link is no longer valid. Ask for a new one.' };

	// Spent whether or not it turns out to be in date, so a stale link cannot be
	// retried and a live one cannot be replayed.
	db.prepare(`DELETE FROM password_resets WHERE token_hash = ?`).run(hash);
	if (row.expires_at < Date.now())
		return { ok: false, error: 'That link is no longer valid. Ask for a new one.' };

	db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(
		hashPassword(newPassword),
		row.user_id
	);
	// Any other reset already in flight for this account is void now, and every
	// session is dropped: see the doc comment.
	db.prepare(`DELETE FROM password_resets WHERE user_id = ?`).run(row.user_id);
	db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(row.user_id);
	return { ok: true };
}

/**
 * Drop expired pending registrations and reset tokens.
 *
 * Called opportunistically when one is issued rather than on a timer: the table
 * only grows when somebody asks for a link, so that is exactly when it is worth
 * looking, and it keeps the server free of a background task whose only job is
 * deleting rows nobody can use.
 */
export function pruneExpiredTokens(): void {
	const now = Date.now();
	db.prepare(`DELETE FROM pending_registrations WHERE expires_at < ?`).run(now);
	db.prepare(`DELETE FROM password_resets WHERE expires_at < ?`).run(now);
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
