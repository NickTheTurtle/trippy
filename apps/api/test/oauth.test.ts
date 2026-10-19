import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Sign in with Google and Apple, over HTTP through the real routes, against a
 * stand-in provider: real RSA keys, a key set and a token endpoint served from
 * memory. Nothing reaches the network (see vitest.setup.ts).
 */

const tempRoot = join(tmpdir(), `trippy-oauth-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'oauth.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;
process.env.APP_URL = 'http://app.test';
process.env.GOOGLE_CLIENT_ID = 'zz-google-client';
process.env.GOOGLE_CLIENT_SECRET = 'zz-google-secret';
process.env.APPLE_SERVICES_ID = 'zz.apple.web';
process.env.APPLE_BUNDLE_IDS = 'com.trippy.app';

const GOOGLE_ISS = 'https://accounts.google.com';
const APPLE_ISS = 'https://appleid.apple.com';

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let members: typeof import('@trippy/server/members');
let jwt: typeof import('@trippy/server/jwt');
let throttle: typeof import('@trippy/server/throttle');
let bus: typeof import('@trippy/server/events');
let app: Hono;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

function token(
	claims: Record<string, unknown>,
	opts: { kid?: string; alg?: string; key?: KeyObject } = {}
): string {
	const header = Buffer.from(
		JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1' })
	).toString('base64url');
	const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
	const sig = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), opts.key ?? privateKey);
	return `${header}.${body}.${sig.toString('base64url')}`;
}

const now = () => Math.floor(Date.now() / 1000);

/** What the stand-in Google token endpoint answers with, set per test. */
let googleClaims: Record<string, unknown> = {};
let lastTokenRequest: URLSearchParams | null = null;

beforeAll(async () => {
	const [
		dbMod,
		authMod,
		tripsMod,
		membersMod,
		jwtMod,
		throttleMod,
		busMod,
		mw,
		authRoutes,
		oauthRoutes
	] = await Promise.all([
		import('@trippy/server/db'),
		import('@trippy/server/auth'),
		import('@trippy/server/trips'),
		import('@trippy/server/members'),
		import('@trippy/server/jwt'),
		import('@trippy/server/throttle'),
		import('@trippy/server/events'),
		import('../src/middleware.ts'),
		import('../src/routes/auth.ts'),
		import('../src/routes/oauth.ts')
	]);
	db = dbMod.db;
	auth = authMod;
	trips = tripsMod;
	members = membersMod;
	jwt = jwtMod;
	throttle = throttleMod;
	bus = busMod;

	jwt.setAuthFetch((async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/oauth2/v3/certs') || url.endsWith('/auth/keys')) {
			return Response.json({ keys: [jwk] });
		}
		if (url === 'https://oauth2.googleapis.com/token') {
			lastTokenRequest = new URLSearchParams(String(init?.body));
			return Response.json({ id_token: token(googleClaims) });
		}
		throw new Error(`unexpected fetch ${url}`);
	}) as typeof fetch);

	app = new Hono();
	app.use('*', mw.session);
	app.route('/api/auth', authRoutes.auth as unknown as Hono);
	app.route('/api/auth', oauthRoutes.oauth as unknown as Hono);
});

beforeEach(() => {
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
	db.prepare(`DELETE FROM oauth_states`).run();
	throttle.resetThrottle();
	googleClaims = {};
	lastTokenRequest = null;
	delete process.env.NODE_ENV;
});

afterAll(() => {
	bus.closeAll();
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

/** A request with a socket behind it, which the per-caller throttle reads. */
const CONN = {
	incoming: { socket: { remoteAddress: '203.0.113.9', remotePort: 40000, remoteFamily: 'IPv4' } }
};
function call(path: string, init?: RequestInit) {
	return app.request(path, init, CONN);
}

/** Starts a sign-in; returns what the provider would be told and the browser's cookie. */
async function start(provider: 'google' | 'apple', query: string) {
	const res = await call(`/api/auth/${provider}/start?${query}`);
	expect(res.status).toBe(302);
	const location = new URL(res.headers.get('location')!);
	const cookie = /oauth_state=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
	return {
		location,
		state: location.searchParams.get('state')!,
		nonce: location.searchParams.get('nonce')!,
		cookie: `oauth_state=${cookie}`
	};
}

function googleUser(nonce: string, extra: Record<string, unknown> = {}) {
	return {
		iss: GOOGLE_ISS,
		aud: 'zz-google-client',
		sub: 'g-1',
		email: 'ada@example.test',
		email_verified: true,
		name: 'Ada Lovelace',
		iat: now(),
		exp: now() + 600,
		nonce,
		...extra
	};
}

async function googleCallback(state: string, cookie: string) {
	return call(`/api/auth/google/callback?state=${state}&code=zz-code`, {
		headers: { cookie }
	});
}

function sessionFrom(res: Response): string | null {
	return /session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? null;
}

/** An account made by the emailed sign-up link, so its address is proven. */
function provenUser(email: string, name: string, password: string) {
	const user = auth.createUser(email, name, password);
	auth.markEmailProven(user.id);
	return user;
}

function userCount(): number {
	return (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n;
}

describe('verifying an ID token', () => {
	const base = {
		jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
		issuers: [GOOGLE_ISS],
		audiences: ['zz-google-client'],
		nonce: 'n-1'
	};
	const claims = () => googleUser('n-1');

	it('accepts a token the provider signed for us with our nonce', async () => {
		const res = await jwt.verifyIdToken(token(claims()), base);
		expect(res.ok).toBe(true);
	});

	it.each([
		['another audience', { aud: 'someone-else' }, 'audience'],
		['another issuer', { iss: 'https://evil.example' }, 'issuer'],
		['an expired token', { exp: now() - 3600 }, 'expired'],
		['another nonce', { nonce: 'n-2' }, 'nonce'],
		['no subject', { sub: '' }, 'subject']
	])('refuses %s', async (_label, change, reason) => {
		const res = await jwt.verifyIdToken(token({ ...claims(), ...change }), base);
		expect(res).toEqual({ ok: false, reason });
	});

	it('refuses a signature from any other key, an unknown key and a swapped algorithm', async () => {
		expect(await jwt.verifyIdToken(token(claims(), { key: stranger }), base)).toEqual({
			ok: false,
			reason: 'signature'
		});
		expect(await jwt.verifyIdToken(token(claims(), { kid: 'k9' }), base)).toEqual({
			ok: false,
			reason: 'unknown key'
		});
		expect(await jwt.verifyIdToken(token(claims(), { alg: 'HS256' }), base)).toEqual({
			ok: false,
			reason: 'algorithm'
		});
		expect(await jwt.verifyIdToken('not.a.token', base)).toEqual({
			ok: false,
			reason: 'malformed'
		});
	});
});

describe('which providers are offered', () => {
	it('reports what is configured', async () => {
		const res = await call('/api/auth/providers');
		expect(await res.json()).toEqual({ google: true, apple: true, appleNative: true });
	});
});

describe('Google in the browser', () => {
	it('sends the browser to Google with state, nonce and PKCE', async () => {
		const s = await start('google', 'client=web');
		expect(s.location.origin + s.location.pathname).toBe(
			'https://accounts.google.com/o/oauth2/v2/auth'
		);
		expect(s.location.searchParams.get('redirect_uri')).toBe(
			'http://app.test/api/auth/google/callback'
		);
		expect(s.location.searchParams.get('code_challenge_method')).toBe('S256');
		expect(s.cookie).toBe(`oauth_state=${s.state}`);
	});

	it('creates a passwordless account, signs it in and goes to the page it came from', async () => {
		const s = await start('google', 'client=web&next=/trips/abc&tz=Europe/Athens');
		googleClaims = googleUser(s.nonce);
		const res = await googleCallback(s.state, s.cookie);
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('http://app.test/trips/abc');
		expect(lastTokenRequest?.get('code_verifier')).toBeTruthy();

		const session = sessionFrom(res);
		const user = auth.getSessionUser(session!);
		expect(user).toMatchObject({
			email: 'ada@example.test',
			name: 'Ada Lovelace',
			homeTz: 'Europe/Athens'
		});
		expect(auth.verifyUserPassword(user!.id, '')).toBe(false);
	});

	it('signs into the existing account with that verified email, and keeps its password', async () => {
		const existing = provenUser('ada@example.test', 'Ada', 'pw123456');
		const s = await start('google', 'client=web');
		googleClaims = googleUser(s.nonce);
		const res = await googleCallback(s.state, s.cookie);
		expect(auth.getSessionUser(sessionFrom(res)!)?.id).toBe(existing.id);
		expect(userCount()).toBe(1);
		expect(auth.verifyUserPassword(existing.id, 'pw123456')).toBe(true);

		// Linked by Google's id from now on, so a changed Google email still lands here.
		const again = await start('google', 'client=web');
		googleClaims = googleUser(again.nonce, { email: 'ada.l@example.test' });
		const second = await googleCallback(again.state, again.cookie);
		expect(auth.getSessionUser(sessionFrom(second)!)?.id).toBe(existing.id);
	});

	it('refuses an email Google has not verified', async () => {
		provenUser('ada@example.test', 'Ada', 'pw123456');
		const s = await start('google', 'client=web');
		googleClaims = googleUser(s.nonce, { email_verified: false });
		const res = await googleCallback(s.state, s.cookie);
		expect(sessionFrom(res)).toBeNull();
		expect(res.headers.get('location')).toBe('http://app.test/login?authError=no-email');
	});

	it('will not link to an account whose own address was never proven', async () => {
		// Registered with no mail provider: anyone could have typed this address.
		const squatter = auth.createUser('ada@example.test', 'Not Ada', 'pw123456');
		const s = await start('google', 'client=web');
		googleClaims = googleUser(s.nonce);
		const res = await googleCallback(s.state, s.cookie);
		expect(sessionFrom(res)).toBeNull();
		expect(res.headers.get('location')).toBe('http://app.test/login?authError=log-in-first');
		expect(db.prepare(`SELECT COUNT(*) AS n FROM oauth_identities`).get()).toEqual({ n: 0 });

		// A password reset proves the address; the link is allowed after it.
		auth.markEmailProven(squatter.id);
		const again = await start('google', 'client=web');
		googleClaims = googleUser(again.nonce);
		const linked = await googleCallback(again.state, again.cookie);
		expect(auth.getSessionUser(sessionFrom(linked)!)?.id).toBe(squatter.id);
	});

	it('stops proving an address once it changes without a link', async () => {
		const user = provenUser('ada@example.test', 'Ada', 'pw123456');
		auth.applyEmailChange(user.id, 'ada.new@example.test');
		const s = await start('google', 'client=web');
		googleClaims = googleUser(s.nonce, { email: 'ada.new@example.test' });
		const res = await googleCallback(s.state, s.cookie);
		expect(res.headers.get('location')).toBe('http://app.test/login?authError=log-in-first');
	});

	it("refuses a callback without this browser's cookie, and a state used twice", async () => {
		const s = await start('google', 'client=web');
		googleClaims = googleUser(s.nonce);
		const forged = await googleCallback(s.state, 'oauth_state=someone-else');
		expect(sessionFrom(forged)).toBeNull();
		expect(forged.headers.get('location')).toBe('http://app.test/login?authError=expired');
		// The state was spent by that attempt.
		const replay = await googleCallback(s.state, s.cookie);
		expect(sessionFrom(replay)).toBeNull();
	});

	it('refuses a token minted for another sign-in', async () => {
		const s = await start('google', 'client=web');
		googleClaims = googleUser('some-other-nonce');
		const res = await googleCallback(s.state, s.cookie);
		expect(sessionFrom(res)).toBeNull();
		expect(userCount()).toBe(0);
	});

	it('goes quietly back to log in when the person cancels at Google', async () => {
		const s = await start('google', 'client=web');
		const res = await call(`/api/auth/google/callback?state=${s.state}&error=access_denied`, {
			headers: { cookie: s.cookie }
		});
		expect(res.headers.get('location')).toBe('http://app.test/login');
	});

	it('only returns to a path on this site', async () => {
		const s = await start('google', 'client=web&next=//evil.example');
		googleClaims = googleUser(s.nonce);
		const res = await googleCallback(s.state, s.cookie);
		expect(res.headers.get('location')).toBe('http://app.test/trips');
	});

	it('gives a new account the trips it was invited to', async () => {
		const organizer = auth.createUser('org@example.test', 'Org', 'pw123456');
		const tripId = trips.createTrip(organizer.id, {
			name: 'ZZ Invite Trip',
			startDate: '2026-10-10',
			endDate: '2026-10-12',
			homeCurrency: 'USD'
		}).id!;
		members.addPerson(tripId, organizer.id, 'Ada', 'ada@example.test');
		const s = await start('google', 'client=web');
		googleClaims = googleUser(s.nonce);
		const res = await googleCallback(s.state, s.cookie);
		const user = auth.getSessionUser(sessionFrom(res)!)!;
		expect(trips.getTripForUser(tripId, user.id)).toBeTruthy();
	});
});

describe('Google in the app', () => {
	const returnUrl = 'exp://192.168.1.121:8081/--/auth';

	it('hands the app a one-time code for its session token', async () => {
		const s = await start('google', `client=native&redirect=${encodeURIComponent(returnUrl)}`);
		googleClaims = googleUser(s.nonce);
		const res = await googleCallback(s.state, s.cookie);
		const back = new URL(res.headers.get('location')!);
		expect(`${back.protocol}//${back.host}${back.pathname}`).toBe(returnUrl);
		expect(sessionFrom(res)).toBeNull();

		const code = back.searchParams.get('code')!;
		const exchange = () =>
			call('/api/auth/exchange', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-trippy-client': 'native' },
				body: JSON.stringify({ code })
			});
		const first = await exchange();
		expect(first.status).toBe(200);
		const json = (await first.json()) as { token: string; user: { email: string } };
		expect(json.user.email).toBe('ada@example.test');
		expect(auth.getSessionUser(json.token)?.email).toBe('ada@example.test');
		expect((await exchange()).status).toBe(401);
	});

	it('sends a refused sign-in back to the app, not to the website', async () => {
		const s = await start('google', `client=native&redirect=${encodeURIComponent(returnUrl)}`);
		googleClaims = googleUser(s.nonce);
		const res = await googleCallback(s.state, 'oauth_state=another-browser');
		expect(res.headers.get('location')).toBe(`${returnUrl}?error=expired`);
	});

	it("sends a code only to the app's own links, and never to Expo Go in production", async () => {
		const refused = await call(
			`/api/auth/google/start?client=native&redirect=${encodeURIComponent('https://evil.example/x')}`
		);
		expect(refused.status).toBe(400);
		process.env.NODE_ENV = 'production';
		const expo = await call(
			`/api/auth/google/start?client=native&redirect=${encodeURIComponent(returnUrl)}`
		);
		expect(expo.status).toBe(400);
		const own = await call(
			`/api/auth/google/start?client=native&redirect=${encodeURIComponent('trippy://auth')}`
		);
		expect(own.status).toBe(302);
	});
});

