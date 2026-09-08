import { Hono } from 'hono';
import { issueSession, clearSession, requireUser, COOKIE } from '../middleware';
import { getCookie } from 'hono/cookie';
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

auth.post('/login', async (c) => {
	const body = await c.req.json().catch(() => null);
	const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
	const password = typeof body?.password === 'string' ? body.password : '';

	const user = email ? findUserByEmail(email) : null;

	// One message and one code for both a missing account and a wrong password.
	// Distinguishing them turns this endpoint into a test for which addresses
	// are registered.
	if (!user || !verifyPassword(password, user.password_hash)) {
		return c.json({ error: 'Wrong email or password' }, 401);
	}

	issueSession(c, createSession(user.id));
	return c.json({ user: { id: user.id, name: user.name, email: user.email } });
});

auth.post('/register', async (c) => {
	const body = await c.req.json().catch(() => null);
	const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	const password = typeof body?.password === 'string' ? body.password : '';

	if (!email || !name) return c.json({ error: 'Name and email are required' }, 400);
	if (password.length < 8) return c.json({ error: 'Use at least 8 characters' }, 400);
	if (findUserByEmail(email)) return c.json({ error: 'That email is already registered' }, 409);

	const user = createUser(email, name, password);
	issueSession(c, createSession(user.id));
	return c.json({ user }, 201);
});

auth.post('/logout', (c) => {
	const id = getCookie(c, COOKIE);
	if (id) deleteSession(id);
	clearSession(c);
	return c.json({ ok: true });
});

auth.get('/me', requireUser, (c) => c.json({ user: c.get('user') }));
