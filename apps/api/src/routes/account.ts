import { Hono } from 'hono';
import { requireUser } from '../middleware';
import { body, str } from '../parse';
import type { Env } from '../types';
import { changePassword, findUserById, updateProfile } from '@trippy/server/auth';

export const account = new Hono<Env>();

account.use('*', requireUser);

function timeZones(): string[] {
	// Full IANA list where supported, with a small fallback set otherwise.
	const withValues = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
	if (typeof withValues.supportedValuesOf === 'function') {
		try {
			return withValues.supportedValuesOf('timeZone');
		} catch {
			// fall through
		}
	}
	return ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Shanghai'];
}

account.get('/', (c) => {
	const user = findUserById(c.get('user').id);
	// The session outlived the row, which means the account was deleted. Treat it
	// as signed out rather than 500ing on a missing user.
	if (!user) return c.json({ error: 'Not signed in' }, 401);
	return c.json({
		profile: { name: user.name, email: user.email, homeTz: user.home_tz },
		timeZones: timeZones()
	});
});

account.patch('/profile', async (c) => {
	const b = await body(c);
	const res = updateProfile(c.get('user').id, str(b.name), str(b.email), str(b.homeTz) || 'UTC');
	if (!res.ok) return c.json({ error: res.error }, 400);
	return c.json({ ok: true });
});

account.post('/password', async (c) => {
	const b = await body(c);
	const next = typeof b.next === 'string' ? b.next : '';
	// Confirmation is checked here rather than in auth.ts because it is a form
	// concern: the stored password has no notion of having been typed twice.
	if (next !== (typeof b.confirm === 'string' ? b.confirm : '')) {
		return c.json({ error: 'New passwords do not match.' }, 400);
	}
	const res = changePassword(c.get('user').id, typeof b.current === 'string' ? b.current : '', next);
	if (!res.ok) return c.json({ error: res.error }, 400);
	return c.json({ ok: true });
});
