import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIanaZone, isNameLength } from '@trippy/core/validate';
import { db } from '../db';
import { env } from './env';
import { hashToken, mintToken } from './tokens';
import { authFetch, emailVerified, verifyIdToken, type IdTokenClaims } from './jwt';
import { findUserByEmail, findUserById, type SessionUser } from './auth';
import { consumeInvites } from '../persistence/members';

/**
 * Sign in with Google and Apple.
 *
 * Both use the same browser flow on the web and, for Google, in the app: the
 * API sends the browser to the provider (`startSignIn`), the provider sends it
 * back to our callback with proof of who signed in, and the callback either
 * sets the session cookie (web) or hands the app a one-time code for its
 * session token (native). Apple in the iOS app is the exception: the system
 * sheet hands the app an identity token directly, and the app posts it to us
 * (`signInWithAppleNative` in the routes).
 *
 * Whoever comes back, `signInWithIdentity` decides which Trippy account that is.
 */

export type Provider = 'google' | 'apple';
export type Client = 'web' | 'native';

const GOOGLE = {
	authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
	token: 'https://oauth2.googleapis.com/token',
	jwks: 'https://www.googleapis.com/oauth2/v3/certs',
	issuers: ['https://accounts.google.com', 'accounts.google.com']
};

const APPLE = {
	authorize: 'https://appleid.apple.com/auth/authorize',
	jwks: 'https://appleid.apple.com/auth/keys',
	issuers: ['https://appleid.apple.com']
};

/** How long a started sign-in may take, provider screens and all. */
const STATE_TTL_MS = 10 * 60 * 1000;
/** The app redeems its code the moment the browser returns. */
const CODE_TTL_MS = 2 * 60 * 1000;

export const providerName: Record<Provider, string> = { google: 'Google', apple: 'Apple' };

/**
 * Why a sign-in did not finish. A redirect carries the code, never a sentence:
 * text taken from a query string and drawn on our own login page is text anyone
 * can write there with a link. Each client maps the code to its own copy; the
 * JSON endpoints answer with `signInMessage`.
 */
export type SignInError =
	'expired' | 'failed' | 'throttled' | 'unavailable' | 'no-email' | 'log-in-first';

export const signInMessage: Record<SignInError, string> = {
	expired: 'That sign-in expired. Try again.',
	failed: 'Could not sign in with that account. Try again.',
	throttled: 'Too many attempts. Try again in a moment.',
	unavailable: 'That sign-in is not set up here.',
	'no-email': 'That account did not share a verified email address.',
	'log-in-first': 'An account already uses that email. Log in with your password.'
};

/** Which sign-ins this server can offer, from its configuration. */
export function providerStatus(): { google: boolean; apple: boolean; appleNative: boolean } {
	return {
		google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
		apple: !!env.APPLE_SERVICES_ID,
		appleNative: env.APPLE_BUNDLE_IDS.length > 0
	};
}

export function providerConfigured(provider: Provider): boolean {
	return providerStatus()[provider];
}

/** Where the provider sends the browser back to. Registered with each provider. */
export function callbackUrl(provider: Provider): string {
	return `${env.APP_URL.replace(/\/+$/, '')}/api/auth/${provider}/callback`;
}

/**
 * A post-sign-in destination on our own site, or null.
 *
 * Only a path: `//evil.example` and `/\evil.example` are paths to a browser
 * only in the sense that it will happily leave the site for them.
 */
export function safeNext(next: string | null | undefined): string | null {
	if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\'))
		return null;
	return next;
}

/**
 * Whether the app may be sent back to this URL with a sign-in code.
 *
 * This is the one place an attacker could aim the code somewhere else: a start
 * link with their own return URL, opened by a victim who then signs in, would
 * deliver the victim's code to them. So only the app's own scheme is allowed,
 * plus Expo Go's (and a dev build's) outside production, where the app under
 * test is running inside Expo rather than as itself. Any Expo Go project can be
 * reached by an `exp://` URL, so it is never accepted in production.
 */
export function nativeRedirectAllowed(raw: string | null | undefined): boolean {
	if (!raw) return false;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (url.protocol === 'trippy:') return true;
	return !env.PRODUCTION && ['exp:', 'exps:', 'exp+trippy:'].includes(url.protocol);
}

