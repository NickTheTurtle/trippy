import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { splitByWeight } from '@trippy/core/split';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempRoot = join(tmpdir(), `trippy-server-tests-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'server.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let auth: typeof import('../src/infra/auth.ts');
let trips: typeof import('../src/persistence/trips.ts');
let schedule: typeof import('../src/persistence/schedule.ts');
let members: typeof import('../src/persistence/members.ts');
let expenses: typeof import('../src/persistence/expenses.ts');
let events: typeof import('../src/events.ts');
let pois: typeof import('../src/persistence/pois.ts');
let lodging: typeof import('../src/persistence/lodging.ts');
let parties: typeof import('../src/persistence/parties.ts');
let tasks: typeof import('../src/persistence/tasks.ts');

interface Fixture {
	organizer: string;
	member: string;
	outsider: string;
	tripId: string;
	cityId: string;
}

beforeAll(async () => {
	[{ db }, auth, trips, schedule, members, expenses, events, pois, lodging, parties, tasks] =
		await Promise.all([
			import('../src/db.ts'),
			import('../src/infra/auth.ts'),
			import('../src/persistence/trips.ts'),
			import('../src/persistence/schedule.ts'),
			import('../src/persistence/members.ts'),
			import('../src/persistence/expenses.ts'),
			import('../src/events.ts'),
			import('../src/persistence/pois.ts'),
			import('../src/persistence/lodging.ts'),
			import('../src/persistence/parties.ts'),
			import('../src/persistence/tasks.ts')
		]);
});

beforeEach(() => {
	events.closeAll();
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
});

afterEach(() => {
	vi.useRealTimers();
	events.closeAll();
	expect(events.busStats().subscribers).toBe(0);
});

afterAll(() => {
	events.closeAll();
	db.close();
	removeTestDatabaseFiles();
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

function removeTestDatabaseFiles(path = dbPath): void {
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${path}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
}

function createUser(label: string): string {
	return auth.createUser(`${label}-${crypto.randomUUID()}@example.test`, label, 'password123').id;
}

function createTripFixture(label = 'trip'): Fixture {
	const organizer = createUser(`${label}-organizer`);
	const member = createUser(`${label}-member`);
	const outsider = createUser(`${label}-outsider`);
	const tripId = trips.createTrip(organizer, {
		name: `${label} Trip`,
		startDate: '2026-10-01',
		endDate: '2026-10-03',
		homeCurrency: 'USD'
	}).id!;
	expect(members.inviteToTrip(tripId, organizer, auth.findUserById(member)!.email)).toBe('added');
	const cityId = trips.addCity(tripId, organizer, {
		name: 'Athens',
		country: 'Greece',
		tz: 'Europe/Athens',
		lat: 37.98,
		lng: 23.73
	})!;
	return { organizer, member, outsider, tripId, cityId };
}

function createScheduleItem(f: Fixture): string {
	const trackId = schedule.createTrack(f.tripId, '2026-10-01', 'Main')!;
	return schedule.createItem(trackId, f.tripId, f.organizer, {
		title: 'Museum',
		startMin: 9 * 60,
		endMin: 10 * 60,
		type: 'poi',
		lat: 37.98,
		lng: 23.73,
		assignees: [f.organizer]
	})!;
}

function itemRow(itemId: string) {
	return db
		.prepare(`SELECT title, start_min, end_min, booking FROM schedule_items WHERE id = ?`)
		.get(itemId) as
		{ title: string; start_min: number; end_min: number; booking: string | null } | undefined;
}

function cityRow(cityId: string) {
	return db.prepare(`SELECT name, country, region, tz FROM cities WHERE id = ?`).get(cityId) as {
		name: string;
		country: string;
		region: string | null;
		tz: string;
	};
}

function tableCount(table: string, where: string, ...args: unknown[]): number {
	const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args) as {
		n: number;
	};
	return row.n;
}

describe('schedule authorization and trip scoping', () => {
	const cases = [
		{
			name: 'moveItem',
			run: (itemId: string, actor: string, tripId: string) =>
				schedule.moveItem(itemId, actor, 11 * 60, tripId),
			assertUnchanged: (itemId: string) => expect(itemRow(itemId)!.start_min).toBe(9 * 60)
		},
		{
			name: 'resizeItem',
			run: (itemId: string, actor: string, tripId: string) =>
				schedule.resizeItem(itemId, actor, 12 * 60, tripId),
			assertUnchanged: (itemId: string) => expect(itemRow(itemId)!.end_min).toBe(10 * 60)
		},
		{
			name: 'editItem',
			run: (itemId: string, actor: string, tripId: string) =>
				schedule.editItem(itemId, actor, { title: 'Changed' }, tripId),
			assertUnchanged: (itemId: string) => expect(itemRow(itemId)!.title).toBe('Museum')
		},
		{
			name: 'deleteItem',
			run: (itemId: string, actor: string, tripId: string) =>
				schedule.deleteItem(itemId, actor, tripId),
			assertUnchanged: (itemId: string) => expect(itemRow(itemId)).toBeDefined()
		},
		{
			name: 'setAssignees',
			run: (itemId: string, actor: string, tripId: string) =>
				schedule.setAssignees(itemId, tripId, actor, []),
			assertUnchanged: (itemId: string) =>
				expect(tableCount('item_assignees', 'item_id = ?', itemId)).toBe(1)
		},
		{
			name: 'cycleBooking',
			run: (itemId: string, actor: string, tripId: string) =>
				schedule.cycleBooking(itemId, actor, tripId),
			assertUnchanged: (itemId: string) => expect(itemRow(itemId)!.booking).toBe('unbooked')
		}
	];

	it.each(cases)('$name rejects a valid item id when the caller passes another trip id', (c) => {
		const tripA = createTripFixture('a');
		const tripB = createTripFixture('b');
		const itemId = createScheduleItem(tripA);

		expect(c.run(itemId, tripA.organizer, tripB.tripId)).toBe(false);

		c.assertUnchanged(itemId);
	});

	it.each(cases)('$name rejects a non-member even with the correct trip id', (c) => {
		const f = createTripFixture(c.name);
		const itemId = createScheduleItem(f);

		expect(c.run(itemId, f.outsider, f.tripId)).toBe(false);

		c.assertUnchanged(itemId);
	});

	it('setPartyDay rejects cross-trip party, city, and lodging ids', () => {
		const tripA = createTripFixture('party-a');
		const tripB = createTripFixture('party-b');
		const partyA = parties.createParty(tripA.tripId, tripA.organizer, 'Split')!;
		const optionB = lodging.addOption(tripB.tripId, tripB.organizer, tripB.cityId, 'Hotel B')!;

		expect(
			parties.setPartyDay(tripA.tripId, tripA.organizer, partyA, '2026-10-01', tripB.cityId, null)
		).toBe(false);
		expect(
			parties.setPartyDay(tripA.tripId, tripA.organizer, partyA, '2026-10-01', null, optionB)
		).toBe(false);
		expect(
			parties.setPartyDay(
				tripB.tripId,
				tripB.organizer,
				partyA,
				'2026-10-01',
				tripB.cityId,
				optionB
			)
		).toBe(false);
		expect(parties.partyDay(partyA, '2026-10-01')).toBeNull();
	});
});

describe('member removal cascade', () => {
	it('matches removalImpact for a placeholder with expenses, shares, votes, and assignments', () => {
		const f = createTripFixture('placeholder');
		expect(members.inviteToTrip(f.tripId, f.organizer, 'guest@example.test')).toBe('invited');
		const placeholder = members.listPeople(f.tripId).find((p) => p.placeholder)!;
		const paidByPlaceholder = expenses.addExpense(
			f.tripId,
			f.organizer,
			placeholder.id,
			'Hotel deposit',
			999,
			'USD',
			[
				{ userId: f.organizer, weight: 1 },
				{ userId: f.member, weight: 1 },
				{ userId: placeholder.id, weight: 1 }
			]
		)!;
		expenses.addExpense(f.tripId, f.organizer, f.organizer, 'Dinner', 600, 'USD', [
			{ userId: placeholder.id, weight: 1 }
		]);
		const poiId = pois.addPoi(
			f.tripId,
			f.organizer,
			f.cityId,
			'Acropolis',
			'Sights',
			null,
			null,
			null,
			null
		)!;
		expect(pois.toggleVote(f.tripId, placeholder.id, poiId)).toBe(true);
		const stayId = lodging.addOption(f.tripId, f.organizer, f.cityId, 'Guesthouse')!;
		expect(lodging.vote(f.tripId, placeholder.id, stayId)).toBe(true);
		const itemId = createScheduleItem(f);
		expect(schedule.setAssignees(itemId, f.tripId, f.organizer, [placeholder.id])).toBe(true);
		const taskId = tasks.addTask(f.tripId, f.organizer, 'prep', 'Pack', [placeholder.id], null)!;
		expect(tasks.toggleTask(f.tripId, placeholder.id, taskId)).toBe(true);
		const crew = parties.createParty(f.tripId, f.organizer, 'Crew')!;
		expect(
			parties.assignMembership(f.tripId, f.organizer, crew, placeholder.id, '2026-10-01', 60, 120)
		).toBe(true);
		const before = snapshotRemovalCounts(f.tripId, placeholder.id);
		const impact = members.removalImpact(f.tripId, placeholder.id, f.organizer)!;

		expect(impact.destroyed).toEqual(before);
		expect(impact.destroyed.expensesPaid).toBe(1);
		expect(impact.destroyed.expensesPaidCents).toBe(999);
		expect(impact.destroyed.expenseShares).toBe(2);
		expect(impact.destroyed.otherPeopleSharesLost).toBe(2);
		expect(impact.destroyed.poiVotes).toBe(1);
		expect(impact.destroyed.lodgingVotes).toBe(1);
		expect(impact.destroyed.itemAssignments).toBe(1);
		expect(impact.destroyed.taskAssignments).toBe(1);
		expect(impact.destroyed.taskCompletions).toBe(1);
		expect(impact.destroyed.partySegments).toBe(1);

		expect(members.removeMember(f.tripId, f.organizer, placeholder.id)).toBe(true);

		expect(auth.findUserById(placeholder.id)).toBeUndefined();
		expect(snapshotRemovalCounts(f.tripId, placeholder.id)).toEqual(zeroCounts());
		expect(
			db.prepare(`SELECT 1 FROM expenses WHERE id = ?`).get(paidByPlaceholder)
		).toBeUndefined();
		expect(tableCount('expense_participants', 'expense_id = ?', paidByPlaceholder)).toBe(0);
	});

	it('matches removalImpact for a registered member and removes only the membership row', () => {
		const f = createTripFixture('registered');
		const expenseId = expenses.addExpense(f.tripId, f.organizer, f.member, 'Tickets', 1200, 'USD', [
			{ userId: f.organizer, weight: 1 },
			{ userId: f.member, weight: 1 }
		])!;
		const poiId = pois.addPoi(
			f.tripId,
			f.organizer,
			f.cityId,
			'Agora',
			'Sights',
			null,
			null,
			null,
			null
		)!;
		expect(pois.toggleVote(f.tripId, f.member, poiId)).toBe(true);
		const impact = members.removalImpact(f.tripId, f.member, f.organizer)!;

		expect(impact.deletesUserRow).toBe(false);
		expect(impact.destroyed).toEqual({ ...zeroCounts(), memberships: 1 });
		expect(impact.retained.expensesPaid).toBe(1);
		expect(impact.retained.expenseShares).toBe(1);
		expect(impact.retained.otherPeopleSharesLost).toBe(1);
		expect(impact.retained.poiVotes).toBe(1);

		expect(members.removeMember(f.tripId, f.organizer, f.member)).toBe(true);

		expect(auth.findUserById(f.member)).toBeDefined();
		expect(tableCount('memberships', 'trip_id = ? AND user_id = ?', f.tripId, f.member)).toBe(0);
		expect(db.prepare(`SELECT 1 FROM expenses WHERE id = ?`).get(expenseId)).toBeDefined();
		expect(
			tableCount('expense_participants', 'expense_id = ? AND user_id = ?', expenseId, f.member)
		).toBe(1);
		expect(tableCount('poi_votes', 'poi_id = ? AND user_id = ?', poiId, f.member)).toBe(1);
	});
});

describe('invite consumption relinks placeholder history', () => {
	interface Placeholder {
		id: string;
		email: string;
		expenseId: string;
		poiId: string;
		optionId: string;
		itemId: string;
		taskId: string;
		partyId: string;
	}

	/**
	 * A placeholder carrying a row in every table that cascades off `users(id)`.
	 * If any of these is not relinked on registration, the cascade behind
	 * `DELETE FROM users` destroys it silently.
	 */
	function placeholderWithFullHistory(f: Fixture): Placeholder {
		const email = `invitee-${crypto.randomUUID()}@example.test`;
		expect(members.inviteToTrip(f.tripId, f.organizer, email)).toBe('invited');
		const id = members.listPeople(f.tripId).find((p) => p.placeholder)!.id;

		const expenseId = expenses.addExpense(f.tripId, f.organizer, id, 'Deposit', 900, 'USD', [
			{ userId: f.organizer, weight: 1 },
			{ userId: id, weight: 1 }
		])!;
		const poiId = pois.addPoi(
			f.tripId,
			f.organizer,
			f.cityId,
			'Acropolis',
			'Sights',
			null,
			null,
			null,
			null
		)!;
		expect(pois.toggleVote(f.tripId, id, poiId)).toBe(true);
		const optionId = lodging.addOption(f.tripId, f.organizer, f.cityId, 'Guesthouse')!;
		expect(lodging.vote(f.tripId, id, optionId)).toBe(true);
		const itemId = createScheduleItem(f);
		expect(schedule.setAssignees(itemId, f.tripId, f.organizer, [id])).toBe(true);
		const taskId = tasks.addTask(f.tripId, f.organizer, 'prep', 'Pack', [id], null)!;
		expect(tasks.toggleTask(f.tripId, id, taskId)).toBe(true);
		const partyId = parties.createParty(f.tripId, f.organizer, 'Crew')!;
		expect(
			parties.assignMembership(f.tripId, f.organizer, partyId, id, '2026-10-01', 60, 120)
		).toBe(true);

		return { id, email, expenseId, poiId, optionId, itemId, taskId, partyId };
	}

	it('moves every cascade-owned row to the new account instead of destroying it', () => {
		const f = createTripFixture('relink-all');
		const ph = placeholderWithFullHistory(f);
		const before = snapshotRemovalCounts(f.tripId, ph.id);
		const doneAt = scalar(
			`SELECT done_at FROM task_done WHERE task_id = ? AND user_id = ?`,
			ph.taskId,
			ph.id
		);
		expect(before.itemAssignments).toBe(1);
		expect(before.taskAssignments).toBe(1);
		expect(before.taskCompletions).toBe(1);
		expect(before.partySegments).toBe(1);

		const real = auth.createUser(ph.email, 'Invitee', 'password123');

		// The placeholder is gone and nothing anywhere still points at it.
		expect(auth.findUserById(ph.id)).toBeUndefined();
		expect(snapshotRemovalCounts(f.tripId, ph.id)).toEqual(zeroCounts());
		// Every row it owned now belongs to the real account, table for table.
		expect(snapshotRemovalCounts(f.tripId, real.id)).toEqual(before);

		expect(tableCount('memberships', 'trip_id = ? AND user_id = ?', f.tripId, real.id)).toBe(1);
		expect(tableCount('expenses', 'id = ? AND payer_id = ?', ph.expenseId, real.id)).toBe(1);
		expect(
			tableCount('expense_participants', 'expense_id = ? AND user_id = ?', ph.expenseId, real.id)
		).toBe(1);
		expect(tableCount('poi_votes', 'poi_id = ? AND user_id = ?', ph.poiId, real.id)).toBe(1);
		expect(tableCount('lodging_votes', 'city_id = ? AND user_id = ?', f.cityId, real.id)).toBe(1);
		expect(tableCount('item_assignees', 'item_id = ? AND user_id = ?', ph.itemId, real.id)).toBe(1);
		expect(tableCount('task_assignees', 'task_id = ? AND user_id = ?', ph.taskId, real.id)).toBe(1);
		expect(tableCount('task_done', 'task_id = ? AND user_id = ?', ph.taskId, real.id)).toBe(1);
		expect(
			tableCount('party_membership', 'party_id = ? AND user_id = ?', ph.partyId, real.id)
		).toBe(1);

		// The completion keeps its original timestamp: a relink is not a re-tick.
		expect(
			scalar(`SELECT done_at FROM task_done WHERE task_id = ? AND user_id = ?`, ph.taskId, real.id)
		).toBe(doneAt);
		// The vote still points at the option that was chosen, not just the city.
		expect(tableCount('lodging_votes', 'user_id = ? AND option_id = ?', real.id, ph.optionId)).toBe(
			1
		);
		// The invite is spent.
		expect(tableCount('trip_invites', 'trip_id = ? AND email = ?', f.tripId, ph.email)).toBe(0);
	});

	it('publishes every topic whose rows the relink touched', () => {
		const f = createTripFixture('relink-events');
		const ph = placeholderWithFullHistory(f);
		const seen: import('../src/events.ts').TripEvent[] = [];
		const sub = events.subscribe(f.tripId, f.organizer, (event) => seen.push(event));
		expect(sub.ok).toBe(true);

		auth.createUser(ph.email, 'Invitee', 'password123');

		expect(seen.map((e) => e.topic)).toEqual([
			'members',
			'expenses',
			'schedule',
			'pois',
			'lodging',
			'tasks'
		]);
		expect(seen.every((e) => e.tripId === f.tripId)).toBe(true);

		if (sub.ok) sub.sub.close();
	});

	// The collision case: the real account already holds the identical row in
	// every composite-key table. A plain UPDATE would violate the primary key and
	// abort registration outright, so this is the test that pins the OR IGNORE
	// choice down.
	it('merges without duplicating or throwing when the real account already holds the same rows', () => {
		const f = createTripFixture('relink-collide');
		const email = `rejoin-${crypto.randomUUID()}@example.test`;
		const real = auth.createUser(email, 'Rejoiner', 'password123');
		expect(members.inviteToTrip(f.tripId, f.organizer, email)).toBe('added');

		const ghost = `ghost-${crypto.randomUUID()}@example.test`;
		expect(members.inviteToTrip(f.tripId, f.organizer, ghost)).toBe('invited');
		const phId = members.listPeople(f.tripId).find((p) => p.placeholder)!.id;

		// Identical rows under both identities, one per composite-key table.
		const sharedExpense = expenses.addExpense(
			f.tripId,
			f.organizer,
			f.organizer,
			'Taxi',
			1200,
			'USD',
			[
				{ userId: real.id, weight: 1 },
				{ userId: phId, weight: 1 }
			]
		)!;
		const placeholderExpense = expenses.addExpense(
			f.tripId,
			f.organizer,
			phId,
			'Snacks',
			300,
			'USD',
			[{ userId: f.organizer, weight: 1 }]
		)!;
		const poiId = pois.addPoi(
			f.tripId,
			f.organizer,
			f.cityId,
			'Agora',
			'Sights',
			null,
			null,
			null,
			null
		)!;
		expect(pois.toggleVote(f.tripId, real.id, poiId)).toBe(true);
		expect(pois.toggleVote(f.tripId, phId, poiId)).toBe(true);
		const optionId = lodging.addOption(f.tripId, f.organizer, f.cityId, 'Hostel')!;
		expect(lodging.vote(f.tripId, real.id, optionId)).toBe(true);
		expect(lodging.vote(f.tripId, phId, optionId)).toBe(true);
		const itemId = createScheduleItem(f);
		expect(schedule.setAssignees(itemId, f.tripId, f.organizer, [real.id, phId])).toBe(true);
		const taskId = tasks.addTask(f.tripId, f.organizer, 'prep', 'Visa', [real.id, phId], null)!;
		expect(tasks.toggleTask(f.tripId, real.id, taskId)).toBe(true);
		expect(tasks.toggleTask(f.tripId, phId, taskId)).toBe(true);
		const partyId = parties.createParty(f.tripId, f.organizer, 'Crew')!;
		expect(
			parties.assignMembership(f.tripId, f.organizer, partyId, real.id, '2026-10-01', 60, 120)
		).toBe(true);
		expect(
			parties.assignMembership(f.tripId, f.organizer, partyId, phId, '2026-10-01', 60, 120)
		).toBe(true);

		// Rows in the same tables that do NOT collide, so the merge has to both
		// collapse duplicates and carry the placeholder's own history across.
		const soloItem = createScheduleItem(f);
		expect(schedule.setAssignees(soloItem, f.tripId, f.organizer, [phId])).toBe(true);
		const soloTask = tasks.addTask(f.tripId, f.organizer, 'prep', 'Insurance', [phId], null)!;
		expect(tasks.toggleTask(f.tripId, phId, soloTask)).toBe(true);

		// Distinguishable completion timestamps, so the surviving row can be
		// attributed rather than guessed at.
		db.prepare(`UPDATE task_done SET done_at = 1111 WHERE task_id = ? AND user_id = ?`).run(
			taskId,
			real.id
		);
		db.prepare(`UPDATE task_done SET done_at = 2222 WHERE task_id = ? AND user_id = ?`).run(
			taskId,
			phId
		);

		// Point the pending invite at the already-registered address, which is the
		// state that makes every one of these a live primary-key conflict.
		db.prepare(`UPDATE trip_invites SET email = ? WHERE trip_id = ? AND email = ?`).run(
			email,
			f.tripId,
			ghost
		);

		expect(() => members.consumeInvites(real.id, email)).not.toThrow();

		expect(auth.findUserById(phId)).toBeUndefined();
		expect(snapshotRemovalCounts(f.tripId, phId)).toEqual(zeroCounts());

		// Exactly one row per key: merged, not duplicated.
		expect(tableCount('memberships', 'trip_id = ? AND user_id = ?', f.tripId, real.id)).toBe(1);
		expect(tableCount('expense_participants', 'expense_id = ?', sharedExpense)).toBe(1);
		expect(
			tableCount('expense_participants', 'expense_id = ? AND user_id = ?', sharedExpense, real.id)
		).toBe(1);
		expect(tableCount('poi_votes', 'poi_id = ?', poiId)).toBe(1);
		expect(tableCount('lodging_votes', 'city_id = ?', f.cityId)).toBe(1);
		expect(tableCount('item_assignees', 'item_id = ?', itemId)).toBe(1);
		expect(tableCount('item_assignees', 'item_id = ? AND user_id = ?', itemId, real.id)).toBe(1);
		expect(tableCount('task_assignees', 'task_id = ?', taskId)).toBe(1);
		expect(tableCount('task_done', 'task_id = ?', taskId)).toBe(1);
		expect(tableCount('party_membership', 'party_id = ? AND day = ?', partyId, '2026-10-01')).toBe(
			1
		);
		expect(tableCount('party_membership', 'party_id = ? AND user_id = ?', partyId, real.id)).toBe(
			1
		);

		// On a collision the real account keeps the completion it made itself.
		expect(
			scalar(`SELECT done_at FROM task_done WHERE task_id = ? AND user_id = ?`, taskId, real.id)
		).toBe(1111);

		// The non-colliding row still moves: payer_id is under no unique index.
		expect(tableCount('expenses', 'id = ? AND payer_id = ?', placeholderExpense, real.id)).toBe(1);
		// The placeholder's own, non-colliding assignments survive the merge too.
		expect(tableCount('item_assignees', 'item_id = ? AND user_id = ?', soloItem, real.id)).toBe(1);
		expect(tableCount('task_assignees', 'task_id = ? AND user_id = ?', soloTask, real.id)).toBe(1);
		expect(tableCount('task_done', 'task_id = ? AND user_id = ?', soloTask, real.id)).toBe(1);
		expect(tableCount('trip_invites', 'trip_id = ? AND email = ?', f.tripId, email)).toBe(0);
	});

	// Documents a boundary left deliberately unresolved: identical crew segments
	// are collapsed, but a segment that merely overlaps is kept, because deciding
	// which crew wins a contested window is a product call, not a merge detail.
	it('collapses identical crew segments and keeps genuinely different ones', () => {
		const f = createTripFixture('relink-parties');
		const email = `crew-${crypto.randomUUID()}@example.test`;
		const real = auth.createUser(email, 'Crewmate', 'password123');
		expect(members.inviteToTrip(f.tripId, f.organizer, email)).toBe('added');
		const ghost = `ghost-${crypto.randomUUID()}@example.test`;
		expect(members.inviteToTrip(f.tripId, f.organizer, ghost)).toBe('invited');
		const phId = members.listPeople(f.tripId).find((p) => p.placeholder)!.id;

		const crew = parties.createParty(f.tripId, f.organizer, 'Crew')!;
		const other = parties.createParty(f.tripId, f.organizer, 'Other')!;
		expect(
			parties.assignMembership(f.tripId, f.organizer, crew, real.id, '2026-10-01', 60, 120)
		).toBe(true);
		expect(parties.assignMembership(f.tripId, f.organizer, crew, phId, '2026-10-01', 60, 120)).toBe(
			true
		);
		expect(
			parties.assignMembership(f.tripId, f.organizer, other, phId, '2026-10-02', 300, 400)
		).toBe(true);

		db.prepare(`UPDATE trip_invites SET email = ? WHERE trip_id = ? AND email = ?`).run(
			email,
			f.tripId,
			ghost
		);
		members.consumeInvites(real.id, email);

		expect(tableCount('party_membership', 'user_id = ?', real.id)).toBe(2);
		expect(tableCount('party_membership', 'party_id = ? AND day = ?', crew, '2026-10-01')).toBe(1);
		expect(
			tableCount(
				'party_membership',
				'party_id = ? AND user_id = ? AND day = ?',
				other,
				real.id,
				'2026-10-02'
			)
		).toBe(1);
		expect(tableCount('party_membership', 'user_id = ?', phId)).toBe(0);
	});
});

describe('known balance behavior', () => {
	it('documents current behavior: balances stop summing to zero after a participant is removed (KNOWN BUG)', () => {
		const f = createTripFixture('known-bug');
		expenses.addExpense(f.tripId, f.organizer, f.member, 'Tickets', 1200, 'USD', [
			{ userId: f.organizer, weight: 1 },
			{ userId: f.member, weight: 1 }
		]);
		expect(sumBalances(f.tripId)).toBe(0);

		expect(members.removeMember(f.tripId, f.organizer, f.member)).toBe(true);

		// Decision pending: removed registered participants remain in expense rows, but balances()
		// reports only current members, so the visible result no longer sums to zero.
		expect(sumBalances(f.tripId)).not.toBe(0);
	});
});

describe('event bus', () => {
	it('publishes real mutation topics, isolates trips, and uses strictly increasing ids', () => {
		const tripA = createTripFixture('events-a');
		const tripB = createTripFixture('events-b');
		const seen: import('../src/events.ts').TripEvent[] = [];
		const sub = events.subscribe(tripA.tripId, tripA.organizer, (event) => seen.push(event));
		expect(sub.ok).toBe(true);

		const other = events.publish(tripB.tripId, 'trip')!;
		const cityEventCountBefore = seen.length;
		const newCity = trips.addCity(tripA.tripId, tripA.organizer, {
			name: 'Paris',
			country: 'France',
			tz: 'Europe/Paris'
		});
		const track = schedule.createTrack(tripA.tripId, '2026-10-01', 'Live');
		const expense = expenses.addExpense(
			tripA.tripId,
			tripA.organizer,
			tripA.organizer,
			'Snacks',
			301,
			'USD',
			[
				{ userId: tripA.organizer, weight: 1 },
				{ userId: tripA.member, weight: 1 }
			]
		);

		expect(newCity).toBeTruthy();
		expect(track).toBeTruthy();
		expect(expense).toBeTruthy();
		expect(seen.length).toBeGreaterThan(cityEventCountBefore);
		expect(seen.map((e) => e.topic)).toEqual([
			'trip',
			'schedule',
			'lodging',
			'costs',
			'schedule',
			'expenses'
		]);
		expect(seen.every((e) => e.tripId === tripA.tripId)).toBe(true);
		expect(seen.every((e, i) => i === 0 || e.id > seen[i - 1].id)).toBe(true);
		expect(seen.every((e) => e.id > other.id)).toBe(true);

		if (sub.ok) sub.sub.close();
	});

	it('rejects a non-member subscription with forbidden', () => {
		const f = createTripFixture('forbidden');

		expect(events.subscribe(f.tripId, f.outsider, () => undefined)).toEqual({
			ok: false,
			error: 'forbidden'
		});
	});

	it('replays exactly the events missed after Last-Event-ID', () => {
		const f = createTripFixture('replay');
		const first = events.publish(f.tripId, 'trip')!;
		const second = events.publish(f.tripId, 'expenses')!;

		const sub = events.subscribe(f.tripId, f.organizer, () => undefined, {
			lastEventId: events.wireEventId(first)
		});

		expect(sub.ok).toBe(true);
		if (sub.ok) {
			expect(sub.resume).toBe('replay');
			expect(sub.missed).toEqual([second]);
			expect(sub.lastEventId).toBe(events.wireEventId(second));
			sub.sub.close();
		}
	});

	it('returns reset for aged-out, epoch-mismatched, ahead-of-head, and unparseable Last-Event-ID values', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
		const aged = createTripFixture('aged-reset');
		const active = createTripFixture('active-reset');
		const old = events.publish(aged.tripId, 'trip')!;
		const oldWireId = events.wireEventId(old);

		vi.advanceTimersByTime(5 * 60 * 1000 + 1);
		events.publish(active.tripId, 'trip');

		const resetCases = [
			{ label: 'aged out of the ring', tripId: aged.tripId, id: oldWireId },
			{ label: 'epoch mismatch', tripId: active.tripId, id: `wrong.${old.id}` },
			{ label: 'id ahead of head', tripId: active.tripId, id: `${events.EVENT_EPOCH}.999999` },
			{ label: 'unparseable', tripId: active.tripId, id: 'not-an-event-id' }
		];

		for (const c of resetCases) {
			const sub = events.subscribe(
				c.tripId,
				c.tripId === aged.tripId ? aged.organizer : active.organizer,
				() => undefined,
				{
					lastEventId: c.id
				}
			);
			expect(sub, c.label).toMatchObject({ ok: true, resume: 'reset', missed: [] });
			if (sub.ok) sub.sub.close();
		}
	});

	it('refuses the 33rd subscriber for one trip with busy and closes back to zero subscribers', () => {
		const f = createTripFixture('cap');
		const subs: import('../src/events.ts').TripSubscription[] = [];
		for (let i = 0; i < 32; i++) {
			const sub = events.subscribe(f.tripId, f.organizer, () => undefined);
			expect(sub.ok).toBe(true);
			if (sub.ok) subs.push(sub.sub);
		}

		expect(events.subscribe(f.tripId, f.organizer, () => undefined)).toEqual({
			ok: false,
			error: 'busy'
		});

		for (const sub of subs) sub.close();
		expect(events.busStats().subscribers).toBe(0);
	});

	it('detaches a throwing listener without breaking delivery to other subscribers', () => {
		const f = createTripFixture('throwing');
		const delivered: number[] = [];
		const closed: string[] = [];
		const bad = events.subscribe(
			f.tripId,
			f.organizer,
			() => {
				throw new Error('socket is gone');
			},
			{ onClose: (reason) => closed.push(reason) }
		);
		const good = events.subscribe(f.tripId, f.member, (event) => delivered.push(event.id));
		expect(bad.ok).toBe(true);
		expect(good.ok).toBe(true);

		const event = events.publish(f.tripId, 'expenses')!;

		expect(closed).toEqual(['listener-error']);
		expect(delivered).toEqual([event.id]);
		expect(events.subscriberCount(f.tripId)).toBe(1);
		if (bad.ok) expect(bad.sub.closed).toBe(true);
		if (good.ok) good.sub.close();
	});
});

describe('schema and migrations', () => {
	it('can run migrations twice, keeps additive columns singular, and drops city dates', async () => {
		const dbAgain = (await import('../src/db.ts?rerun')).db;
		dbAgain.close();

		const expectedColumns = [
			['lodging_options', 'check_in', 'TEXT'],
			['lodging_options', 'check_out', 'TEXT'],
			['lodging_options', 'photo', 'TEXT'],
			['pois', 'photo', 'TEXT'],
			['pois', 'kind', 'TEXT'],
			['expenses', 'settlement', 'INTEGER'],
			['expenses', 'split_mode', 'TEXT'],
			['expense_participants', 'weight', 'REAL'],
			['cities', 'photo', 'TEXT'],
			['cities', 'region', 'TEXT'],
			['trips', 'start_date', 'TEXT'],
			['trips', 'end_date', 'TEXT'],
			['tracks', 'party_id', 'TEXT']
		] as const;

		for (const [table, column, type] of expectedColumns) {
			const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
				name: string;
				type: string;
			}[];
			const matches = rows.filter((r) => r.name === column);
			expect(matches, `${table}.${column}`).toHaveLength(1);
			expect(matches[0].type.toUpperCase()).toBe(type);
		}

		const cityColumns = db.prepare(`PRAGMA table_info(cities)`).all() as {
			name: string;
		}[];
		expect(cityColumns.map((c) => c.name)).not.toContain('arrive');
		expect(cityColumns.map((c) => c.name)).not.toContain('depart');
	});

	it('enforces cascade and set-null foreign keys used by removal warnings', () => {
		const f = createTripFixture('foreign-keys');
		const placeholder = createUser('placeholder-target');
		db.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'member')`).run(
			f.tripId,
			placeholder
		);
		const expenseId = expenses.addExpense(f.tripId, f.organizer, placeholder, 'Paid', 500, 'USD', [
			{ userId: f.organizer, weight: 1 },
			{ userId: placeholder, weight: 1 }
		])!;
		const poiId = pois.addPoi(
			f.tripId,
			f.organizer,
			f.cityId,
			'Temple',
			'Sights',
			null,
			null,
			null,
			null
		)!;
		expect(pois.toggleVote(f.tripId, placeholder, poiId)).toBe(true);
		const optionId = lodging.addOption(f.tripId, f.organizer, f.cityId, 'Hotel')!;
		const partyId = parties.createParty(f.tripId, f.organizer, 'FK crew')!;
		expect(
			parties.setPartyDay(f.tripId, f.organizer, partyId, '2026-10-01', f.cityId, optionId)
		).toBe(true);

		db.prepare(`DELETE FROM lodging_options WHERE id = ?`).run(optionId);
		expect(parties.partyDay(partyId, '2026-10-01')!.lodgingOptionId).toBeNull();
		db.prepare(`DELETE FROM cities WHERE id = ?`).run(f.cityId);
		expect(parties.partyDay(partyId, '2026-10-01')!.cityId).toBeNull();
		db.prepare(`DELETE FROM users WHERE id = ?`).run(placeholder);

		expect(db.prepare(`SELECT 1 FROM expenses WHERE id = ?`).get(expenseId)).toBeUndefined();
		expect(tableCount('expense_participants', 'expense_id = ?', expenseId)).toBe(0);
		expect(tableCount('poi_votes', 'poi_id = ? AND user_id = ?', poiId, placeholder)).toBe(0);
		expect(tableCount('memberships', 'user_id = ?', placeholder)).toBe(0);
	});
});

