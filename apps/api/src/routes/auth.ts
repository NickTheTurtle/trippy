import { Hono } from 'hono';
import { issueSession, clearSession, requireUser, COOKIE } from '../middleware';
import { getCookie } from 'hono/cookie';
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

type Env = { Variables: { user: SessionUser | null } };

export const auth = new Hono<Env>();

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

	const user = email ? findUserByEmail(email) : null;

	// One message and one code for both a missing account and a wrong password.
	// Distinguishing them turns this endpoint into a test for which addresses
	// are registered.
	if (!user || !verifyPassword(password, user.password_hash)) {
		return fail(c, 401, 'Wrong email or password');
	}

	issueSession(c, createSession(user.id));
	return c.json({ user: { id: user.id, name: user.name, email: user.email } });
});

auth.post('/register', async (c) => {
	const b = await body(c);
	const email = str(b.email).toLowerCase();
	const name = str(b.name);
	const password = rawStr(b.password);

	if (!email || !name) return fail(c, 400, 'Name and email are required');
	if (password.length < 8) return fail(c, 400, 'Use at least 8 characters');
	if (findUserByEmail(email)) return fail(c, 409, 'That email is already registered');

	const user = createUser(email, name, password);
	issueSession(c, createSession(user.id));
	return c.json({ user }, 201);
});

auth.post('/logout', (c) => {
	const id = getCookie(c, COOKIE);
	if (id) deleteSession(id);
	clearSession(c);
	return ok(c);
});

auth.get('/me', requireUser, (c) => c.json({ user: c.get('user') }));