/** `url` with one query parameter set, keeping whatever it already carried. */
export function withParam(raw: string, key: string, value: string): string {
	const hash = raw.indexOf('#');
	const base = hash >= 0 ? raw.slice(0, hash) : raw;
	const sep = base.includes('?') ? '&' : '?';
	return `${base}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function pkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	return { verifier, challenge };
}

export interface StartInput {
	provider: Provider;
	client: Client;
	redirect?: string | null;
	next?: string | null;
	homeTz?: string | null;
}

/**
 * Begin a browser sign-in: remember what the provider must echo back, and
 * return the provider's URL to send the browser to.
 *
 * `state` ties the callback to this start (and, through a cookie, to this
 * browser); `nonce` ties the ID token to it, so a token from another sign-in is
 * refused. Google also gets PKCE, so a code intercepted on its way back is no
 * use without the verifier that never left this server.
 */
export function startSignIn(input: StartInput): { state: string; url: string } {
	pruneOAuth();
	const state = mintToken();
	const nonce = mintToken();
	const { verifier, challenge } = pkce();
	db.prepare(
		`INSERT INTO oauth_states (state_hash, provider, client, nonce, verifier, redirect, next_path, home_tz, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		hashToken(state),
		input.provider,
		input.client,
		nonce,
		input.provider === 'google' ? verifier : null,
		input.client === 'native' ? (input.redirect ?? null) : null,
		input.client === 'web' ? safeNext(input.next) : null,
		input.homeTz && isIanaZone(input.homeTz) ? input.homeTz : null,
		Date.now() + STATE_TTL_MS
	);

	const params =
		input.provider === 'google'
			? new URLSearchParams({
					client_id: env.GOOGLE_CLIENT_ID ?? '',
					redirect_uri: callbackUrl('google'),
					response_type: 'code',
					scope: 'openid email profile',
					state,
					nonce,
					code_challenge: challenge,
					code_challenge_method: 'S256',
					prompt: 'select_account'
				})
			: new URLSearchParams({
					client_id: env.APPLE_SERVICES_ID ?? '',
					redirect_uri: callbackUrl('apple'),
					// The ID token comes back with the code, posted to the callback, so
					// no client secret (a JWT signed with an Apple key) is ever needed.
					response_type: 'code id_token',
					response_mode: 'form_post',
					scope: 'name email',
					state,
					nonce
				});
	return {
		state,
		url: `${input.provider === 'google' ? GOOGLE.authorize : APPLE.authorize}?${params}`
	};
}

export interface PendingSignIn {
	/** False for a state that expired, belongs to another provider or another browser. */
	valid: boolean;
	provider: Provider;
	client: Client;
	nonce: string;
	verifier: string | null;
	redirect: string | null;
	next: string | null;
	homeTz: string | null;
}

/**
 * The sign-in a callback's `state` belongs to, used up, or null for a state
 * this server never issued. One that has expired or names another provider is
 * still returned, marked invalid, so the refusal can go back to whichever client
 * started it: an app's sign-in must end in the app, not on the website's login
 * page inside the browser sheet.
 */
export function consumeState(state: string, provider: Provider): PendingSignIn | null {
	if (!state) return null;
	const hash = hashToken(state);
	const row = db
		.prepare(
			`SELECT provider, client, nonce, verifier, redirect, next_path, home_tz, expires_at
			 FROM oauth_states WHERE state_hash = ?`
		)
		.get(hash) as
		| {
				provider: string;
				client: string;
				nonce: string;
				verifier: string | null;
				redirect: string | null;
				next_path: string | null;
				home_tz: string | null;
				expires_at: number;
		  }
		| undefined;
	if (!row) return null;
	// An Apple nonce shares the table but is no browser sign-in: it has no
	// client to report back to, so it reads as a state this server never issued.
	// Left in place, since it is not this callback's to spend.
	if (row.provider !== 'google' && row.provider !== 'apple') return null;
	if (row.client === 'native' && !row.redirect) return null;
	db.prepare(`DELETE FROM oauth_states WHERE state_hash = ?`).run(hash);
	return {
		valid: row.expires_at >= Date.now() && row.provider === provider,
		provider,
		client: row.client === 'native' ? 'native' : 'web',
		nonce: row.nonce,
		verifier: row.verifier,
		redirect: row.redirect,
		next: row.next_path,
		homeTz: row.home_tz
	};
}