describe('required trip dates', () => {
	it('refuses to create or edit a trip without both endpoints', () => {
		const organizer = createUser('dates-required');
		const missingStart = trips.createTrip(organizer, {
			name: 'No start',
			startDate: '',
			endDate: '2026-10-03',
			homeCurrency: 'USD'
		});
		expect(missingStart.id).toBeNull();
		expect(missingStart.error).toBe('Pick a start date.');

		const missingEnd = trips.createTrip(organizer, {
			name: 'No end',
			startDate: '2026-10-01',
			endDate: '   ',
			homeCurrency: 'USD'
		});
		expect(missingEnd.id).toBeNull();
		expect(missingEnd.error).toBe('Pick an end date.');

		const backwards = trips.createTrip(organizer, {
			name: 'Backwards',
			startDate: '2026-10-05',
			endDate: '2026-10-01',
			homeCurrency: 'USD'
		});
		expect(backwards.id).toBeNull();
		expect(backwards.error).toBe('The end date must be on or after the start date.');

		const f = createTripFixture('dates-edit');
		expect(
			trips.updateTrip(f.tripId, f.organizer, {
				name: 'Cleared',
				startDate: '',
				endDate: '',
				currency: 'USD'
			})
		).toBe('Pick a start date.');
		const row = db.prepare(`SELECT start_date, end_date FROM trips WHERE id = ?`).get(f.tripId) as {
			start_date: string;
			end_date: string;
		};
		expect(row.start_date).toBe('2026-10-01');
		expect(row.end_date).toBe('2026-10-03');
	});

	it('always derives the stored label from the endpoints', () => {
		const f = createTripFixture('dates-label');
		const label = () =>
			(db.prepare(`SELECT dates FROM trips WHERE id = ?`).get(f.tripId) as { dates: string }).dates;
		expect(label()).toBe('Oct 1 \u2013 3, 2026');

		expect(
			trips.updateTrip(f.tripId, f.organizer, {
				name: f.tripId,
				startDate: '2026-12-30',
				endDate: '2027-01-02',
				currency: 'USD'
			})
		).toBeNull();
		expect(label()).toBe('Dec 30, 2026 \u2013 Jan 2, 2027');
	});

	it('backfills legacy dateless rows and repairs labels that drifted', async () => {
		const organizer = createUser('dates-migration');
		const dateless = crypto.randomUUID();
		const created = Date.UTC(2026, 4, 7, 12, 0, 0);
		db.prepare(
			`INSERT INTO trips (id, organizer_id, name, dates, cover, home_currency, start_date, end_date, created_at)
			 VALUES (?, ?, 'Legacy', 'Dates TBD', '', 'USD', NULL, NULL, ?)`
		).run(dateless, organizer, created);

		const drifted = crypto.randomUUID();
		db.prepare(
			`INSERT INTO trips (id, organizer_id, name, dates, cover, home_currency, start_date, end_date, created_at)
			 VALUES (?, ?, 'Drifted', 'Jul 3 - Jul 15, 2027', '', 'USD', '2026-10-01', '2026-10-03', ?)`
		).run(drifted, organizer, created);

		const dbAgain = (await import('../src/db.ts?dates-backfill')).db;
		dbAgain.close();

		const backfilled = db
			.prepare(`SELECT start_date, end_date, dates FROM trips WHERE id = ?`)
			.get(dateless) as { start_date: string; end_date: string; dates: string };
		// Anchored to the creation day, as one valid single-day trip.
		expect(backfilled.start_date).toBe('2026-05-07');
		expect(backfilled.end_date).toBe('2026-05-07');
		expect(backfilled.dates).toBe('May 7, 2026');

		const repaired = db.prepare(`SELECT dates FROM trips WHERE id = ?`).get(drifted) as {
			dates: string;
		};
		expect(repaired.dates).toBe('Oct 1 \u2013 3, 2026');

		expect(
			(
				db
					.prepare(`SELECT COUNT(*) c FROM trips WHERE start_date IS NULL OR end_date IS NULL`)
					.get() as {
					c: number;
				}
			).c
		).toBe(0);
	});
});

