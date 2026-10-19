import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { env } from '@trippy/server/env';
import { createSession, findUserById } from '@trippy/server/auth';
import {
	appleFormName,
	appleIdentity,
	consumeAppleNonce,
	consumeSignInCode,
	consumeState,
	googleIdentity,
	issueAppleNonce,
	mintSignInCode,
	nativeRedirectAllowed,
	providerConfigured,
	providerStatus,
	signInWithIdentity,
	startSignIn,
	withParam,
	type Identity,
	signInMessage,
	type PendingSignIn,
	type Provider,
	type SignInError
} from '@trippy/server/oauth';
import { clearFailures, recordFailure, retryAfterMs } from '@trippy/server/throttle';
import { clientIp } from '../client-ip';
import { grant, issueSession } from '../middleware';
import { body, str } from '../parse';
import { fail } from '../respond';
import type { Env } from '../types';

/**
 * Sign in with Google and Apple. The flow and the account rules live in
 * `@trippy/server/oauth`; this is the HTTP around them.
 */
export const oauth = new Hono<Env>();

/**
 * Ties a callback to the browser that started the sign-in.
 *
 * `state` alone proves the callback belongs to *a* sign-in this server started,
 * not that this browser started it. Without the cookie, someone could start a
 * sign-in with their own account, stop at the callback URL and get a victim to
 * open it, signing the victim in as them ("login CSRF"), so that whatever the
 * victim plans next lands in the attacker's account.
 *
 * Apple posts its callback from appleid.apple.com, a cross-site POST, which
 * carries a cookie only if it is `SameSite=None` (and so `Secure`). Apple only
 * returns to https, so production is the only place that matters; plain-http
 * development keeps `Lax`, which Google's top-level GET callback carries.
 */
const STATE_COOKIE = 'oauth_state';

function setStateCookie(c: Context, state: string) {
	setCookie(c, STATE_COOKIE, state, {
		path: '/api/auth',
		httpOnly: true,
		secure: env.PRODUCTION,
		sameSite: env.PRODUCTION ? 'None' : 'Lax',
		maxAge: 10 * 60
	});
}

function isProvider(v: string): v is Provider {
	return v === 'google' || v === 'apple';
}

function webLogin(error?: SignInError): string {
	const base = `${env.APP_URL.replace(/\/+$/, '')}/login`;
	return error ? withParam(base, 'authError', error) : base;
}

/**
 * Failed callbacks return attempts to the throttle by caller, as a failed
 * password does: a stream of forged callbacks costs each one a key fetch and a
 * signature check, and a caller sending them is not signing in.
 */
function blocked(c: Context): boolean {
	return retryAfterMs(`oauth:ip:${clientIp(c)}`) > 0;
}

function failed(c: Context) {
	recordFailure(`oauth:ip:${clientIp(c)}`);
}

/**
 * Starts (and Apple nonces) a caller may ask for before backoff. Each writes a
 * row, so an unmetered loop would grow `oauth_states` without limit. Generous,
 * since a person retrying a sign-in starts a handful; cleared by a success.
 */
const STARTS_PER_CALLER = 30;

function startBlocked(c: Context): boolean {
	const key = `oauth:start:${clientIp(c)}`;
	if (retryAfterMs(key) > 0) return true;
	recordFailure(key, Date.now(), STARTS_PER_CALLER);
	return false;
}

function signedIn(c: Context) {
	clearFailures(`oauth:ip:${clientIp(c)}`);
	clearFailures(`oauth:start:${clientIp(c)}`);
}

oauth.get('/providers', (c) => c.json(providerStatus()));

/**
 * Start a browser sign-in and send the browser to the provider.
 *
 * `client=web` comes back with the session cookie set; `client=native` comes
 * back to `redirect`, the app's own URL, with a one-time code. A native start
 * with a return URL we will not send codes to is refused outright rather than
 * redirected, because the only safe place to report it is the caller.
 */
oauth.get('/:provider/start', (c) => {
	const provider = c.req.param('provider');
	if (!isProvider(provider)) return fail(c, 404, 'Not found.');
	const client = c.req.query('client') === 'native' ? 'native' : 'web';
	const redirect = c.req.query('redirect') ?? null;
	if (client === 'native' && !nativeRedirectAllowed(redirect)) {
		return fail(c, 400, 'That app link cannot receive a sign-in.');
	}
	const refuse = (error: SignInError) =>
		c.redirect(client === 'native' ? withParam(redirect!, 'error', error) : webLogin(error));
	if (!providerConfigured(provider)) return refuse('unavailable');
	if (startBlocked(c)) return refuse('throttled');
	const { state, url } = startSignIn({
		provider,
		client,
		redirect,
		next: c.req.query('next'),
		homeTz: c.req.query('tz')
	});
	setStateCookie(c, state);
	return c.redirect(url);
});

/**
 * Where a callback ends: a session for the browser, a code for the app, or the
 * reason it did not work, delivered to whichever of the two started it.
 */
