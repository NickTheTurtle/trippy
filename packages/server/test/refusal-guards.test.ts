import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * An organizer-only refusal that only the persistence layer can enforce, and
 * that nothing else pins.
 *
 * `leaveTrip` is a member walking away: everyone but the organizer may, because
 * the organizer leaving would orphan the trip. It returns a plain boolean, so it
 * is pinned here at the layer that decides, not through the browser.
 */

const tempRoot = join(tmpdir(), `trippy-refusal-guards-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'refusal-guards.test.db');
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
let member: string;
let tripId: string;

beforeEach(() => {
	events.closeAll();
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
	organizer = auth.createUser('org@example.test', 'Org', 'hunter2hunter2').id;
	member = auth.createUser('member@example.test', 'Member', 'hunter2hunter2').id;
	tripId = trips.createTrip(organizer, {
		name: 'Kyoto',
		startDate: '2026-10-01',
		endDate: '2026-10-03',
		homeCurrency: 'USD'
	}).id!;
	expect(members.addPerson(tripId, organizer, 'Member', auth.findUserById(member)!.email)).toBe(
		'added'
	);

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

describe('leaveTrip refuses the organizer', () => {
	const isMember = (userId: string): boolean =>
		db.prepare(`SELECT 1 FROM memberships WHERE trip_id = ? AND user_id = ?`).get(tripId, userId) !==
		undefined;

	it('refuses the organizer, who would orphan the trip', () => {
		expect(trips.leaveTrip(tripId, organizer)).toBe(false);
		expect(isMember(organizer)).toBe(true);
	});

	it('lets a regular member leave', () => {
		expect(trips.leaveTrip(tripId, member)).toBe(true);
		expect(isMember(member)).toBe(false);
		// The organizer stays put: one departure is not the whole roster.
		expect(isMember(organizer)).toBe(true);
	});

	it('refuses somebody who is not on the trip at all', () => {
		const stranger = auth.createUser('stranger@example.test', 'Stranger', 'hunter2hunter2').id;
		expect(trips.leaveTrip(tripId, stranger)).toBe(false);
	});
});
