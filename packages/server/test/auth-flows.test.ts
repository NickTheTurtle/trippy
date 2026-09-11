import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Registration and password reset, both of which happen across two requests
 * with an emailed link in between.
 *
 * What the link is worth is the whole subject here: it stands in for the
 * password on one flow and for the mailbox on the other, so these cases pin
 * that it is single use, that it dies on time, that it is stored only as a
 * hash, and that spending a reset link ends every session the old password
 * could have opened.
 */

const tempRoot = join(tmpdir(), `trippy-authflow-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'authflow.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let auth: typeof import('../src/infra/auth.ts');
let tokens: typeof import('../src/infra/tokens.ts');
let trips: typeof import('../src/persistence/trips.ts');
let members: typeof import('../src/persistence/members.ts');
let events: typeof import('../src/events.ts');

beforeAll(async () => {
	[{ db }, auth, tokens, trips, members, events] = await Promise.all([
		import('../src/db.ts'),
		import('../src/infra/auth.ts'),
		import('../src/infra/tokens.ts'),
		import('../src/persistence/trips.ts'),
		import('../src/persistence/members.ts'),
		import('../src/events.ts')
	]);
});

beforeEach(() => {
	events.closeAll();
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
	db.prepare(`DELETE FROM pending_registrations`).run();
	db.prepare(`DELETE FROM password_resets`).run();
});

afterAll(() => {
	events.closeAll();
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

/** Push a row's expiry into the past without waiting for it. */
function expire(table: 'pending_registrations' | 'password_resets') {
	db.prepare(`UPDATE ${table} SET expires_at = ?`).run(Date.now() - 1);
}

describe('registration by emailed link', () => {
	it('writes nothing to users until the link is spent', () => {
		auth.startRegistration('new@example.test', 'New Person', 'hunter2hunter2');
		expect(auth.findUserByEmail('new@example.test')).toBeUndefined();
		expect(db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).toEqual({ n: 0 });
	});

	it('creates the account the link was issued for, once', () => {
		const { token } = auth.startRegistration('new@example.test', 'New Person', 'hunter2hunter2');
		const first = auth.completeRegistration(token);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.user.email).toBe('new@example.test');
		expect(first.user.name).toBe('New Person');

		// The password typed at the first step is the one that works, so the hash
		// really did survive the round trip rather than being reset to something.
		const user = auth.findUserByEmail('new@example.test')!;
		expect(auth.verifyPassword('hunter2hunter2', user.password_hash)).toBe(true);

		// Spent. A link that still worked would let anyone who saw the mail once
		// re-enter the account after the owner changed the password.
		expect(auth.completeRegistration(token).ok).toBe(false);
	});

	it('stores only a hash of the token', () => {
		const { token } = auth.startRegistration('new@example.test', 'New Person', 'hunter2hunter2');
		const row = db.prepare(`SELECT token_hash, password_hash FROM pending_registrations`).get() as {
			token_hash: string;
			password_hash: string;
		};
		expect(row.token_hash).not.toBe(token);
		expect(row.token_hash).toBe(tokens.hashToken(token));
		// The password is hashed at the first step too, so a pending row is not a
		// plaintext password sitting in a table waiting to be confirmed.
		expect(row.password_hash).not.toBe('hunter2hunter2');
	});

	it('refuses an expired link and does not leave it retryable', () => {
		const { token } = auth.startRegistration('new@example.test', 'New Person', 'hunter2hunter2');
		expire('pending_registrations');
		expect(auth.completeRegistration(token).ok).toBe(false);
		expect(db.prepare(`SELECT COUNT(*) AS n FROM pending_registrations`).get()).toEqual({ n: 0 });
		expect(auth.findUserByEmail('new@example.test')).toBeUndefined();
	});

	it('replaces an earlier attempt for the same address, invalidating its link', () => {
		const first = auth.startRegistration('new@example.test', 'First', 'hunter2hunter2');
		const second = auth.startRegistration('new@example.test', 'Second', 'correcthorse');
		expect(db.prepare(`SELECT COUNT(*) AS n FROM pending_registrations`).get()).toEqual({ n: 1 });
		expect(auth.completeRegistration(first.token).ok).toBe(false);
		const done = auth.completeRegistration(second.token);
		expect(done.ok && done.user.name).toBe('Second');
	});

	it('refuses when the address was claimed while the link was in the post', () => {
		const { token } = auth.startRegistration('new@example.test', 'New Person', 'hunter2hunter2');
		auth.createUser('new@example.test', 'Somebody Else', 'hunter2hunter2');
		const result = auth.completeRegistration(token);
		expect(result.ok).toBe(false);
		// The pending row is gone with it: retrying can never succeed, so leaving
		// it would be an expiry no one is waiting on.
		expect(db.prepare(`SELECT COUNT(*) AS n FROM pending_registrations`).get()).toEqual({ n: 0 });
		expect(auth.findUserByEmail('new@example.test')!.name).toBe('Somebody Else');
	});

	it('joins the trips the address was invited to', () => {
		const organizer = auth.createUser('org@example.test', 'Org', 'hunter2hunter2').id;
		const trip = trips.createTrip(organizer, {
			name: 'Kyoto',
			startDate: '2026-10-01',
			endDate: '2026-10-03',
			homeCurrency: 'USD'
		});
		expect(members.addPerson(trip.id, organizer, 'Guest', 'new@example.test')).toBe('invited');

		const { token } = auth.startRegistration('new@example.test', 'New Person', 'hunter2hunter2');
		const done = auth.completeRegistration(token);
		expect(done.ok).toBe(true);
		if (!done.ok) return;
		const roster = members.listPeople(trip.id);
		expect(roster.find((p) => p.id === done.user.id)).toBeTruthy();
		// The placeholder was relinked, not left beside the real account.
		expect(roster).toHaveLength(2);
	});
});

describe('password reset by emailed link', () => {
	function withUser() {
		const user = auth.createUser('who@example.test', 'Who', 'hunter2hunter2');
		return user;
	}

	it('says nothing about an address it has never seen', () => {
		expect(auth.startPasswordReset('nobody@example.test')).toBeNull();
	});

	it('refuses an address that belongs to a placeholder or a sample companion', () => {
		const organizer = auth.createUser('org@example.test', 'Org', 'hunter2hunter2').id;
		const trip = trips.createTrip(organizer, {
			name: 'Kyoto',
			startDate: '2026-10-01',
			endDate: '2026-10-03',
			homeCurrency: 'USD'
		});
		members.addPerson(trip.id, organizer, 'Guest', 'guest@example.test');
		// The placeholder's own row carries a synthetic address; the real one is on
		// the invite. Neither is a login, so neither can be reset into one.
		expect(auth.startPasswordReset('guest@example.test')).toBeNull();
	});

	it('changes the password and spends the link', () => {
		const user = withUser();
		const started = auth.startPasswordReset('who@example.test')!;
		expect(started.user.id).toBe(user.id);

		expect(auth.completePasswordReset(started.token, 'correcthorse')).toEqual({ ok: true });
		const after = auth.findUserByEmail('who@example.test')!;
		expect(auth.verifyPassword('correcthorse', after.password_hash)).toBe(true);
		expect(auth.verifyPassword('hunter2hunter2', after.password_hash)).toBe(false);

		expect(auth.completePasswordReset(started.token, 'thirdpassword').ok).toBe(false);
	});

	it('refuses a short password without spending the link', () => {
		withUser();
		const started = auth.startPasswordReset('who@example.test')!;
		expect(auth.completePasswordReset(started.token, 'short').ok).toBe(false);
		// Still usable: the refusal was about what was typed, not about the link,
		// and making them ask for a new mail over a typo would be punishing.
		expect(auth.completePasswordReset(started.token, 'correcthorse')).toEqual({ ok: true });
	});

	it('refuses an expired link and does not leave it retryable', () => {
		withUser();
		const started = auth.startPasswordReset('who@example.test')!;
		expire('password_resets');
		expect(auth.completePasswordReset(started.token, 'correcthorse').ok).toBe(false);
		expect(db.prepare(`SELECT COUNT(*) AS n FROM password_resets`).get()).toEqual({ n: 0 });
		const after = auth.findUserByEmail('who@example.test')!;
		expect(auth.verifyPassword('hunter2hunter2', after.password_hash)).toBe(true);
	});

	it('ends every session, not just the other ones', () => {
		const user = withUser();
		const a = auth.createSession(user.id);
		const b = auth.createSession(user.id);
		const started = auth.startPasswordReset('who@example.test')!;

		expect(auth.completePasswordReset(started.token, 'correcthorse')).toEqual({ ok: true });
		expect(auth.getSessionUser(a)).toBeNull();
		expect(auth.getSessionUser(b)).toBeNull();
	});

	it('voids any other reset already in flight for the same account', () => {
		withUser();
		const first = auth.startPasswordReset('who@example.test')!;
		const second = auth.startPasswordReset('who@example.test')!;
		expect(auth.completePasswordReset(second.token, 'correcthorse')).toEqual({ ok: true });
		// Otherwise an older mail, possibly the one that was intercepted, could
		// still overwrite the password that was just set.
		expect(auth.completePasswordReset(first.token, 'thirdpassword').ok).toBe(false);
	});
});

describe('pruning', () => {
	it('drops only the links that have run out', () => {
		auth.createUser('who@example.test', 'Who', 'hunter2hunter2');
		auth.startRegistration('old@example.test', 'Old', 'hunter2hunter2');
		auth.startPasswordReset('who@example.test');
		expire('pending_registrations');
		expire('password_resets');

		const live = auth.startRegistration('live@example.test', 'Live', 'hunter2hunter2');
		auth.pruneExpiredTokens();

		expect(db.prepare(`SELECT COUNT(*) AS n FROM pending_registrations`).get()).toEqual({ n: 1 });
		expect(db.prepare(`SELECT COUNT(*) AS n FROM password_resets`).get()).toEqual({ n: 0 });
		expect(auth.completeRegistration(live.token).ok).toBe(true);
	});
});

describe('tokens', () => {
	it('mints a different value every time', () => {
		const seen = new Set(Array.from({ length: 200 }, () => tokens.mintToken()));
		expect(seen.size).toBe(200);
	});

	it('compares hashes without leaking on length', () => {
		const a = tokens.hashToken('one');
		expect(tokens.tokenHashEquals(a, a)).toBe(true);
		expect(tokens.tokenHashEquals(a, tokens.hashToken('two'))).toBe(false);
		// A different length must answer false rather than throw, because the
		// value on one side of this comparison comes off the wire.
		expect(tokens.tokenHashEquals(a, 'short')).toBe(false);
	});
});
