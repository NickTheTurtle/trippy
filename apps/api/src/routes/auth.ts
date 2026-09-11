import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { isValidEmail } from '@trippy/core';
import { issueSession, clearSession, requireUser, sessionId, wantsToken } from '../middleware';
import { body, rawStr, str } from '../parse';
import { fail, ok } from '../respond';
import {
	createUser,
	findUserByEmail,
	verifyPassword,
	createSession,
	deleteSession,
	type SessionUser
} from '@trippy/server/auth';
import { clearFailures, recordFailure, REGISTER_ATTEMPTS, retryAfterMs } from '@trippy/server/throttle';

type Env = { Variables: { user: SessionUser | null } };

export const auth = new Hono<Env>();

/** Best guess at who is calling, for throttling. Never trusted for authority. */
function clientIp(c: Parameters<typeof getConnInfo>[0]): string {
	const forwarded = c.req.header('x-forwarded-for');
	if (forwarded) return forwarded.split(',')[0]!.trim();
	return getConnInfo(c).remote.address ?? 'unknown';
}

/**
 * Failed logins are counted against the account *and* against the caller.
 *
 * One key alone leaves an obvious hole in each direction: counting only the
 * email lets a spray try one common password against every account in turn
 * without ever tripping, and counting only the address lets a botnet grind a
 * single account from a thousand of them. Both are cheap, so both are kept.
 */
function throttleKeys(c: Parameters<typeof getConnInfo>[0], email: string): string[] {
	return [`login:email:${email}`, `login:ip:${clientIp(c)}`];
}

/** The longest wait any of these keys is currently serving. */
function blockedFor(keys: string[]): number {
	return Math.max(0, ...keys.map((k) => retryAfterMs(k)));
}

/**
 * Hands the caller its session however it asked for it: a cookie for the
 * browser, a token in the body for a native client. Never both, so a browser
 * session id is never exposed to script.
 */
function grant(c: Parameters<typeof issueSession>[0], userId: string) {
	const id = createSession(userId);
	if (wantsToken(c)) return { token: id };
	issueSession(c, id);
	return {};
}

/**
 * Passwords are read with `rawStr`, not `str`.
 *
 * Every other field on this router is trimmed, because a stray space around an
 * email or a name is a typo. A space at either end of a password is a character
 * of it: trimming one on the way in here would either lock out an account whose
 * password starts or ends with one, or quietly change what got stored at
 * registration. The value is passed through exactly as it was sent.
 */
auth.post('/login', async (c) => {
	const b = await body(c);
	const email = str(b.email).toLowerCase();
	const password = rawStr(b.password);

	// Checked before the password is verified, so a throttled attempt costs a
	// map lookup instead of a scrypt derivation. That is the point: the cost
	// that protects the stored hashes must not become a lever against us.
	const keys = throttleKeys(c, email);
	const wait = blockedFor(keys);
	if (wait > 0) {
		c.header('retry-after', String(Math.ceil(wait / 1000)));
		return fail(c, 429, 'Too many attempts. Try again in a moment.');
	}

	const user = email ? findUserByEmail(email) : null;

	// One message and one code for both a missing account and a wrong password.
	// Distinguishing them turns this endpoint into a test for which addresses
	// are registered.
	if (!user || !verifyPassword(password, user.password_hash)) {
		for (const k of keys) recordFailure(k);
		return fail(c, 401, 'Wrong email or password.');
	}

	// Only a success clears the count, and it clears the address too: whoever
	// just proved they own an account is not the traffic being defended against.
	for (const k of keys) clearFailures(k);

	return c.json({
		user: { id: user.id, name: user.name, email: user.email },
		...grant(c, user.id)
	});
});
auth.post('/register', async (c) => {
	const b = await body(c);
	const email = str(b.email).toLowerCase();
	const name = str(b.name);
	const password = rawStr(b.password);

	// Registering also derives a key, so this endpoint is the same CPU lever as
	// login with none of the guessing. Counted by address only: the email is by
	// definition not an account yet.
	const key = `register:ip:${clientIp(c)}`;
	const wait = retryAfterMs(key);
	if (wait > 0) {
		c.header('retry-after', String(Math.ceil(wait / 1000)));
		return fail(c, 429, 'Too many attempts. Try again in a moment.');
	}

	// One field per message, in the order the form presents them: "Name and
	// email are required" makes the reader work out which of the two they
	// missed, and they are looking at the form while they read it.
	if (!name) return fail(c, 400, 'Enter a name.');
	if (!email) return fail(c, 400, 'Enter an email address.');
	// Registration used to take the address on trust while the invite form and
	// the profile form both checked it, so `nope` could own an account it could
	// never be invited to or mailed at.
	if (!isValidEmail(email)) return fail(c, 400, 'Enter a valid email address.');
	if (password.length < 8) return fail(c, 400, 'Use at least 8 characters.');
	if (findUserByEmail(email)) return fail(c, 409, 'That email is already registered.');

	// Counted on success rather than on failure: one person signing up is one
	// account, so it is the rate of real registrations that needs a ceiling.
	recordFailure(key, Date.now(), REGISTER_ATTEMPTS);
	const user = createUser(email, name, password);
	return c.json({ user, ...grant(c, user.id) }, 201);
});

auth.post('/logout', (c) => {
	const id = sessionId(c);
	if (id) deleteSession(id);
	clearSession(c);
	return ok(c);
});

auth.get('/me', requireUser, (c) => c.json({ user: c.get('user') }));