describe('city regions', () => {
	it('stores and returns a region, and accepts a city without one', () => {
		const f = createTripFixture('regions');
		const withRegion = trips.addCity(f.tripId, f.organizer, {
			name: 'Springfield',
			country: 'United States',
			region: 'Illinois',
			tz: 'America/Chicago'
		});
		const otherSpringfield = trips.addCity(f.tripId, f.organizer, {
			name: 'Springfield',
			country: 'United States',
			region: 'Missouri',
			tz: 'America/Chicago'
		});
		// No region at all is a valid city: some places have none, and a
		// hand-entered one may simply not say.
		const noRegion = trips.addCity(f.tripId, f.organizer, {
			name: 'Singapore',
			country: 'Singapore',
			tz: 'Asia/Singapore'
		});
		// A blank region is the same as no region, never the empty string.
		const blankRegion = trips.addCity(f.tripId, f.organizer, {
			name: 'Monaco',
			country: 'Monaco',
			region: '   ',
			tz: 'Europe/Monaco'
		});
		expect(withRegion).toBeTruthy();
		expect(otherSpringfield).toBeTruthy();
		expect(noRegion).toBeTruthy();
		expect(blankRegion).toBeTruthy();

		const cities = trips.getTripForUser(f.tripId, f.organizer)!.cities;
		const byId = new Map(cities.map((c) => [c.id, c]));
		expect(byId.get(withRegion!)!.region).toBe('Illinois');
		expect(byId.get(otherSpringfield!)!.region).toBe('Missouri');
		expect(byId.get(noRegion!)!.region).toBeNull();
		expect(byId.get(blankRegion!)!.region).toBeNull();
		// Nothing anywhere in what the client receives is the string 'undefined'.
		expect(JSON.stringify(cities)).not.toContain('undefined');
	});

	it('round-trips a region through updateCity and can clear it', () => {
		const f = createTripFixture('region-update');
		const cityId = trips.addCity(f.tripId, f.organizer, {
			name: 'Springfield',
			country: 'United States',
			region: 'Illinois',
			tz: 'America/Chicago'
		})!;
		const base = {
			name: 'Springfield',
			country: 'United States',
			tz: 'America/Chicago'
		};
		expect(trips.updateCity(f.tripId, f.organizer, cityId, { ...base, region: 'Missouri' })).toBe(
			true
		);
		expect(cityRow(cityId).region).toBe('Missouri');
		expect(trips.updateCity(f.tripId, f.organizer, cityId, { ...base, region: null })).toBe(true);
		expect(cityRow(cityId).region).toBeNull();
	});

	it('leaves a pre-migration city row readable and editable', () => {
		const f = createTripFixture('region-legacy');
		// A row written before the column existed: every other column set, the
		// region simply absent. This is exactly what the rows already in
		// data/app.db look like after the additive migration runs.
		const legacyId = crypto.randomUUID();
		db.prepare(
			`INSERT INTO cities (id, trip_id, name, country, tz, lat, lng, sort)
			 VALUES (?, ?, 'Old Town', 'Greece', 'Europe/Athens', 37.9, 23.7, 9)`
		).run(legacyId, f.tripId);

		const legacy = trips
			.getTripForUser(f.tripId, f.organizer)!
			.cities.find((c) => c.id === legacyId)!;
		expect(legacy.region).toBeNull();
		expect(legacy.name).toBe('Old Town');
		expect(legacy.tz).toBe('Europe/Athens');
		expect(legacy.lat).toBe(37.9);

		// It stays editable, and a region can be filled in later.
		expect(
			trips.updateCity(f.tripId, f.organizer, legacyId, {
				name: 'Old Town',
				country: 'Greece',
				region: 'Attica',
				tz: 'Europe/Athens'
			})
		).toBe(true);
		expect(cityRow(legacyId).region).toBe('Attica');
	});
});

