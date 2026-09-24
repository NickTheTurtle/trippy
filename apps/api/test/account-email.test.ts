import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Changing the account email, and the registration answers around it.
 *
 * The bug this pins: `PATCH /account/profile` wrote any address straight into
 * `users.email` and then ran `consumeInvites`, so anyone signed in could type a
 * stranger's address and be handed every trip that stranger had been invited
 * to. An email change now needs the current password and, when mail is
 * configured, a link opened at the new address before anything moves.
 */

const tempRoot = join(tmpdir(), `trippy-api-account-email-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'api.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('@trippy/server/db')>['db'];
let auth: typeof import('@trippy/server/auth');
let trips: typeof import('@trippy/server/trips');
let members: typeof import('@trippy/server/members');
let throttle: typeof import('@trippy/server/throttle');
let app: Hono;

const PASSWORD = 'password123';

/** Mail sent through the stubbed provider, newest last. */
let sent: { to: string; subject: string; text: string }[] = [];

function mailOn() {
	process.env.MAIL_FROM = 'trips@example.test';
	process.env.RESEND_API_KEY = 'test-resend-key';
	delete process.env.AWS_ACCESS_KEY_ID;
	delete process.env.AWS_SECRET_ACCESS_KEY;
}

function mailOff() {
	delete process.env.MAIL_FROM;
	delete process.env.RESEND_API_KEY;
}

beforeAll(async () => {
	const [dbMod, authMod, tripsMod, membersMod, throttleMod, middleware, authRoutes, accountRoutes] =
		await Promise.all([
			import('@trippy/server/db'),
			import('@trippy/server/auth'),
			import('@trippy/server/trips'),
			import('@trippy/server/members'),
			import('@trippy/server/throttle'),
			import('../src/middleware.ts'),
			import('../src/routes/auth.ts'),
			import('../src/routes/account.ts')
		]);
	db = dbMod.db;
	auth = authMod;
	trips = tripsMod;
	members = membersMod;
	throttle = throttleMod;

	app = new Hono();
	app.use('*', middleware.session);
	app.route('/auth', authRoutes.auth as unknown as Hono);
	app.route('/account', accountRoutes.account as unknown as Hono);
});

beforeEach(() => {
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
	db.prepare(`DELETE FROM pending_email_changes`).run();
	db.prepare(`DELETE FROM pending_registrations`).run();
	throttle.resetThrottle();
	sent = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: unknown, init?: { body?: string }) => {
			const payload = JSON.parse(init?.body ?? '{}') as {
				to?: string[];
				subject?: string;
				text?: string;
			};
			sent.push({
				to: payload.to?.[0] ?? '',
				subject: payload.subject ?? '',
				text: payload.text ?? ''
			});
			return new Response('{}', { status: 200 });
		})
	);
	mailOff();
});

afterAll(() => {
	mailOff();
	vi.unstubAllGlobals();
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

function user(label: string) {
	const email = `${label}-${crypto.randomUUID()}@example.test`;
	const u = auth.createUser(email, label, PASSWORD);
	return { ...u, cookie: `session=${auth.createSession(u.id)}` };
}

function patchProfile(cookie: string, body: Record<string, unknown>) {
	return app.request('/account/profile', {
		method: 'PATCH',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify(body)
	});
}

/**
 * The node-server connection info `clientIp` reads, which `app.request` does
 * not supply by itself. One fixed address, so every per-IP limit here is one key.
 */
const CONN = {
	incoming: { socket: { remoteAddress: '203.0.113.5', remotePort: 40000, remoteFamily: 'IPv4' } }
};

function post(path: string, body: Record<string, unknown>) {
	return app.request(
		path,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		},
		CONN
	);
}

/** A trip somebody else organises, with an invite waiting at `email`. */
function inviteAt(email: string): string {
	const organizer = user('organizer');
	const tripId = trips.createTrip(organizer.id, {
		name: 'ZZ Invite Trip',
		startDate: '2026-10-01',
		endDate: '2026-10-03',
		homeCurrency: 'USD'
	}).id!;
	expect(members.addPerson(tripId, organizer.id, 'Invitee', email)).toBe('invited');
	return tripId;
}

function storedEmail(id: string): string {
	return (db.prepare(`SELECT email FROM users WHERE id = ?`).get(id) as { email: string }).email;
}

function tokenFrom(text: string): string {
	const match = /verify-email\?token=([A-Za-z0-9_%-]+)/.exec(text);
	expect(match, text).not.toBeNull();
	return decodeURIComponent(match![1]);
}

describe('changing the account email', () => {
	it('asks for the current password, and does not count a missing one as a guess', async () => {
		const me = user('me');
		const res = await patchProfile(me.cookie, { email: 'new@example.test' });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: 'Enter your current password to change your email.'
		});
		expect(storedEmail(me.id)).toBe(me.email);
	});

	it('refuses a wrong password, and throttles it on the password-change key', async () => {
		const me = user('me');
		for (let i = 0; i < 6; i++) {
			const res = await patchProfile(me.cookie, {
				email: 'new@example.test',
				currentPassword: 'wrong-password'
			});
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'Your current password is incorrect.' });
		}
		const blocked = await patchProfile(me.cookie, {
			email: 'new@example.test',
			currentPassword: PASSWORD
		});
		expect(blocked.status).toBe(429);
		expect(blocked.headers.get('retry-after')).toBeTruthy();
		// The same key POST /account/password counts on, so the two endpoints do
		// not add up to twice the guesses.
		expect(throttle.retryAfterMs(`password:${me.id}`)).toBeGreaterThan(0);
		expect(storedEmail(me.id)).toBe(me.email);
	});

	it('does not ask for a password when the address only differs in case', async () => {
		const me = user('me');
		const res = await patchProfile(me.cookie, { email: me.email.toUpperCase(), name: 'Renamed' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, pendingEmail: null });
		expect(storedEmail(me.id)).toBe(me.email);
	});

	it('refuses an address that already has an account, only after the password', async () => {
		const me = user('me');
		const other = user('other');
		const noPassword = await patchProfile(me.cookie, { email: other.email });
		expect((await noPassword.json()).error).toBe(
			'Enter your current password to change your email.'
		);
		const res = await patchProfile(me.cookie, { email: other.email, currentPassword: PASSWORD });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'That email is already registered.' });
	});

	it('changes nothing at all when the email part is refused', async () => {
		const me = user('me');
		await patchProfile(me.cookie, {
			name: 'Should Not Stick',
			email: 'new@example.test',
			currentPassword: 'wrong-password'
		});
		const row = db.prepare(`SELECT name FROM users WHERE id = ?`).get(me.id) as { name: string };
		expect(row.name).toBe('me');
	});

	describe('with mail configured', () => {
		beforeEach(() => mailOn());

		it('parks the change, mails the new address, and hands over no invites yet', async () => {
			const me = user('me');
			const target = `target-${crypto.randomUUID()}@example.test`;
			const tripId = inviteAt(target);

			const res = await patchProfile(me.cookie, {
				name: 'New Name',
				homeTz: 'Europe/Athens',
				email: target,
				currentPassword: PASSWORD
			});
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ ok: true, pendingEmail: target });

			// The address has not moved, and nothing followed it.
			expect(storedEmail(me.id)).toBe(me.email);
			expect(trips.getTripForUser(tripId, me.id)).toBeNull();
			// The rest of the form still saved.
			const row = db.prepare(`SELECT name, home_tz FROM users WHERE id = ?`).get(me.id) as {
				name: string;
				home_tz: string;
			};
			expect(row).toEqual({ name: 'New Name', home_tz: 'Europe/Athens' });

			// The link went to the NEW address and points at the web route.
			expect(sent).toHaveLength(1);
			expect(sent[0].to).toBe(target);
			expect(sent[0].text).toContain('/verify-email?token=');

			const account = await app.request('/account', { headers: { cookie: me.cookie } });
			expect((await account.json()).profile.pendingEmail).toBe(target);
		});

		it('applies the change and the invites only when the link is opened', async () => {
			const me = user('me');
			const target = `target-${crypto.randomUUID()}@example.test`;
			const tripId = inviteAt(target);
			await patchProfile(me.cookie, { email: target, currentPassword: PASSWORD });
			const token = tokenFrom(sent[0].text);

			const res = await post('/auth/verify-email', { token });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
			expect(storedEmail(me.id)).toBe(target);
			expect(trips.getTripForUser(tripId, me.id)).not.toBeNull();

			// Spent: the same link does nothing twice.
			const again = await post('/auth/verify-email', { token });
			expect(again.status).toBe(400);
			expect((await again.json()).error).toBe('That link is no longer valid. Ask for a new one.');
		});

		it('re-checks the address when the link is opened', async () => {
			const me = user('me');
			const target = `target-${crypto.randomUUID()}@example.test`;
			await patchProfile(me.cookie, { email: target, currentPassword: PASSWORD });
			const token = tokenFrom(sent[0].text);
			// Somebody registered the address while the link was in the post.
			auth.createUser(target, 'Faster', PASSWORD);

			const res = await post('/auth/verify-email', { token });
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe('That email is already registered.');
			expect(storedEmail(me.id)).toBe(me.email);
		});

		it('refuses an expired link and a made-up one', async () => {
			const me = user('me');
			await patchProfile(me.cookie, { email: 'late@example.test', currentPassword: PASSWORD });
			const token = tokenFrom(sent[0].text);
			db.prepare(`UPDATE pending_email_changes SET expires_at = ?`).run(Date.now() - 1);

			expect((await post('/auth/verify-email', { token })).status).toBe(400);
			expect((await post('/auth/verify-email', { token: 'not-a-token' })).status).toBe(400);
			expect((await post('/auth/verify-email', {})).status).toBe(400);
			expect(storedEmail(me.id)).toBe(me.email);
		});

		it('replaces an earlier request, voiding its link', async () => {
			const me = user('me');
			await patchProfile(me.cookie, { email: 'first@example.test', currentPassword: PASSWORD });
			const first = tokenFrom(sent[0].text);
			await patchProfile(me.cookie, { email: 'second@example.test', currentPassword: PASSWORD });
			const second = tokenFrom(sent[1].text);

			expect((await post('/auth/verify-email', { token: first })).status).toBe(400);
			expect((await post('/auth/verify-email', { token: second })).status).toBe(200);
			expect(storedEmail(me.id)).toBe('second@example.test');
		});
	});

	describe('with no mail provider', () => {
		it('applies the change at once, invites included, as registration would', async () => {
			const me = user('me');
			const target = `target-${crypto.randomUUID()}@example.test`;
			const tripId = inviteAt(target);
			const res = await patchProfile(me.cookie, { email: target, currentPassword: PASSWORD });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, pendingEmail: null });
			expect(storedEmail(me.id)).toBe(target);
			expect(trips.getTripForUser(tripId, me.id)).not.toBeNull();
			expect(sent).toHaveLength(0);
		});
	});

	it('holds name and zone to the shared rules', async () => {
		const me = user('me');
		expect((await patchProfile(me.cookie, { name: 'x'.repeat(201) })).status).toBe(400);
		const zone = await patchProfile(me.cookie, { homeTz: 'Mars/Olympus_Mons' });
		expect(zone.status).toBe(400);
		expect((await zone.json()).error).toBe('Pick a time zone from the list.');
		expect((await patchProfile(me.cookie, { homeTz: 'UTC' })).status).toBe(200);
	});
});

describe('registration', () => {
	function register(email: string, name = 'New Person') {
		return post('/auth/register', { email, name, password: PASSWORD });
	}

	it('answers a taken address with the same 202 as a fresh one when mail is on', async () => {
		mailOn();
		const existing = user('existing');
		const fresh = `fresh-${crypto.randomUUID()}@example.test`;

		const taken = await register(existing.email);
		const free = await register(fresh);
		expect(taken.status).toBe(202);
		expect(free.status).toBe(202);
		expect(await taken.json()).toEqual({ pending: true, email: existing.email });
		expect(await free.json()).toEqual({ pending: true, email: fresh });

		// Only the fresh address was mailed; the owner of the taken one got nothing.
		await vi.waitFor(() => expect(sent.map((m) => m.to)).toEqual([fresh]));
	});

	it('keeps the 409 when no mail provider is configured', async () => {
		const existing = user('existing');
		const res = await register(existing.email);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'That email is already registered.' });
	});

	it('counts every attempt from an address, the refused ones included', async () => {
		const existing = user('existing');
		for (let i = 0; i < throttle.REGISTER_ATTEMPTS + 1; i++) {
			expect((await register(existing.email)).status).toBe(409);
		}
		expect((await register(`late-${crypto.randomUUID()}@example.test`)).status).toBe(429);
	});

	it('does not spend the budget on form mistakes', async () => {
		for (let i = 0; i < throttle.REGISTER_ATTEMPTS + 2; i++) {
			expect((await post('/auth/register', { email: 'nope', name: 'N', password: PASSWORD })).status).toBe(
				400
			);
		}
		expect((await register(`fixed-${crypto.randomUUID()}@example.test`)).status).toBe(201);
	});

	it('mails any one address only a few times before backing off', async () => {
		mailOn();
		const target = `target-${crypto.randomUUID()}@example.test`;
		for (let i = 0; i < 4; i++) expect((await register(target)).status).toBe(202);
		const res = await register(target);
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBeTruthy();
	});

	it('holds the name to the shared length', async () => {
		const res = await register(`long-${crypto.randomUUID()}@example.test`, 'x'.repeat(201));
		expect(res.status).toBe(400);
	});

	it("starts the account on the browser's zone, and on UTC for anything unreal", async () => {
		const zoned = `zoned-${crypto.randomUUID()}@example.test`;
		const res = await post('/auth/register', {
			email: zoned,
			name: 'Zoned',
			password: PASSWORD,
			homeTz: 'America/Argentina/Buenos_Aires'
		});
		expect(res.status).toBe(201);
		expect(auth.findUserByEmail(zoned)?.home_tz).toBe('America/Argentina/Buenos_Aires');

		const bogus = `bogus-${crypto.randomUUID()}@example.test`;
		expect(
			(await post('/auth/register', { email: bogus, name: 'B', password: PASSWORD, homeTz: 'Mars/Base' }))
				.status
		).toBe(201);
		expect(auth.findUserByEmail(bogus)?.home_tz).toBe('UTC');
	});

	it('carries the zone through the emailed link', async () => {
		mailOn();
		const email = `linked-${crypto.randomUUID()}@example.test`;
		const { token } = auth.startRegistration(email, 'Linked', PASSWORD, 'Asia/Tokyo');
		const done = auth.completeRegistration(token);
		expect(done.ok && done.user.homeTz).toBe('Asia/Tokyo');
	});
});

describe('login', () => {
	it('answers a missing account and a wrong password identically', async () => {
		const me = user('me');
		const missing = await post('/auth/login', {
			email: 'nobody@example.test',
			password: PASSWORD
		});
		const wrong = await post('/auth/login', { email: me.email, password: 'wrong-password' });
		expect(missing.status).toBe(401);
		expect(wrong.status).toBe(401);
		expect(await missing.json()).toEqual(await wrong.json());
	});
});
