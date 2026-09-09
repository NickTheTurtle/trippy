import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { fail } from './respond';
import { getSessionUser, type SessionUser } from '@trippy/server/auth';
import { getTripForUser } from '@trippy/server/trips';

export const COOKIE = 'session';

/**
 * Cookie name and options are kept identical to the SvelteKit app's, so both
 * front ends can run against one API during the port and a session created in
 * either is valid in the other.
 */
export function issueSession(c: Parameters<typeof setCookie>[0], sessionId: string) {
	setCookie(c, COOKIE, sessionId, {
		path: '/',
		httpOnly: true,
		sameSite: 'Lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: 60 * 60 * 24 * 30
	});
}

export function clearSession(c: Parameters<typeof deleteCookie>[0]) {
	deleteCookie(c, COOKIE, { path: '/' });
}

type Vars = { user: SessionUser | null; trip: NonNullable<ReturnType<typeof getTripForUser>> };

/** Resolves the session on every request. Does not reject; that is `requireUser`'s job. */
export const session = createMiddleware<{ Variables: Vars }>(async (c, next) => {
	const id = getCookie(c, COOKIE);
	c.set('user', id ? getSessionUser(id) : null);
	await next();
});

export const requireUser = createMiddleware<{ Variables: Vars }>(async (c, next) => {
	if (!c.get('user')) return fail(c, 401, 'Not signed in');
	await next();
});

/**
 * Membership check for every /trips/:tripId route.
 *
 * `getTripForUser` returns null both when the trip does not exist and when the
 * caller is not a member, and this deliberately keeps that conflation: telling
 * a stranger the difference between "no such trip" and "a trip you cannot see"
 * leaks which trip ids are real.
 */
export const requireMember = createMiddleware<{ Variables: Vars }>(async (c, next) => {
	const user = c.get('user');
	if (!user) return fail(c, 401, 'Not signed in');

	const trip = getTripForUser(c.req.param('tripId')!, user.id);
	if (!trip) return fail(c, 404, 'Not found');

	c.set('trip', trip);
	await next();
});
