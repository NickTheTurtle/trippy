import { Hono } from 'hono';
import { isValidEmail } from '@trippy/core';
import { isIanaZone, isNameLength, nameTooLong } from '@trippy/core/validate';
import { requireUser, sessionId } from '../middleware';
import { body, rawStr, str } from '../parse';
import { fail, ok } from '../respond';
import type { Env } from '../types';
import {
	applyEmailChange,
	changePassword,
	deleteOtherSessions,
	emailChangeProblem,
	findUserById,
	pendingEmailChange,
	pruneExpiredTokens,
	startEmailChange,
	updateProfile,
	verifyUserPassword
} from '@trippy/server/auth';
import { emailChangeMail, mailConfigured, sendMail } from '@trippy/server/mail';
import { clearFailures, recordFailure, retryAfterMs } from '@trippy/server/throttle';

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
	if (!user) return fail(c, 401, 'Not signed in.');
	return c.json({
		profile: {
			name: user.name,
			email: user.email,
			homeTz: user.home_tz,
			// An address this account has asked to move to and not yet confirmed,
			// so the form can say where the link went instead of implying the
			// change is lost. Null when nothing is waiting.
			pendingEmail: pendingEmailChange(user.id)
		},
		timeZones: timeZonesFor(user.home_tz)
	});
});

/**
 * Name, home zone and email, each optional.
 *
 * Partial on purpose: the People page renames you and sends the name alone,
 * so a field left out keeps what the account already holds rather than being
 * reset to a default nobody asked for.
 *
 * The email is not a field like the others. It is the account's sign-in
 * identity and the key every trip invite is matched on, and changing it used
 * to be a plain write followed by `consumeInvites`: anyone signed in could type
 * a stranger's address and be handed every trip that stranger had been invited
 * to. So a different address now needs two things the name never did:
 *
 *  - the current password, so a session left open on a shared machine (or
 *    stolen) cannot re-home the account. Throttled on the same key as
 *    `POST /password`, because it is the same guess against the same secret and
 *    two endpoints must not mean twice the guesses.
 *  - proof of the new address. With mail configured nothing about the email
 *    changes here: a link goes to the new address and `POST /auth/verify-email`
 *    applies it, invites and all, only once it is opened (202). With no mail
 *    provider there is nothing to prove an address with, and registration
 *    already takes an address on trust in that mode, so this does the same and
 *    applies it at once (200). A deployment cannot be safer here than its own
 *    sign-up page.
 *
 * Every check runs before anything is written, so a refused request changes
 * nothing, and name and zone changes riding along with an email change still
 * apply when the email itself is left pending.
 */
account.patch('/profile', async (c) => {
	const b = await body(c);
	const u = c.get('user');
	const current = findUserById(u.id);
	if (!current) return fail(c, 401, 'Not signed in.');

	const name = str(b.name) || current.name;
	const homeTz = str(b.homeTz) || current.home_tz;
	if (!isNameLength(name)) return fail(c, 400, nameTooLong());
	if (homeTz !== current.home_tz && !isIanaZone(homeTz)) {
		return fail(c, 400, 'Pick a time zone from the list.');
	}

	// Compared normalised, so re-saving the form with the address in a different
	// case is not an email change and does not ask for a password.
	const email = str(b.email).toLowerCase();
	const changing = email !== '' && email !== current.email.toLowerCase();

	if (changing) {
		if (!isValidEmail(email)) return fail(c, 400, 'Enter a valid email address.');
		const key = `password:${u.id}`;
		const wait = retryAfterMs(key);
		if (wait > 0) {
			c.header('retry-after', String(Math.ceil(wait / 1000)));
			return fail(c, 429, 'Too many attempts. Try again in a moment.');
		}
		// Read untrimmed, like every password.
		const password = rawStr(b.currentPassword);
		// A missing password is not a guess, so it is not counted.
		if (!password) return fail(c, 400, 'Enter your current password to change your email.');
		if (!verifyUserPassword(u.id, password)) {
			recordFailure(key);
			return fail(c, 400, 'Your current password is incorrect.');
		}
		clearFailures(key);
		// Only after the password: asked first, this would tell a stolen session
		// which addresses have accounts without it knowing anything.
		const problem = emailChangeProblem(u.id, email);
		if (problem) return fail(c, 400, problem);
	}

	const res = updateProfile(u.id, name, homeTz);
	if (!res.ok) return fail(c, 400, res.error);
	if (!changing) return c.json({ ok: true, pendingEmail: null });

	if (!mailConfigured()) {
		const applied = applyEmailChange(u.id, email);
		if (!applied.ok) return fail(c, 400, applied.error);
		return c.json({ ok: true, pendingEmail: null });
	}

	pruneExpiredTokens();
	const { token } = startEmailChange(u.id, email);
	await sendMail(emailChangeMail({ to: email, name, token }));
	return c.json({ ok: true, pendingEmail: email }, 202);
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
	// This endpoint verifies the current password, so it is a second place to
	// guess one, reachable by anyone holding a stolen session. Throttled by
	// account for the same reason login is.
	const key = `password:${c.get('user').id}`;
	const wait = retryAfterMs(key);
	if (wait > 0) {
		c.header('retry-after', String(Math.ceil(wait / 1000)));
		return fail(c, 429, 'Too many attempts. Try again in a moment.');
	}
	const res = changePassword(c.get('user').id, rawStr(b.current), next);
	if (!res.ok) {
		recordFailure(key);
		return fail(c, 400, res.error);
	}
	clearFailures(key);
	// A password is usually changed because someone else may know it, so the
	// other devices holding a session issued against the old one are signed out.
	// This device keeps its session: being logged out by your own change reads
	// as the change having failed.
	deleteOtherSessions(c.get('user').id, sessionId(c));
	return ok(c);
});
