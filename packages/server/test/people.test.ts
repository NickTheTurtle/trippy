import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Adding somebody to a trip by name, with an address only if they will use the
 * app, and editing that address afterwards.
 *
 * The address lives in two places at once, `trip_invites.email` and the
 * `placeholder:<email>` hash, so most of what is pinned here is that they never
 * disagree: an invite that the two halves describe differently is one that
 * cannot be revoked, or one that a registration will never consume.
 */

const tempRoot = join(tmpdir(), `trippy-people-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'people.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let auth: typeof import('../src/infra/auth.ts');
let trips: typeof import('../src/persistence/trips.ts');
let members: typeof import('../src/persistence/members.ts');
let events: typeof import('../src/events.ts');

beforeAll(async () => {
	[{ db }, auth, trips, members, events] = await Promise.all([
		import('../src/db.ts'),
		import('../src/infra/auth.ts'),
		import('../src/persistence/trips.ts'),
		import('../src/persistence/members.ts'),
		import('../src/events.ts')
	]);
});

let organizer: string;
let other: string;
let tripId: string;

beforeEach(() => {
	events.closeAll();
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
	organizer = auth.createUser('org@example.test', 'Org', 'hunter2hunter2').id;
	other = auth.createUser('other@example.test', 'Other', 'hunter2hunter2').id;
	tripId = trips.createTrip(organizer, {
		name: 'Kyoto',
		startDate: '2026-10-01',
		endDate: '2026-10-03',
		homeCurrency: 'USD'
	}).id!;
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

const find = (name: string) => members.listPeople(tripId).find((p) => p.name === name)!;

describe('adding a person', () => {
	it('takes a name with no address at all', () => {
		expect(members.addPerson(tripId, organizer, 'Mum', '')).toBe('created');
		const person = find('Mum');
		expect(person.placeholder).toBe(true);
		// Nothing to show and nothing to send: the synthetic address the row
		// carries is an index detail, not something a reader should ever see.
		expect(person.email).toBe('');
		expect(person.invitedEmail).toBeNull();
		expect(db.prepare(`SELECT COUNT(*) AS n FROM trip_invites`).get()).toEqual({ n: 0 });
	});

	it('keeps the name the organizer typed rather than guessing one', () => {
		expect(members.addPerson(tripId, organizer, 'Jay', 'jamie.lee@example.test')).toBe('invited');
		// The old behaviour would have produced "Jamie Lee" from the address.
		expect(find('Jay').invitedEmail).toBe('jamie.lee@example.test');
	});

	it('adds a registered account outright and ignores the typed name', () => {
		expect(members.addPerson(tripId, organizer, 'Not Their Name', 'other@example.test')).toBe(
			'added'
		);
		// Their name is their account's, shared with every other trip they are on.
		expect(find('Other').id).toBe(other);
		expect(db.prepare(`SELECT COUNT(*) AS n FROM trip_invites`).get()).toEqual({ n: 0 });
	});

	it('refuses a blank name, an overlong one, and a malformed address', () => {
		expect(members.addPerson(tripId, organizer, '   ', 'a@example.test')).toBe('invalid');
		// The shared name ceiling (200), not the old private 80: the route checks
		// the same limit first, so the two cannot disagree about one name.
		expect(members.addPerson(tripId, organizer, 'x'.repeat(201), '')).toBe('invalid');
		expect(members.addPerson(tripId, organizer, 'Jay', 'nope')).toBe('invalid');
		expect(members.listPeople(tripId)).toHaveLength(1);
	});

	it('refuses anyone but the organizer', () => {
		members.addPerson(tripId, organizer, 'Other', 'other@example.test');
		expect(members.addPerson(tripId, other, 'Mum', '')).toBe('forbidden');
	});

	it('refuses a second invite to the same address but allows a repeated name', () => {
		expect(members.addPerson(tripId, organizer, 'Jay', 'jay@example.test')).toBe('invited');
		expect(members.addPerson(tripId, organizer, 'Jay', 'jay@example.test')).toBe('exists');
		// Two people called Jay on one trip is a fact about the world, not a
		// conflict: nothing keys off the name.
		expect(members.addPerson(tripId, organizer, 'Jay', '')).toBe('created');
	});
});

describe('editing an invited address', () => {
	function invited(name = 'Jay', email = 'jay@example.test') {
		members.addPerson(tripId, organizer, name, email);
		return find(name).id;
	}

	it('moves both halves of the address together', () => {
		const id = invited();
		expect(members.setMemberEmail(tripId, organizer, id, 'NEW@Example.test')).toBe('ok');
		expect(find('Jay').invitedEmail).toBe('new@example.test');
		const hash = db.prepare(`SELECT password_hash AS h FROM users WHERE id = ?`).get(id) as {
			h: string;
		};
		expect(hash.h).toBe('placeholder:new@example.test');
	});

	it('lets a registration at the new address consume the invite', () => {
		const id = invited();
		members.setMemberEmail(tripId, organizer, id, 'new@example.test');
		const { token } = auth.startRegistration('new@example.test', 'Jay', 'hunter2hunter2');
		const done = auth.completeRegistration(token);
		expect(done.ok).toBe(true);
		// One person on the roster, not a placeholder beside a real account.
		expect(members.listPeople(tripId)).toHaveLength(2);
		expect(find('Jay').placeholder).toBe(false);
	});

	it('clears the address on an empty value and drops the invite with it', () => {
		const id = invited();
		expect(members.setMemberEmail(tripId, organizer, id, '  ')).toBe('cleared');
		expect(find('Jay').invitedEmail).toBeNull();
		expect(db.prepare(`SELECT COUNT(*) AS n FROM trip_invites`).get()).toEqual({ n: 0 });
	});

	it('accepts the address it already has, which is how an invite is re-sent', () => {
		const id = invited();
		expect(members.setMemberEmail(tripId, organizer, id, 'jay@example.test')).toBe('ok');
		expect(find('Jay').invitedEmail).toBe('jay@example.test');
		expect(db.prepare(`SELECT COUNT(*) AS n FROM trip_invites`).get()).toEqual({ n: 1 });
	});

	it('refuses another invite on this trip', () => {
		const id = invited();
		invited('Kim', 'kim@example.test');
		expect(members.setMemberEmail(tripId, organizer, id, 'kim@example.test')).toBe('taken');
		expect(find('Jay').invitedEmail).toBe('jay@example.test');
	});

	it('refuses a malformed address', () => {
		const id = invited();
		expect(members.setMemberEmail(tripId, organizer, id, 'nope')).toBe('invalid');
		expect(find('Jay').invitedEmail).toBe('jay@example.test');
	});

	it('refuses anyone but the organizer', () => {
		const id = invited();
		members.addPerson(tripId, organizer, 'Other', 'other@example.test');
		expect(members.setMemberEmail(tripId, other, id, 'new@example.test')).toBe('forbidden');
	});

	it('refuses a registered member and a seeded companion', () => {
		members.addPerson(tripId, organizer, 'Other', 'other@example.test');
		// A registered person's address is their login, shared with every trip.
		expect(members.setMemberEmail(tripId, organizer, other, 'new@example.test')).toBe('forbidden');
		expect(members.setMemberEmail(tripId, organizer, organizer, 'new@example.test')).toBe(
			'forbidden'
		);
	});

	it('refuses somebody who is not on this trip', () => {
		const otherTrip = trips.createTrip(organizer, {
			name: 'Oslo',
			startDate: '2026-11-01',
			endDate: '2026-11-03',
			homeCurrency: 'USD'
		}).id!;
		members.addPerson(otherTrip, organizer, 'Jay', 'jay@example.test');
		const elsewhere = members.listPeople(otherTrip).find((p) => p.name === 'Jay')!.id;
		expect(members.setMemberEmail(tripId, organizer, elsewhere, 'new@example.test')).toBe(
			'missing'
		);
	});
});

/**
 * Pointing a stand-in at somebody who is already using the app.
 *
 * This used to be refused, which left the organizer holding a member they could
 * not name correctly: the address belonged to an account, so it could not be
 * saved, and the only way out was to delete the stand-in and lose what it was
 * carrying. It is now the same handover a registration performs, run at once.
 */
describe('absorbing a placeholder into a registered account', () => {
	function invited(name = 'Jay', email = 'jay@example.test') {
		members.addPerson(tripId, organizer, name, email);
		return find(name).id;
	}

	it('puts the real person on the trip and takes the stand-in off it', () => {
		const id = invited();
		expect(members.setMemberEmail(tripId, organizer, id, 'Other@Example.test')).toBe('merged');
		const people = members.listPeople(tripId);
		expect(people).toHaveLength(2);
		expect(people.find((p) => p.id === id)).toBeUndefined();
		// Their own account's name, not the one the organizer typed for the
		// stand-in: a name shared across trips is not this trip's to set.
		expect(find('Other').id).toBe(other);
		// The invite went with the placeholder. Nobody is waiting to register.
		expect(db.prepare(`SELECT COUNT(*) AS n FROM trip_invites`).get()).toEqual({ n: 0 });
		expect(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE id = ?`).get(id)).toEqual({ n: 0 });
	});

	it('carries what the stand-in was holding across', () => {
		const id = invited();
		const expenseId = randomUUID();
		db.prepare(
			`INSERT INTO expenses (id, trip_id, payer_id, description, amount_cents, currency, created_at)
			 VALUES (?, ?, ?, 'Taxi', 1000, 'USD', ?)`
		).run(expenseId, tripId, id, Date.now());
		db.prepare(`INSERT INTO expense_participants (expense_id, user_id) VALUES (?, ?)`).run(
			expenseId,
			id
		);

		expect(members.setMemberEmail(tripId, organizer, id, 'other@example.test')).toBe('merged');
		expect(db.prepare(`SELECT payer_id AS p FROM expenses WHERE id = ?`).get(expenseId)).toEqual({
			p: other
		});
		expect(
			db
				.prepare(`SELECT user_id AS u FROM expense_participants WHERE expense_id = ?`)
				.get(expenseId)
		).toEqual({ u: other });
	});

	it('merges into an account that is already on the trip without doubling it', () => {
		const id = invited();
		members.addPerson(tripId, organizer, 'Other', 'other@example.test');
		expect(members.listPeople(tripId)).toHaveLength(3);
		expect(members.setMemberEmail(tripId, organizer, id, 'other@example.test')).toBe('merged');
		expect(members.listPeople(tripId)).toHaveLength(2);
	});

	// The organizer's own role outranks the stand-in's, and a merge is not a
	// demotion: the membership row that survives has to be theirs.
	it('leaves the surviving membership role alone', () => {
		const id = invited();
		expect(members.setMemberEmail(tripId, organizer, id, 'org@example.test')).toBe('merged');
		const role = db
			.prepare(`SELECT role AS r FROM memberships WHERE trip_id = ? AND user_id = ?`)
			.get(tripId, organizer);
		expect(role).toEqual({ r: 'organizer' });
	});
});

describe('removing a person added by name alone', () => {
	it('deletes them outright when they are on no expense', () => {
		members.addPerson(tripId, organizer, 'Mum', '');
		const id = find('Mum').id;
		expect(members.removeMember(tripId, organizer, id)).toBe(true);
		expect(members.listPeople(tripId)).toHaveLength(1);
		expect(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE id = ?`).get(id)).toEqual({ n: 0 });
	});
});
