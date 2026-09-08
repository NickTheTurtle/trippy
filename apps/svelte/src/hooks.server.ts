import type { Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { ensureDemoAccount, getSessionUser } from '$lib/server/auth';

const COOKIE = 'session';

// In dev only, make sure the demo account (with sample trips) exists. Runs once.
if (dev) ensureDemoAccount();

export const handle: Handle = async ({ event, resolve }) => {
	const sessionId = event.cookies.get(COOKIE) ?? null;
	event.locals.sessionId = sessionId;
	event.locals.user = sessionId ? getSessionUser(sessionId) : null;
	return resolve(event);
};
