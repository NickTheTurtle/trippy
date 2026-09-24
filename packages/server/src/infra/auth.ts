import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { isValidEmail } from '@trippy/core';
import { isIanaZone, isNameLength, nameTooLong } from '@trippy/core/validate';
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

/**
 * The zone a new account starts on: the one its browser reported, when that is
 * a real zone, and UTC otherwise. Starting everyone on UTC meant every person
 * in the Americas saw "today" roll over in the afternoon until they found the
 * account page, which nobody opens on day one.
 */
function startingZone(homeTz: string | null | undefined): string {
	return homeTz && isIanaZone(homeTz) ? homeTz : 'UTC';
}

export function createUser(
	email: string,
	name: string,
	password: string,
	homeTz?: string
): SessionUser {
	const id = randomUUID();
	const zone = startingZone(homeTz);
	db.prepare(
		`INSERT INTO users (id, email, name, password_hash, home_tz, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, email.toLowerCase(), name, hashPassword(password), zone, Date.now());
	consumeInvites(id, email);
	return { id, email: email.toLowerCase(), name, homeTz: zone };
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

/**
 * Update a user's display name and home time zone.
 *
 * The email is deliberately not here any more. It is the account's identity
 * and the key every invite is matched on, so changing it is its own two-step,
 * password-gated flow: `startEmailChange` / `completeEmailChange` below.
 */
export function updateProfile(
	userId: string,
	name: string,
	homeTz: string
): { ok: true } | { ok: false; error: string } {
	const cleanName = name.trim();
	if (!cleanName) return { ok: false, error: 'Enter a name.' };
	if (!isNameLength(cleanName)) return { ok: false, error: nameTooLong() };
	// Asked of `Intl`, because every clock the app draws for this person reads
	// the zone through it: a value it refuses throws on every page they open.
	// Only a zone being changed is judged, so an account already holding an odd
	// value from before this check can still be renamed.
	const stored = findUserById(userId)?.home_tz;
	if (homeTz !== stored && !isIanaZone(homeTz)) {
		return { ok: false, error: 'Pick a time zone from the list.' };
	}
	db.prepare(`UPDATE users SET name = ?, home_tz = ? WHERE id = ?`).run(
		cleanName,
		homeTz.trim(),
		userId
	);
	return { ok: true };
}

/** Whether `password` is this account's current password. */
export function verifyUserPassword(userId: string, password: string): boolean {
	const user = findUserById(userId);
	if (!user) return false;
	return verifyPassword(password, user.password_hash);
}

let dummyHash: string | null = null;

/**
 * Spend one password derivation on nothing.
 *
 * Login used to answer a missing account after a map lookup and a wrong
 * password after a 64-byte scrypt, so the two identical 401s were told apart by
 * the clock: a few milliseconds against tens. Running the same derivation
 * against a throwaway hash makes both paths cost the same. The hash is made
 * once, lazily, so it costs nothing until the first unknown address arrives.
 */
export function burnPasswordCheck(password: string): void {
	dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
	verifyPassword(password, dummyHash);
}

/**
 * What is wrong with moving this account to `email`, or null when nothing is.
 *
 * "Already registered" uses the sentence registration uses. It is reached only
 * after the current password has been verified (see the route), so it is not an
 * oracle a stolen session can query for free.
 */
export function emailChangeProblem(userId: string, email: string): string | null {
	const clean = email.trim().toLowerCase();
	if (!isValidEmail(clean)) return 'Enter a valid email address.';
	const clash = findUserByEmail(clean);
	if (clash && clash.id !== userId) return 'That email is already registered.';
	return null;
}

/**
 * Move the account to a new address, then hand it the invites waiting there.
 *
 * The order is the point. `consumeInvites` must only ever run for an address
 * the account has actually been given, and it is only given one that has been
 * proven (or, with no mail provider, one that registration itself would have
 * accepted on trust; see `completeEmailChange` and the route).
 */
export function applyEmailChange(
	userId: string,
	email: string
): { ok: true } | { ok: false; error: string } {
	const clean = email.trim().toLowerCase();
	const problem = emailChangeProblem(userId, clean);
	if (problem) return { ok: false, error: problem };
	const before = findUserById(userId);
	if (!before) return { ok: false, error: 'That link is no longer valid. Ask for a new one.' };
	db.prepare(`UPDATE users SET email = ? WHERE id = ?`).run(clean, userId);
	// An invite is addressed to an email, not to an account, so one sent to an
	// address you add later is waiting for you and nothing would ever pick it
	// up: registration was the only place that looked. Someone invited at their
	// work address who then proves it on their profile should land in the trip.
	if (before.email !== clean) consumeInvites(userId, clean);
	db.prepare(`DELETE FROM pending_email_changes WHERE user_id = ?`).run(userId);
	return { ok: true };
}

/**
 * Park an email change until the new address proves itself.
 *
 * Asking again replaces the earlier request and voids its link, for the same
 * reason a second registration does. The caller has already verified the
 * password and checked the address is free.
 */
export function startEmailChange(userId: string, email: string): { token: string } {
	const token = mintToken();
	db.prepare(
		`INSERT INTO pending_email_changes (user_id, email, token_hash, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (user_id) DO UPDATE SET
		   email = excluded.email,
		   token_hash = excluded.token_hash,
		   expires_at = excluded.expires_at,
		   created_at = excluded.created_at`
	).run(userId, email.trim().toLowerCase(), hashToken(token), Date.now() + VERIFY_TTL_MS, Date.now());
	return { token };
}

/** The address this account is waiting to confirm, or null when none is live. */
export function pendingEmailChange(userId: string): string | null {
	const row = db
		.prepare(`SELECT email, expires_at FROM pending_email_changes WHERE user_id = ?`)
		.get(userId) as { email: string; expires_at: number } | undefined;
	return row && row.expires_at >= Date.now() ? row.email : null;
}

/**
 * Finish an email change from the emailed link.
 *
 * Spent whether or not it succeeds, like every other emailed link, and every
 * refusal a stale, spent or wrong token can produce is the same sentence. The
 * address is checked again here because somebody may have registered it, or
 * moved their own account onto it, while the link was in the post.
 */
export function completeEmailChange(
	token: string
): { ok: true; userId: string; email: string } | { ok: false; error: string } {
	const invalid = { ok: false as const, error: 'That link is no longer valid. Ask for a new one.' };
	const hash = hashToken(token);
	const row = db
		.prepare(`SELECT user_id, email, expires_at FROM pending_email_changes WHERE token_hash = ?`)
		.get(hash) as { user_id: string; email: string; expires_at: number } | undefined;
	if (!row) return invalid;
	db.prepare(`DELETE FROM pending_email_changes WHERE token_hash = ?`).run(hash);
	if (row.expires_at < Date.now()) return invalid;
	const applied = applyEmailChange(row.user_id, row.email);
	if (!applied.ok) return applied;
	return { ok: true, userId: row.user_id, email: row.email };
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
	password: string,
	homeTz?: string
): { token: string } {
	const clean = email.trim().toLowerCase();
	const token = mintToken();
	// Asking twice replaces the first attempt: two live links to the same
	// address is one more than anybody needs, and the newest is the one the
	// person is looking at.
	db.prepare(
		`INSERT INTO pending_registrations (email, name, password_hash, token_hash, expires_at, created_at, home_tz)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (email) DO UPDATE SET
		   name = excluded.name,
		   home_tz = excluded.home_tz,
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
		Date.now(),
		startingZone(homeTz)
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
			`SELECT email, name, password_hash, expires_at, home_tz FROM pending_registrations
			 WHERE token_hash = ?`
		)
		.get(hashToken(token)) as
		| {
				email: string;
				name: string;
				password_hash: string;
				expires_at: number;
				home_tz: string | null;
		  }
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
	const zone = startingZone(row.home_tz);
	db.prepare(
		`INSERT INTO users (id, email, name, password_hash, home_tz, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, row.email, row.name, row.password_hash, zone, Date.now());
	consumeInvites(id, row.email);
	return { ok: true, user: { id, email: row.email, name: row.name, homeTz: zone } };
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
	db.prepare(`DELETE FROM pending_email_changes WHERE expires_at < ?`).run(now);
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