/**
 * A nonce for Apple's native sheet. The app asks for one, passes it to Apple,
 * and posts the token back; the token must carry it and it is spent on use, so
 * a token from any other sign-in, including an earlier one of this person's, is
 * refused.
 */
export function issueAppleNonce(): string {
	pruneOAuth();
	const nonce = mintToken();
	db.prepare(
		`INSERT INTO oauth_states (state_hash, provider, client, nonce, expires_at)
		 VALUES (?, 'apple-native', 'native', ?, ?)`
	).run(hashToken(nonce), nonce, Date.now() + STATE_TTL_MS);
	return nonce;
}

export function consumeAppleNonce(nonce: string): boolean {
	if (!nonce) return false;
	const hash = hashToken(nonce);
	const row = db
		.prepare(`SELECT provider, expires_at FROM oauth_states WHERE state_hash = ?`)
		.get(hash) as { provider: string; expires_at: number } | undefined;
	if (!row) return false;
	db.prepare(`DELETE FROM oauth_states WHERE state_hash = ?`).run(hash);
	return row.provider === 'apple-native' && row.expires_at >= Date.now();
}

/** A one-time code the app trades for its session token. */
export function mintSignInCode(userId: string): string {
	const code = mintToken();
	db.prepare(`INSERT INTO oauth_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)`).run(
		hashToken(code),
		userId,
		Date.now() + CODE_TTL_MS
	);
	return code;
}

/** The user a code was minted for, used up, or null. */
export function consumeSignInCode(code: string): string | null {
	if (!code) return null;
	const hash = hashToken(code);
	const row = db
		.prepare(`SELECT user_id, expires_at FROM oauth_codes WHERE code_hash = ?`)
		.get(hash) as { user_id: string; expires_at: number } | undefined;
	if (!row) return null;
	db.prepare(`DELETE FROM oauth_codes WHERE code_hash = ?`).run(hash);
	return row.expires_at >= Date.now() ? row.user_id : null;
}