describe('Apple in the browser', () => {
	it('takes the posted token and the first-sign-in name', async () => {
		const s = await start('apple', 'client=web');
		expect(s.location.searchParams.get('response_mode')).toBe('form_post');
		const form = new URLSearchParams({
			state: s.state,
			code: 'zz',
			id_token: token({
				iss: APPLE_ISS,
				aud: 'zz.apple.web',
				sub: 'a-1',
				email: 'relay@privaterelay.appleid.com',
				email_verified: 'true',
				iat: now(),
				exp: now() + 600,
				nonce: s.nonce
			}),
			user: JSON.stringify({ name: { firstName: 'Grace', lastName: 'Hopper' } })
		});
		const res = await call('/api/auth/apple/callback', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: s.cookie },
			body: form.toString()
		});
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('http://app.test/trips');
		expect(auth.getSessionUser(sessionFrom(res)!)).toMatchObject({
			name: 'Grace Hopper',
			email: 'relay@privaterelay.appleid.com'
		});
	});
});

describe('Apple in the iOS app', () => {
	async function nativeSignIn(aud: string, nonce?: string) {
		const issued = (
			(await (await call('/api/auth/apple/nonce', { method: 'POST' })).json()) as {
				nonce: string;
			}
		).nonce;
		const identityToken = token({
			iss: APPLE_ISS,
			aud,
			sub: 'a-2',
			email: 'grace@example.test',
			email_verified: true,
			iat: now(),
			exp: now() + 600,
			nonce: nonce ?? issued
		});
		return {
			issued,
			send: () =>
				call('/api/auth/apple/native', {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'x-trippy-client': 'native' },
					body: JSON.stringify({
						identityToken,
						nonce: issued,
						name: 'Grace',
						homeTz: 'Asia/Tokyo'
					})
				})
		};
	}

	it('signs in with a token for our app and a nonce we issued, once', async () => {
		const attempt = await nativeSignIn('com.trippy.app');
		const res = await attempt.send();
		expect(res.status).toBe(200);
		const json = (await res.json()) as { token: string };
		expect(auth.getSessionUser(json.token)).toMatchObject({ name: 'Grace', homeTz: 'Asia/Tokyo' });
		expect((await attempt.send()).status).toBe(401);
	});

	it('takes Expo Go tokens outside production only', async () => {
		expect((await (await nativeSignIn('host.exp.Exponent')).send()).status).toBe(200);
		process.env.NODE_ENV = 'production';
		expect((await (await nativeSignIn('host.exp.Exponent')).send()).status).toBe(401);
	});

	it('refuses a token carrying some other nonce', async () => {
		const attempt = await nativeSignIn('com.trippy.app', 'not-ours');
		expect((await attempt.send()).status).toBe(401);
		expect(userCount()).toBe(0);
	});
});

