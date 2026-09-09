import { Hono } from 'hono';
import { requireUser } from '../middleware';
import { body, rawStr, str } from '../parse';
import { fail, ok } from '../respond';
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

/**
 * The offered list always contains the zone the account actually holds.
 *
 * `Intl.supportedValuesOf('timeZone')` returns canonical zone names and omits
 * `UTC`, which is exactly the value every new account starts on and the value
 * this route falls back to. Without this the picker renders as unset for the
 * default case, and any account carrying an alias or a zone this runtime does
 * not list would appear to have no zone at all.
 */
function timeZonesFor(current: string | null): string[] {
	const list = timeZones();
	if (!current || list.includes(current)) return list;
	return [current, ...list];
}

account.get('/', (c) => {
	const user = findUserById(c.get('user').id);
	// The session outlived the row, which means the account was deleted. Treat it
	// as signed out rather than 500ing on a missing user.
	if (!user) return fail(c, 401, 'Not signed in');
	return c.json({
		profile: { name: user.name, email: user.email, homeTz: user.home_tz },
		timeZones: timeZonesFor(user.home_tz)
	});
});

account.patch('/profile', async (c) => {
	const b = await body(c);
	const res = updateProfile(c.get('user').id, str(b.name), str(b.email), str(b.homeTz) || 'UTC');
	if (!res.ok) return fail(c, 400, res.error);
	return ok(c);
});

account.post('/password', async (c) => {
	const b = await body(c);
	// Passwords are read untrimmed: a leading or trailing space is a character
	// of the password, not whitespace around a value.
	const next = rawStr(b.next);
	// Confirmation is checked here rather than in auth.ts because it is a form
	// concern: the stored password has no notion of having been typed twice.
	if (next !== rawStr(b.confirm)) {
		return fail(c, 400, 'New passwords do not match.');
	}
	const res = changePassword(c.get('user').id, rawStr(b.current), next);
	if (!res.ok) return fail(c, 400, res.error);
	return ok(c);
});