export function pruneOAuth(now = Date.now()): void {
	db.prepare(`DELETE FROM oauth_states WHERE expires_at < ?`).run(now);
	db.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?`).run(now);
}

/** What a provider told us about who signed in. */
export interface Identity {
	provider: Provider;
	subject: string;
	email: string | null;
	emailVerified: boolean;
	name: string | null;
}

export function identityFrom(
	provider: Provider,
	claims: IdTokenClaims,
	name?: string | null
): Identity {
	return {
		provider,
		subject: claims.sub,
		email: claims.email?.trim().toLowerCase() || null,
		emailVerified: emailVerified(claims),
		name: name?.trim() || claims.name?.trim() || null
	};
}

/** Trade Google's code for its ID token and check it. Done server to server, with PKCE. */
export async function googleIdentity(
	code: string,
	pending: PendingSignIn
): Promise<Identity | null> {
	if (!code || !pending.verifier) return null;
	let idToken: string | undefined;
	try {
		const res = await authFetch(GOOGLE.token, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				code,
				client_id: env.GOOGLE_CLIENT_ID ?? '',
				client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
				redirect_uri: callbackUrl('google'),
				grant_type: 'authorization_code',
				code_verifier: pending.verifier
			}),
			signal: AbortSignal.timeout(10_000)
		});
		if (!res.ok) return null;
		idToken = ((await res.json()) as { id_token?: string }).id_token;
	} catch {
		return null;
	}
	if (!idToken) return null;
	const checked = await verifyIdToken(idToken, {
		jwksUrl: GOOGLE.jwks,
		issuers: GOOGLE.issuers,
		audiences: [env.GOOGLE_CLIENT_ID ?? ''],
		nonce: pending.nonce
	});
	return checked.ok ? identityFrom('google', checked.claims) : null;
}

/**
 * Check an Apple identity token. `audiences` is the Services ID for the browser
 * flow and the app's bundle ids for the native sheet. The name arrives beside
 * the token, not in it, and only on a person's first sign-in to the app.
 */
export async function appleIdentity(
	idToken: string,
	audiences: string[],
	nonce: string,
	name?: string | null
): Promise<Identity | null> {
	if (!idToken || audiences.length === 0) return null;
	const checked = await verifyIdToken(idToken, {
		jwksUrl: APPLE.jwks,
		issuers: APPLE.issuers,
		audiences,
		nonce
	});
	return checked.ok ? identityFrom('apple', checked.claims, name) : null;
}

/**
 * The name Apple posts beside the token on a first sign-in, as JSON in the
 * form's `user` field: `{ "name": { "firstName", "lastName" } }`. Its email is
 * ignored: only the signed token's is trusted.
 */
export function appleFormName(raw: string | null | undefined): string | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { name?: { firstName?: string; lastName?: string } };
		const full = [parsed.name?.firstName, parsed.name?.lastName]
			.map((s) => s?.trim())
			.filter(Boolean)
			.join(' ');
		return full || null;
	} catch {
		return null;
	}
}

function toSessionUser(row: {
	id: string;
	email: string;
	name: string;
	home_tz: string;
}): SessionUser {
	return { id: row.id, email: row.email, name: row.name, homeTz: row.home_tz };
}

/**
 * The Trippy account a provider sign-in belongs to, creating it if needed.
 *
 * 1. An identity seen before signs into its account, whatever its email is now.
 * 2. Otherwise a verified email that already has an account signs into it, and
 *    the identity is linked so (1) applies from then on. The owner chose this:
 *    someone who signed up with a password and later taps Continue with Google
 *    expects their trips, not a second empty account. It is safe only when both
 *    claims to the address are proven: the provider's, and the account's own
 *    (`users.email_verified_at`). Otherwise it is refused with `log-in-first`.
 * 3. Otherwise a verified email starts a new account, with no password, and
 *    picks up the trip invites waiting for that address as a sign-up does.
 *
 * An identity with no verified email cannot be matched or reached by invites,
 * so it is refused rather than given an account nobody could add to a trip.
 */
export function signInWithIdentity(
	identity: Identity,
	homeTz?: string | null
): { ok: true; user: SessionUser; created: boolean } | { ok: false; error: SignInError } {
	const linked = db
		.prepare(`SELECT user_id FROM oauth_identities WHERE provider = ? AND subject = ?`)
		.get(identity.provider, identity.subject) as { user_id: string } | undefined;
	if (linked) {
		const user = findUserById(linked.user_id);
		if (user) {
			db.prepare(`UPDATE oauth_identities SET email = ? WHERE provider = ? AND subject = ?`).run(
				identity.email,
				identity.provider,
				identity.subject
			);
			return { ok: true, user: toSessionUser(user), created: false };
		}
	}

	if (!identity.email || !identity.emailVerified) return { ok: false, error: 'no-email' };

	const existing = findUserByEmail(identity.email);
	if (existing) {
		// Both sides must have proven the address. The provider has; an account
		// whose own claim was never proven (made or moved there with no mail
		// provider) might belong to someone who typed a stranger's address and
		// is waiting for them. Its owner logs in with the password instead, and a
		// password reset, which proves the address, lets this link next time.
		if (!emailProven(existing.id)) return { ok: false, error: 'log-in-first' };
		link(identity, existing.id);
		return { ok: true, user: toSessionUser(existing), created: false };
	}

	const id = randomUUID();
	const local = identity.email.split('@')[0] ?? '';
	const name = [identity.name, local, providerName[identity.provider]]
		.map((n) => n?.trim() ?? '')
		.find((n) => n && isNameLength(n)) as string;
	const zone = homeTz && isIanaZone(homeTz) ? homeTz : 'UTC';
	db.exec('BEGIN');
	try {
		db.prepare(
			`INSERT INTO users (id, email, name, password_hash, home_tz, created_at, email_verified_at)
			 VALUES (?, ?, ?, '', ?, ?, ?)`
		).run(id, identity.email, name, zone, Date.now(), Date.now());
		link(identity, id);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	consumeInvites(id, identity.email);
	return { ok: true, user: { id, email: identity.email, name, homeTz: zone }, created: true };
}

function emailProven(userId: string): boolean {
	const row = db.prepare(`SELECT email_verified_at FROM users WHERE id = ?`).get(userId) as
		{ email_verified_at: number | null } | undefined;
	return !!row?.email_verified_at;
}

function link(identity: Identity, userId: string): void {
	db.prepare(
		`INSERT INTO oauth_identities (provider, subject, user_id, email, created_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (provider, subject) DO UPDATE SET user_id = excluded.user_id, email = excluded.email`
	).run(identity.provider, identity.subject, userId, identity.email, Date.now());
}