function finish(
	c: Context,
	pending: PendingSignIn,
	result: { identity: Identity | null; cancelled?: boolean; throttled?: boolean },
	status: 302 | 303 = 302
) {
	const toClient = (error?: SignInError) =>
		pending.client === 'native'
			? error
				? withParam(pending.redirect!, 'error', error)
				: pending.redirect!
			: webLogin(error);
	if (!pending.valid) return c.redirect(toClient('expired'), status);
	if (result.throttled) return c.redirect(toClient('throttled'), status);
	if (result.cancelled) return c.redirect(toClient(), status);
	if (!result.identity) {
		failed(c);
		return c.redirect(toClient('failed'), status);
	}
	const signed = signInWithIdentity(result.identity, pending.homeTz);
	if (!signed.ok) return c.redirect(toClient(signed.error), status);
	signedIn(c);
	if (pending.client === 'native') {
		return c.redirect(withParam(pending.redirect!, 'code', mintSignInCode(signed.user.id)), status);
	}
	issueSession(c, createSession(signed.user.id));
	return c.redirect(`${env.APP_URL.replace(/\/+$/, '')}${pending.next ?? '/trips'}`, status);
}

/**
 * The state named by a callback, used up, and checked against this browser's
 * cookie. The cookie goes either way: one sign-in, one attempt. A state this
 * server never issued is null; one that is stale or arrives in another browser
 * comes back invalid, so its refusal still reaches the client that started it.
 */
function pendingFor(c: Context, provider: Provider, state: string): PendingSignIn | null {
	const cookie = getCookie(c, STATE_COOKIE);
	deleteCookie(c, STATE_COOKIE, { path: '/api/auth' });
	const pending = consumeState(state, provider);
	if (!pending) return null;
	return cookie && cookie === state ? pending : { ...pending, valid: false };
}

oauth.get('/google/callback', async (c) => {
	const pending = pendingFor(c, 'google', c.req.query('state') ?? '');
	if (!pending) return c.redirect(webLogin('expired'));
	if (blocked(c)) return finish(c, pending, { identity: null, throttled: true });
	// `access_denied` is the person choosing Cancel at Google: no error to show.
	const error = c.req.query('error');
	if (error) return finish(c, pending, { identity: null, cancelled: error === 'access_denied' });
	if (!pending.valid) return finish(c, pending, { identity: null });
	return finish(c, pending, { identity: await googleIdentity(c.req.query('code') ?? '', pending) });
});

oauth.post('/apple/callback', async (c) => {
	const form = await c.req.parseBody();
	const field = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '');
	const pending = pendingFor(c, 'apple', field('state'));
	// 303 so the browser follows a POST callback with a GET.
	if (!pending) return c.redirect(webLogin('expired'), 303);
	if (blocked(c)) return finish(c, pending, { identity: null, throttled: true }, 303);
	if (!pending.valid) return finish(c, pending, { identity: null }, 303);
	const error = field('error');
	if (error) {
		return finish(
			c,
			pending,
			{ identity: null, cancelled: error === 'user_cancelled_authorize' },
			303
		);
	}
	const identity = await appleIdentity(
		field('id_token'),
		[env.APPLE_SERVICES_ID ?? ''],
		pending.nonce,
		appleFormName(field('user'))
	);
	return finish(c, pending, { identity }, 303);
});

/** The app trades the code it was handed for a session. */
oauth.post('/exchange', async (c) => {
	if (blocked(c)) return fail(c, 429, signInMessage.throttled);
	const userId = consumeSignInCode(str((await body(c)).code));
	const user = userId ? findUserById(userId) : undefined;
	if (!user) {
		failed(c);
		return fail(c, 401, signInMessage.expired);
	}
	signedIn(c);
	return c.json({
		user: { id: user.id, name: user.name, email: user.email },
		...grant(c, user.id)
	});
});

/** A single-use nonce for the iOS Sign in with Apple sheet. */
oauth.post('/apple/nonce', (c) => {
	if (!providerStatus().appleNative) return fail(c, 404, 'Not found.');
	if (blocked(c) || startBlocked(c)) return fail(c, 429, signInMessage.throttled);
	return c.json({ nonce: issueAppleNonce() });
});

/**
 * Sign in with the identity token the iOS sheet returned. The token must be
 * issued to one of our bundle ids and carry a nonce this server issued and
 * has not seen used.
 */
oauth.post('/apple/native', async (c) => {
	if (blocked(c)) return fail(c, 429, signInMessage.throttled);
	const b = await body(c);
	const nonce = str(b.nonce);
	if (!consumeAppleNonce(nonce)) {
		failed(c);
		return fail(c, 401, signInMessage.expired);
	}
	const identity = await appleIdentity(
		str(b.identityToken),
		env.APPLE_BUNDLE_IDS,
		nonce,
		str(b.name)
	);
	if (!identity) {
		failed(c);
		return fail(c, 401, signInMessage.failed);
	}
	const signed = signInWithIdentity(identity, str(b.homeTz) || null);
	if (!signed.ok) return fail(c, 400, signInMessage[signed.error]);
	signedIn(c);
	return c.json({
		user: { id: signed.user.id, name: signed.user.name, email: signed.user.email },
		...grant(c, signed.user.id)
	});
});