describe('money paths', () => {
	it('keeps uneven integer-cent splits zero-sum and settles exactly', () => {
		const f = createTripFixture('money');
		const third = createUser('third');
		expect(members.inviteToTrip(f.tripId, f.organizer, auth.findUserById(third)!.email)).toBe(
			'added'
		);
		const [extraCentOwer, regularOwer, payer] = [f.organizer, f.member, third].sort();

		expenses.addExpense(f.tripId, f.organizer, payer, 'Uneven bill', 1000, 'USD', [
			{ userId: f.organizer, weight: 1 },
			{ userId: f.member, weight: 1 },
			{ userId: third, weight: 1 }
		]);

		const before = expenses.balances(f.tripId);
		expect(before.reduce((sum, b) => sum + b.netCents, 0)).toBe(0);
		expect(new Set(before.map((b) => b.id))).toEqual(new Set([f.organizer, f.member, third]));
		expect(before.map((b) => b.netCents).sort((a, b) => a - b)).toEqual([-334, -333, 667]);
		expect(balanceMap(before)).toEqual(
			new Map([
				[extraCentOwer, -334],
				[regularOwer, -333],
				[payer, 667]
			])
		);
		const settlement = expenses.settlement(f.tripId);
		expect(settlement.reduce((sum, s) => sum + s.amountCents, 0)).toBe(667);

		for (const s of settlement) {
			expect(
				expenses.recordSettlement(f.tripId, f.organizer, s.fromId, s.toId, s.amountCents)
			).toBeTruthy();
		}

		expect(expenses.balances(f.tripId).every((b) => b.netCents === 0)).toBe(true);
	});

	it('converts supported currencies into the trip home currency before balancing', () => {
		const organizer = createUser('eur-organizer');
		const member = createUser('eur-member');
		const tripId = trips.createTrip(organizer, {
			name: 'Euro Trip',
			startDate: '2026-10-01',
			endDate: '2026-10-02',
			homeCurrency: 'EUR'
		}).id!;
		expect(members.inviteToTrip(tripId, organizer, auth.findUserById(member)!.email)).toBe('added');

		expenses.addExpense(tripId, organizer, organizer, 'USD meal', 1000, 'USD', [
			{ userId: organizer, weight: 1 },
			{ userId: member, weight: 1 }
		]);

		const balances = expenses.balances(tripId);
		expect(balances.reduce((sum, b) => sum + b.netCents, 0)).toBe(0);
		expect(balances.map((b) => b.netCents).sort((a, b) => a - b)).toEqual([-460, 460]);
	});
});