describe('a nonce is not a state', () => {
	it('answers an Apple app nonce posing as a callback state like any unknown state', async () => {
		const { nonce } = (await (await call('/api/auth/apple/nonce', { method: 'POST' })).json()) as {
			nonce: string;
		};
		const google = await call(`/api/auth/google/callback?state=${nonce}&code=x`, {
			headers: { cookie: `oauth_state=${nonce}` }
		});
		expect(google.status).toBe(302);
		expect(google.headers.get('location')).toBe('http://app.test/login?authError=expired');
		const apple = await call('/api/auth/apple/callback', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ state: nonce, id_token: 'x' }).toString()
		});
		expect(apple.status).toBe(303);
		expect(apple.headers.get('location')).toBe('http://app.test/login?authError=expired');
	});
});

describe('starting sign-ins', () => {
	it('stops a caller who starts far more than a person would', async () => {
		for (let i = 0; i < 31; i++) {
			const res = await call('/api/auth/google/start?client=web');
			expect(res.headers.get('location')).toContain('accounts.google.com');
		}
		const blocked = await call('/api/auth/google/start?client=web');
		expect(blocked.headers.get('location')).toBe('http://app.test/login?authError=throttled');
	});
});

describe('a passwordless account', () => {
	it('cannot be signed into with an empty password', async () => {
		const s = await start('google', 'client=web');
		googleClaims = googleUser(s.nonce);
		await googleCallback(s.state, s.cookie);
		const res = await call('/api/auth/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email: 'ada@example.test', password: '' })
		});
		expect(res.status).toBe(401);
	});

	it('is told how to set a password rather than that it typed the wrong one', async () => {
		const s = await start('google', 'client=web');
		googleClaims = googleUser(s.nonce);
		const res = await googleCallback(s.state, s.cookie);
		const user = auth.getSessionUser(sessionFrom(res)!)!;
		expect(auth.changePassword(user.id, 'anything', 'new-password-1')).toEqual({
			ok: false,
			error: auth.NO_PASSWORD_YET
		});
	});
});
