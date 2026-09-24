import { Hono } from 'hono';
import type { Context } from 'hono';
import { isValidEmail } from '@trippy/core';
import { isNameLength, nameTooLong } from '@trippy/core/validate';
import { issueSession, clearSession, requireUser, sessionId, wantsToken } from '../middleware';
import { clientIp } from '../client-ip';
import { body, rawStr, str } from '../parse';
import { fail, ok } from '../respond';
import {
	burnPasswordCheck,
	createUser,
	findUserByEmail,
	hashPassword,
	verifyPassword,
	createSession,
	deleteSession,
	startRegistration,
	completeRegistration,
	completeEmailChange,
	startPasswordReset,
	completePasswordReset,
	pruneExpiredTokens,
	type SessionUser
} from '@trippy/server/auth';
import { mailConfigured, passwordResetMail, sendMail, verifyEmailMail } from '@trippy/server/mail';
import {
	clearFailures,
	recordFailure,
	REGISTER_ATTEMPTS,
	retryAfterMs
} from '@trippy/server/throttle';

type Env = { Variables: { user: SessionUser | null } };

export const auth = new Hono<Env>();

/**
 * Verification mails any one address is sent before backoff applies. Three
 * covers a lost first mail and an impatient second try; past that, somebody is
 * using the form to fill that inbox.
 */
const REGISTER_MAILS_PER_ADDRESS = 3;

/**
 * Failed logins are counted against the account *and* against the caller.
 *
 * One key alone leaves an obvious hole in each direction: counting only the
 * email lets a spray try one common password against every account in turn
 * without ever tripping, and counting only the address lets a botnet grind a
 * single account from a thousand of them. Both are cheap, so both are kept.
 *
 * `clientIp` now trusts only the address our own proxy appended to
 * `X-Forwarded-For` (see client-ip.ts); before that a caller could forge a new
 * per-IP identity per request and slip every per-address limit here.
 */
function throttleKeys(c: Context<Env>, email: string): string[] {
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
	// are registered. The same goes for how long the answer takes: a missing
	// account used to skip the key derivation and come back in a fraction of the
	// time, so it burns one against a throwaway hash instead.
	if (!user) burnPasswordCheck(password);
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
	// Optional: the browser's own zone, so a new account's "today" is the
	// reader's. Anything that is not a real zone quietly falls back to UTC; the
	// person never typed it, so refusing the sign-up over it would be wrong.
	const homeTz = str(b.homeTz) || undefined;

	// Registering also derives a key, so this endpoint is the same CPU lever as
	// login with none of the guessing. Counted by address only: the email is by
	// definition not an account yet.
	//
	// Per-IP is kept as the key, but the *ceiling* is the thing that matters for
	// Trippy's own users. They are groups planning a trip together, and a group
	// is exactly the set of people most likely to be behind one NAT: an office,
	// a house, a campus. The production `TRIPPY_REGISTER_LIMIT=5` is too tight
	// for that; five sign-ups shared across everyone at one address is plausibly
	// the app's own launch party locking itself out. The recommendation to the
	// owner is to raise it (the default here is 20, and 20-30 is sensible),
	// leaning on email verification plus the new suppression list, not a tight
	// signup cap, to blunt bulk account creation. The corrected `clientIp` also
	// closes the older hole where the first `X-Forwarded-For` value, and so the
	// key, could be spoofed per request.
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
	if (!isNameLength(name)) return fail(c, 400, nameTooLong());
	if (!email) return fail(c, 400, 'Enter an email address.');
	// Registration used to take the address on trust while the invite form and
	// the profile form both checked it, so `nope` could own an account it could
	// never be invited to or mailed at.
	if (!isValidEmail(email)) return fail(c, 400, 'Enter a valid email address.');
	if (password.length < 8) return fail(c, 400, 'Use at least 8 characters.');

	// Every well-formed attempt counts, not just the ones that create an
	// account. Counting only successes left the "already registered" answer
	// free, so an address could test as many emails as it liked for whether they
	// held an account. Form mistakes above are not counted: they reveal nothing
	// and derive no key, and a group behind one NAT fixing typos should not spend
	// the budget its later members need.
	recordFailure(key, Date.now(), REGISTER_ATTEMPTS);
	const taken = !!findUserByEmail(email);

	// With no mail provider there is no way to prove an address, so the account
	// is created outright. This is not a convenience: it is what lets a fresh
	// clone and the end-to-end suite register at all, and it is the honest
	// behaviour for a deployment that cannot send mail rather than one that
	// silently refuses every sign-up. The 409 stays in this mode for the same
	// reason: whoever is running a mail-less instance is a developer who needs
	// to be told the address is taken, and there is no verification step that
	// could tell them instead.
	if (!mailConfigured()) {
		if (taken) return fail(c, 409, 'That email is already registered.');
		const user = createUser(email, name, password, homeTz);
		return c.json({ user, ...grant(c, user.id) }, 201);
	}

	// Each address is mailed at most a few times an hour however many callers
	// ask, because every registration mails a stranger-typed address and an
	// unthrottled one is a way to use us to fill somebody's inbox. Keyed on the
	// address whether or not it has an account, so the limit says nothing about
	// which one it is.
	const mailKey = `register:email:${email}`;
	const mailWait = retryAfterMs(mailKey);
	if (mailWait > 0) {
		c.header('retry-after', String(Math.ceil(mailWait / 1000)));
		return fail(c, 429, 'Too many attempts. Try again in a moment.');
	}
	recordFailure(mailKey, Date.now(), REGISTER_MAILS_PER_ADDRESS);

	// With mail on, a taken address gets the same 202 a fresh one does. The
	// verification link is the one place that can tell the real owner anything
	// (and `completeRegistration` refuses a taken address there), so saying
	// "already registered" here only ever informed a stranger. The key
	// derivation still runs, and the mail is not awaited on either path, so the
	// two answers also take the same time.
	if (taken) {
		hashPassword(password);
		return c.json({ pending: true, email }, 202);
	}

	pruneExpiredTokens();
	const { token } = startRegistration(email, name, password, homeTz);
	// `sendMail` returns 'suppressed' when the address is on the bounce/complaint
	// list and sends nothing, but this route deliberately does NOT branch on the
	// result. The response is the same 202 "check your email" whether the mail
	// went out, was suppressed, or the address was already registered. Branching
	// would turn registration into the very enumeration oracle that `/forgot`
	// goes to such lengths to avoid: a different answer for a suppressed address
	// tells a stranger that address once bounced or complained here, which is
	// information about a real person's mailbox. The pending row is written
	// either way and simply expires unused; the person who owns a suppressed
	// address gets no mail, exactly as with a mistyped one.
	//
	// Not awaited, for the timing reason above: a provider round trip on one
	// path and not the other would tell the two apart. `sendMail` catches its own
	// failures; the catch here is only so nothing can surface as unhandled.
	void sendMail(verifyEmailMail({ to: email, name, token })).catch(() => undefined);
	return c.json({ pending: true, email }, 202);
});