describe('zero-weight participants', () => {
	interface ThreeWay extends Fixture {
		payer: string;
	}

	function threeWayFixture(label: string): ThreeWay {
		const f = createTripFixture(label);
		const payer = createUser(`${label}-payer`);
		expect(members.inviteToTrip(f.tripId, f.organizer, auth.findUserById(payer)!.email)).toBe(
			'added'
		);
		return { ...f, payer };
	}

	// A participant who is selected but stakes nothing must be stored as 0, not
	// coerced to 1. Anything else charges someone who owes nothing and makes the
	// ledger disagree with the dialog's `splitByWeight` preview.
	it('stores a blank shares participant as weight 0 and matches the split preview', () => {
		const f = threeWayFixture('shares-blank');

		const id = expenses.addExpense(
			f.tripId,
			f.organizer,
			f.payer,
			'Taxi',
			9000,
			'USD',
			[
				{ userId: f.organizer, weight: 2 },
				{ userId: f.member, weight: 0 }
			],
			'shares'
		)!;
		expect(id).toBeTruthy();

		expect(storedWeights(id)).toEqual(
			new Map([
				[f.organizer, 2],
				[f.member, 0]
			])
		);

		const preview = splitByWeight(9000, [2, 0]);
		expect(preview).toEqual([9000, 0]);

		const bals = balanceMap(expenses.balances(f.tripId));
		expect(bals.get(f.organizer)).toBe(-preview[0]);
		expect(bals.get(f.member)).toBe(0);
		expect(preview[1]).toBe(0);
		expect(bals.get(f.payer)).toBe(9000);
		expect(sumBalances(f.tripId)).toBe(0);
	});

	it('stores an exact 0.00 participant as weight 0 and leaves them at exactly zero', () => {
		const f = threeWayFixture('exact-zero');

		const id = expenses.addExpense(
			f.tripId,
			f.organizer,
			f.payer,
			'Hotel',
			10000,
			'USD',
			[
				{ userId: f.organizer, weight: 10000 },
				{ userId: f.member, weight: 0 }
			],
			'exact'
		)!;
		expect(id).toBeTruthy();

		expect(storedWeights(id)).toEqual(
			new Map([
				[f.organizer, 10000],
				[f.member, 0]
			])
		);

		const bals = balanceMap(expenses.balances(f.tripId));
		expect(bals.get(f.organizer)).toBe(-10000);
		expect(bals.get(f.member)).toBe(0);
		expect(bals.get(f.payer)).toBe(10000);
		expect(sumBalances(f.tripId)).toBe(0);
	});

	// Zero is a real stake of nothing; NaN, Infinity and negatives are garbage
	// input and still normalize to 0 rather than to a silent 1.
	it('normalizes negative, NaN and Infinity weights to 0', () => {
		const f = threeWayFixture('bad-weights');
		const fourth = createUser('bad-weights-fourth');
		expect(members.inviteToTrip(f.tripId, f.organizer, auth.findUserById(fourth)!.email)).toBe(
			'added'
		);

		const id = expenses.addExpense(
			f.tripId,
			f.organizer,
			f.payer,
			'Ferry',
			6000,
			'USD',
			[
				{ userId: f.organizer, weight: 3 },
				{ userId: f.member, weight: -2 },
				{ userId: fourth, weight: Number.NaN }
			],
			'shares'
		)!;
		expect(id).toBeTruthy();

		expect(storedWeights(id)).toEqual(
			new Map([
				[f.organizer, 3],
				[f.member, 0],
				[fourth, 0]
			])
		);

		const bals = balanceMap(expenses.balances(f.tripId));
		expect(bals.get(f.organizer)).toBe(-6000);
		expect(bals.get(f.member)).toBe(0);
		expect(bals.get(fourth)).toBe(0);
		expect(bals.get(f.payer)).toBe(6000);
		expect(sumBalances(f.tripId)).toBe(0);
	});

	it('stores Infinity as 0 too', () => {
		const f = threeWayFixture('infinite-weight');
		const id = expenses.addExpense(
			f.tripId,
			f.organizer,
			f.payer,
			'Bus',
			500,
			'USD',
			[
				{ userId: f.organizer, weight: 1 },
				{ userId: f.member, weight: Number.POSITIVE_INFINITY }
			],
			'shares'
		)!;
		expect(storedWeights(id)).toEqual(
			new Map([
				[f.organizer, 1],
				[f.member, 0]
			])
		);
		expect(sumBalances(f.tripId)).toBe(0);
	});

	// Documents the boundary rather than blessing it: persistence stores all
	// zeros faithfully, and `splitByWeight` then falls back to an even split so
	// no money is dropped. Whether the route should reject this is a product
	// call, not a persistence one.
	it('records an all-zero-weight expense as stored zeros with an even-split fallback', () => {
		const f = threeWayFixture('all-zero');
		const id = expenses.addExpense(
			f.tripId,
			f.organizer,
			f.payer,
			'Mystery',
			1000,
			'USD',
			[
				{ userId: f.organizer, weight: 0 },
				{ userId: f.member, weight: 0 }
			],
			'shares'
		)!;
		expect(storedWeights(id)).toEqual(
			new Map([
				[f.organizer, 0],
				[f.member, 0]
			])
		);
		const bals = balanceMap(expenses.balances(f.tripId));
		expect(bals.get(f.organizer)).toBe(-500);
		expect(bals.get(f.member)).toBe(-500);
		expect(bals.get(f.payer)).toBe(1000);
		expect(sumBalances(f.tripId)).toBe(0);
	});

	function storedWeights(expenseId: string): Map<string, number> {
		const rows = db
			.prepare(`SELECT user_id, weight FROM expense_participants WHERE expense_id = ?`)
			.all(expenseId) as { user_id: string; weight: number }[];
		return new Map(rows.map((r) => [r.user_id, r.weight]));
	}
});

function snapshotRemovalCounts(tripId: string, userId: string) {
	const paid = db
		.prepare(
			`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM expenses WHERE payer_id = ? AND trip_id = ?`
		)
		.get(userId, tripId) as { n: number; cents: number };
	return {
		expensesPaid: paid.n,
		expensesPaidCents: paid.cents,
		expenseShares: scalar(
			`SELECT COUNT(*) FROM expense_participants p JOIN expenses e ON e.id = p.expense_id WHERE p.user_id = ? AND e.trip_id = ?`,
			userId,
			tripId
		),
		otherPeopleSharesLost: scalar(
			`SELECT COUNT(*) FROM expense_participants p JOIN expenses e ON e.id = p.expense_id WHERE e.payer_id = ? AND e.trip_id = ? AND p.user_id <> ?`,
			userId,
			tripId,
			userId
		),
		poiVotes: scalar(
			`SELECT COUNT(*) FROM poi_votes v JOIN pois p ON p.id = v.poi_id WHERE v.user_id = ? AND p.trip_id = ?`,
			userId,
			tripId
		),
		lodgingVotes: scalar(
			`SELECT COUNT(*) FROM lodging_votes v JOIN cities c ON c.id = v.city_id WHERE v.user_id = ? AND c.trip_id = ?`,
			userId,
			tripId
		),
		itemAssignments: scalar(
			`SELECT COUNT(*) FROM item_assignees a JOIN schedule_items i ON i.id = a.item_id JOIN tracks t ON t.id = i.track_id WHERE a.user_id = ? AND t.trip_id = ?`,
			userId,
			tripId
		),
		taskAssignments: scalar(
			`SELECT COUNT(*) FROM task_assignees a JOIN trip_tasks t ON t.id = a.task_id WHERE a.user_id = ? AND t.trip_id = ?`,
			userId,
			tripId
		),
		taskCompletions: scalar(
			`SELECT COUNT(*) FROM task_done d JOIN trip_tasks t ON t.id = d.task_id WHERE d.user_id = ? AND t.trip_id = ?`,
			userId,
			tripId
		),
		partySegments: scalar(
			`SELECT COUNT(*) FROM party_membership pm JOIN parties p ON p.id = pm.party_id WHERE pm.user_id = ? AND p.trip_id = ?`,
			userId,
			tripId
		),
		invitesSent: scalar(
			`SELECT COUNT(*) FROM trip_invites WHERE invited_by = ? AND trip_id = ?`,
			userId,
			tripId
		),
		memberships: scalar(
			`SELECT COUNT(*) FROM memberships WHERE user_id = ? AND trip_id = ?`,
			userId,
			tripId
		),
		tripsOrganized: scalar(
			`SELECT COUNT(*) FROM trips WHERE organizer_id = ? AND id = ?`,
			userId,
			tripId
		)
	};
}

function scalar(sql: string, ...args: unknown[]): number {
	const row = db.prepare(sql).get(...args) as Record<string, number> | undefined;
	return Number(row?.[Object.keys(row)[0]] ?? 0);
}

function zeroCounts() {
	return {
		expensesPaid: 0,
		expensesPaidCents: 0,
		expenseShares: 0,
		otherPeopleSharesLost: 0,
		poiVotes: 0,
		lodgingVotes: 0,
		itemAssignments: 0,
		taskAssignments: 0,
		taskCompletions: 0,
		partySegments: 0,
		invitesSent: 0,
		memberships: 0,
		tripsOrganized: 0
	};
}

function sumBalances(tripId: string): number {
	return expenses.balances(tripId).reduce((sum, b) => sum + b.netCents, 0);
}

function balanceMap(rows: { id: string; netCents: number }[]): Map<string, number> {
	return new Map(rows.map((row) => [row.id, row.netCents]));
}

expect.addSnapshotSerializer({
	test: (value) => value instanceof Date,
	print: (value) => (value as Date).toISOString()
});