/**
 * Turn the emailed link into an account and a session in one step.
 *
 * Signing them in here rather than sending them to the login form is the point
 * of the link: they have just proved the address and typed the password
 * minutes ago, and a form that asked for it again would be asking them to
 * prove something they have already proved.
 */
auth.post('/verify', async (c) => {
	const token = str((await body(c)).token);
	if (!token) return fail(c, 400, 'That link is no longer valid. Ask for a new one.');

	const result = completeRegistration(token);
	if (!result.ok) return fail(c, 400, result.error);
	return c.json({ user: result.user, ...grant(c, result.user.id) }, 201);
});

/**
 * Apply an email change from the link sent to the new address.
 *
 * No session required: the link may well be opened on a phone that has never
 * signed in, and the token is the whole credential, exactly as for `/verify`.
 * It does not sign anyone in either, because it did not prove a password, only
 * a mailbox. `completeEmailChange` re-checks that the address is still free,
 * writes it, and only then hands the account the invites waiting there.
 */
auth.post('/verify-email', async (c) => {
	const token = str((await body(c)).token);
	if (!token) return fail(c, 400, 'That link is no longer valid. Ask for a new one.');
	const result = completeEmailChange(token);
	if (!result.ok) return fail(c, 400, result.error);
	return ok(c);
});

/**
 * Ask for a reset link.
 *
 * Always 200, always the same message, whatever the address turns out to be.
 * Anything else answers "is this person registered here" for any address a
 * stranger cares to type.
 */
auth.post('/forgot', async (c) => {
	const email = str((await body(c)).email).toLowerCase();

	// Throttled by address as well as caller: this route sends mail to somebody
	// who did not ask for it, so an unthrottled one is a way to use us to
	// pester a third party.
	const keys = [`forgot:email:${email}`, `forgot:ip:${clientIp(c)}`];
	const wait = blockedFor(keys);
	if (wait > 0) {
		c.header('retry-after', String(Math.ceil(wait / 1000)));
		return fail(c, 429, 'Too many attempts. Try again in a moment.');
	}
	for (const k of keys) recordFailure(k);

	pruneExpiredTokens();
	const started = email && isValidEmail(email) ? startPasswordReset(email) : null;
	if (started) {
		await sendMail(passwordResetMail({ to: email, name: started.user.name, token: started.token }));
	}
	return c.json({ message: 'If that address has an account, a reset link is on its way.' });
});

auth.post('/reset', async (c) => {
	const b = await body(c);
	const token = str(b.token);
	const password = rawStr(b.password);
	if (!token) return fail(c, 400, 'That link is no longer valid. Ask for a new one.');
	if (password.length < 8) return fail(c, 400, 'Use at least 8 characters.');

	const result = completePasswordReset(token, password);
	if (!result.ok) return fail(c, 400, result.error);
	// Not signed in here, unlike verification: every session was just dropped
	// because the old password may be known to someone else, and handing back a
	// fresh one from a link that arrived by email would undo that in the one
	// case it exists for.
	return c.json({ message: 'Password changed. Sign in with it.' });
});

auth.post('/logout', (c) => {
	const id = sessionId(c);
	if (id) deleteSession(id);
	clearSession(c);
	return ok(c);
});

auth.get('/me', requireUser, (c) => c.json({ user: c.get('user') }));
