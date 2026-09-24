import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { splitByWeight } from '@trippy/core/split';
import { MAX_NAME_LENGTH, nameTooLong } from '@trippy/core/validate';
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
let tasks: typeof import('../src/persistence/tasks.ts');
let costs: typeof import('../src/persistence/costs.ts');

interface Fixture {
	organizer: string;
	member: string;
	outsider: string;
	tripId: string;
	cityId: string;
}

beforeAll(async () => {
	[{ db }, auth, trips, schedule, members, expenses, events, pois, lodging, tasks, costs] =
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
			import('../src/persistence/tasks.ts'),
			import('../src/persistence/costs.ts')
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
	expect(members.addPerson(tripId, organizer, 'Guest', auth.findUserById(member)!.email)).toBe(
		'added'
	);
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
	return schedule.createEvent(f.tripId, f.organizer, {
		day: '2026-10-01',
		title: 'Museum',
		startMin: 9 * 60,
		endMin: 10 * 60,
		type: 'activity',
		lat: 37.98,
		lng: 23.73,
		people: [f.organizer]
	})!;
}

function itemRow(itemId: string) {
	return db.prepare(`SELECT title, start_min, end_min FROM events WHERE id = ?`).get(itemId) as
		{ title: string; start_min: number; end_min: number } | undefined;
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
			name: 'moveEvent',
			run: (itemId: string, actor: string, tripId: string) =>
				schedule.moveEvent(itemId, actor, 11 * 60, tripId),
			assertUnchanged: (itemId: string) => expect(itemRow(itemId)!.start_min).toBe(9 * 60)
		},
		{
			name: 'resizeEvent',
			run: (itemId: string, actor: string, tripId: string) =>
				schedule.resizeEvent(itemId, actor, 12 * 60, tripId),
			assertUnchanged: (itemId: string) => expect(itemRow(itemId)!.end_min).toBe(10 * 60)
		},
		{
			name: 'editEvent',
			// Normalised to a boolean: this table is about refusal, and `editEvent`
			// now answers with a `WriteResult` so a stale save can be told apart
			// from a missing row.
			run: (itemId: string, actor: string, tripId: string) =>
				schedule.editEvent(itemId, actor, { title: 'Changed' }, tripId).ok,
			assertUnchanged: (itemId: string) => expect(itemRow(itemId)!.title).toBe('Museum')
		},
		{
			name: 'deleteEvent',
			run: (itemId: string, actor: string, tripId: string) =>
				schedule.deleteEvent(itemId, actor, tripId),
			assertUnchanged: (itemId: string) => expect(itemRow(itemId)).toBeDefined()
		},
		{
			name: 'setEventPeople',
			run: (itemId: string, actor: string, tripId: string) =>
				schedule.setEventPeople(itemId, tripId, actor, []),
			assertUnchanged: (itemId: string) =>
				expect(tableCount('event_people', 'event_id = ?', itemId)).toBe(1)
		}
	];

	it.each(cases)('$name rejects a valid event id when the caller passes another trip id', (c) => {
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

	it('keeps a crew inside its own trip', () => {
		const tripA = createTripFixture('crew-a');
		const tripB = createTripFixture('crew-b');
		const crewA = schedule.createCrew(tripA.tripId, tripA.organizer, 'Split', [tripA.organizer])!;

		// A crew is only a saved selection of people, so the guard it needs is the
		// simple one the old party_day cross-id check existed for: nobody reaches
		// another trip's crew by naming their own trip.
		expect(schedule.editCrew(crewA, tripB.tripId, tripB.organizer, 'Renamed', undefined)).toBe(
			false
		);
		expect(schedule.deleteCrew(crewA, tripB.tripId, tripB.organizer)).toBe(false);
		expect(schedule.crewsForTrip(tripA.tripId).find((x) => x.id === crewA)).toMatchObject({
			name: 'Split'
		});
	});

	it('gives every trip an Everyone crew that follows the roster', () => {
		const f = createTripFixture('crew-everyone');
		const everyone = schedule.crewsForTrip(f.tripId)[0];

		// First, because it is the group asked for most often, and locked because
		// it is derived: there is no row behind it to rename or delete.
		expect(everyone).toMatchObject({ id: 'everyone', name: 'Everyone', locked: true });
		expect([...everyone.members].sort()).toEqual([f.organizer, f.member].sort());
		expect(everyone.members).not.toContain(f.outsider);

		expect(schedule.editCrew('everyone', f.tripId, f.organizer, 'Us', undefined)).toBe(false);
		expect(schedule.deleteCrew('everyone', f.tripId, f.organizer)).toBe(false);
		expect(schedule.crewsForTrip(f.tripId)[0]).toMatchObject({ name: 'Everyone' });

		// Derived on every read, so joining and leaving need no crew bookkeeping.
		expect(members.addPerson(f.tripId, f.organizer, 'Zoe', '')).toBe('created');
		const joined = schedule.crewsForTrip(f.tripId)[0].members;
		expect(joined).toHaveLength(3);
		expect(members.removeMember(f.tripId, f.organizer, f.member)).toBe(true);
		expect(schedule.crewsForTrip(f.tripId)[0].members).not.toContain(f.member);
	});

	it('keeps only trip members on a crew, and on an event', () => {
		const f = createTripFixture('crew-roster');
		const crew = schedule.createCrew(f.tripId, f.organizer, 'Crew', [f.organizer, f.outsider])!;
		expect(schedule.crewsForTrip(f.tripId).find((x) => x.id === crew)!.members).toEqual([
			f.organizer
		]);

		const itemId = createScheduleItem(f);
		expect(schedule.setEventPeople(itemId, f.tripId, f.organizer, [f.member, f.outsider])).toBe(
			true
		);
		expect(tableCount('event_people', 'event_id = ?', itemId)).toBe(1);
		expect(crew).toBeTruthy();
	});
});

describe('ticking a task box', () => {
	function assignedTask(label: string) {
		const f = createTripFixture(label);
		const taskId = tasks.addTask(
			f.tripId,
			f.organizer,
			'prep',
			'Book the ferry',
			[f.member],
			null
		)!;
		return { f, taskId };
	}

	function row(tripId: string, taskId: string) {
		return tasks.listTasks(tripId, 'prep').find((t) => t.id === taskId)!;
	}

	// Completion records who the task is for, not who pressed the button: a trip
	// gets planned out loud, and the phone is not always in the assignee's hand.
	it('lets any member tick a box for someone else', () => {
		const { f, taskId } = assignedTask('toggle-other');
		expect(tasks.toggleTask(f.tripId, f.organizer, taskId, f.member).ok).toBe(true);
		expect(row(f.tripId, taskId).done).toBe(true);

		expect(tasks.toggleTask(f.tripId, f.organizer, taskId, f.member).ok).toBe(true);
		expect(row(f.tripId, taskId).done).toBe(false);
	});

	it('refuses a non-member, and a target the task is not assigned to', () => {
		const { f, taskId } = assignedTask('toggle-refuse');
		expect(tasks.toggleTask(f.tripId, f.outsider, taskId, f.member).ok).toBe(false);
		expect(tasks.toggleTask(f.tripId, f.organizer, taskId, f.organizer).ok).toBe(false);
		expect(row(f.tripId, taskId).doneCount).toBe(0);
	});

	// Editing is the alternative to deleting and re-adding, so the ticks of
	// everyone still on the task have to survive it.
	it('keeps the ticks of everyone still on an edited task', () => {
		const { f, taskId } = assignedTask('edit-keeps');
		tasks.toggleTask(f.tripId, f.member, taskId, f.member);

		expect(
			tasks.updateTask(f.tripId, f.organizer, taskId, 'Book the 9:40 ferry', [
				f.member,
				f.organizer
			]).ok
		).toBe(true);

		const r = row(f.tripId, taskId);
		expect(r.label).toBe('Book the 9:40 ferry');
		expect(r.people.map((p) => p.done)).toEqual([true, false]);
		expect(r.done).toBe(false);
	});

	// A tick left behind by someone the task is no longer for would count
	// towards a row they have nothing to do with.
	it('drops the tick of someone taken off a task', () => {
		const { f, taskId } = assignedTask('edit-drops');
		tasks.toggleTask(f.tripId, f.member, taskId, f.member);
		expect(row(f.tripId, taskId).doneCount).toBe(1);

		expect(
			tasks.updateTask(f.tripId, f.organizer, taskId, 'Book the ferry', [f.organizer]).ok
		).toBe(true);
		expect(row(f.tripId, taskId).doneCount).toBe(0);

		// Back on the task, and the old tick has not come back with them.
		tasks.updateTask(f.tripId, f.organizer, taskId, 'Book the ferry', [f.member, f.organizer]);
		expect(row(f.tripId, taskId).doneCount).toBe(0);
	});

	it('refuses to edit for a non-member, or a task in another trip', () => {
		const { f, taskId } = assignedTask('edit-refuse');
		const other = createTripFixture('edit-refuse-other');
		expect(tasks.updateTask(f.tripId, f.outsider, taskId, 'Anything', []).ok).toBe(false);
		expect(tasks.updateTask(other.tripId, other.organizer, taskId, 'Anything', []).ok).toBe(false);
		expect(row(f.tripId, taskId).label).toBe('Book the ferry');
	});

	// A packing item is your own bag, so it takes one shared tick and never a
	// roster. The rule lives here rather than in the form so an older client
	// cannot put one back on.
	it('drops the roster sent with a packing item, and keeps it to its owner', () => {
		const f = createTripFixture('packing-unassigned');
		const id = tasks.addTask(f.tripId, f.organizer, 'packing', 'Passport', [f.member], null)!;
		const item = () => tasks.listTasks(f.tripId, 'packing', f.organizer).find((t) => t.id === id)!;
		expect(item().people).toEqual([]);

		expect(tasks.updateTask(f.tripId, f.organizer, id, 'Passport', [f.member]).ok).toBe(true);
		expect(item().people).toEqual([]);

		// A packing list is private: nobody else's list holds it, and nobody else
		// may tick it, rename it or throw it out.
		expect(tasks.listTasks(f.tripId, 'packing', f.member)).toEqual([]);
		expect(tasks.toggleTask(f.tripId, f.member, id).ok).toBe(false);
		expect(tasks.updateTask(f.tripId, f.member, id, 'Their passport').ok).toBe(false);
		expect(tasks.removeTask(f.tripId, f.member, id)).toBe(false);

		// With nobody on it, the shared flag is what its owner's box ticks.
		expect(tasks.toggleTask(f.tripId, f.organizer, id).ok).toBe(true);
		expect(item().done).toBe(true);
	});
});

describe('who an estimate is for', () => {
	it('keeps only trip members on the line, and treats an empty roster as everyone', () => {
		const f = createTripFixture('cost-roster');
		expect(
			costs.addCostItem(f.tripId, f.organizer, {
				category: 'lodging',
				label: 'Single supplement',
				cents: 9000,
				assignees: [f.member, f.outsider, f.member]
			})
		).toBe(true);

		const item = () => costs.listCostItems(f.tripId)[0];
		// The outsider is not on the trip, and the duplicate is one person.
		expect(item().people.map((p) => p.id)).toEqual([f.member]);

		expect(
			costs.updateCostItem(f.tripId, f.organizer, item().id, {
				category: 'lodging',
				label: 'Single supplement',
				cents: 9000,
				assignees: []
			})
		).toBe(true);
		expect(item().people).toEqual([]);
	});

	it('drops a departed member from the line it was for', () => {
		const f = createTripFixture('cost-roster-cascade');
		costs.addCostItem(f.tripId, f.organizer, {
			category: 'food',
			label: 'Tasting menu',
			cents: 12000,
			assignees: [f.member]
		});
		const id = costs.listCostItems(f.tripId)[0].id;

		expect(members.removeMember(f.tripId, f.organizer, f.member)).toBe(true);
		// The line survives the removal; the person stops being one of its heads.
		expect(costs.listCostItems(f.tripId).find((i) => i.id === id)!.people).toEqual([]);
	});
});

describe('member removal cascade', () => {
	it('keeps a placeholder who is named on an expense, so their money does not leave with them', () => {
		const f = createTripFixture('placeholder');
		expect(members.addPerson(f.tripId, f.organizer, 'Guest', 'guest@example.test')).toBe('invited');
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
		expect(schedule.setEventPeople(itemId, f.tripId, f.organizer, [placeholder.id])).toBe(true);
		const taskId = tasks.addTask(f.tripId, f.organizer, 'prep', 'Pack', [placeholder.id], null)!;
		expect(tasks.toggleTask(f.tripId, placeholder.id, taskId).ok).toBe(true);
		const crew = schedule.createCrew(f.tripId, f.organizer, 'Crew', [placeholder.id])!;
		expect(crew).toBeTruthy();
		const before = snapshotRemovalCounts(f.tripId, placeholder.id);

		expect(before.expensesPaid).toBe(1);
		expect(before.expensesPaidCents).toBe(999);
		expect(before.expenseShares).toBe(2);
		expect(before.otherPeopleSharesLost).toBe(2);
		expect(before.poiVotes).toBe(1);
		expect(before.lodgingVotes).toBe(1);
		expect(before.eventAssignments).toBe(1);
		expect(before.taskAssignments).toBe(1);
		expect(before.taskCompletions).toBe(1);
		expect(before.crewMemberships).toBe(1);

		expect(members.removeMember(f.tripId, f.organizer, placeholder.id)).toBe(true);

		// They are off the trip, but the `users` row stays. Deleting it would
		// cascade, and that cascade takes the expense they paid and the shares
		// other people were charged on it: 999 cents and two other members'
		// portions would disappear from a ledger the group had already agreed.
		// An invitee who owes money is therefore removed the same way a
		// registered member is.
		expect(auth.findUserById(placeholder.id)).toBeTruthy();
		expect(members.listPeople(f.tripId).some((p) => p.id === placeholder.id)).toBe(false);

		const after = snapshotRemovalCounts(f.tripId, placeholder.id);
		expect(after.expensesPaid).toBe(1);
		expect(after.expensesPaidCents).toBe(999);
		expect(after.otherPeopleSharesLost).toBe(2);
		expect(db.prepare(`SELECT 1 FROM expenses WHERE id = ?`).get(paidByPlaceholder)).toBeTruthy();
		expect(tableCount('expense_participants', 'expense_id = ?', paidByPlaceholder)).toBe(3);

		// Nothing was guessed at on their behalf, so every row they are still on
		// says a human needs to look at it.
		for (const row of expenses.listExpenses(f.tripId)) expect(row.needsReview).toBe(true);
		expect(expenses.balances(f.tripId).reduce((n, b) => n + b.netCents, 0)).toBe(0);
	});

	it('deletes a placeholder who is on no expense, and everything that cascades from their user row', () => {
		const f = createTripFixture('placeholder-clean');
		expect(members.addPerson(f.tripId, f.organizer, 'Guest', 'ghost@example.test')).toBe('invited');
		const placeholder = members.listPeople(f.tripId).find((p) => p.placeholder)!;

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
		expect(pois.toggleVote(f.tripId, placeholder.id, poiId)).toBe(true);
		const stayId = lodging.addOption(f.tripId, f.organizer, f.cityId, 'Hostel')!;
		expect(lodging.vote(f.tripId, placeholder.id, stayId)).toBe(true);
		const taskId = tasks.addTask(f.tripId, f.organizer, 'prep', 'Pack', [placeholder.id], null)!;
		expect(tasks.toggleTask(f.tripId, placeholder.id, taskId).ok).toBe(true);

		expect(members.removeMember(f.tripId, f.organizer, placeholder.id)).toBe(true);

		// Nothing financial points at them, so there is nothing to preserve and a
		// row left behind would be invisible and unreachable.
		expect(auth.findUserById(placeholder.id)).toBeUndefined();
		expect(snapshotRemovalCounts(f.tripId, placeholder.id)).toEqual(zeroCounts());
	});

	it('renames a placeholder but not a member who owns their own account', () => {
		const f = createTripFixture('rename');
		expect(members.addPerson(f.tripId, f.organizer, 'Guest', 'guest@example.test')).toBe('invited');
		const placeholder = members.listPeople(f.tripId).find((p) => p.placeholder)!;

		expect(members.renameMember(f.tripId, f.organizer, placeholder.id, '  Aunt Mei  ')).toBe(true);
		expect(members.listPeople(f.tripId).find((p) => p.id === placeholder.id)!.name).toBe(
			'Aunt Mei'
		);

		// A registered member's name is their account's, shared with every other
		// trip they are on, so nobody else's organizer gets to change it.
		expect(members.renameMember(f.tripId, f.organizer, f.member, 'Nickname')).toBe(false);
		// And a member who is not the organizer cannot rename anyone.
		expect(members.renameMember(f.tripId, f.member, placeholder.id, 'Someone else')).toBe(false);
		expect(members.renameMember(f.tripId, f.organizer, placeholder.id, '   ')).toBe(false);
		expect(members.listPeople(f.tripId).find((p) => p.id === placeholder.id)!.name).toBe(
			'Aunt Mei'
		);
	});

	it('removes only the membership row for a registered member', () => {
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
		const before = snapshotRemovalCounts(f.tripId, f.member);

		expect(before.expensesPaid).toBe(1);
		expect(before.expenseShares).toBe(1);
		expect(before.otherPeopleSharesLost).toBe(1);
		expect(before.poiVotes).toBe(1);

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
		crewId: string;
	}

	/**
	 * A placeholder carrying a row in every table that cascades off `users(id)`.
	 * If any of these is not relinked on registration, the cascade behind
	 * `DELETE FROM users` destroys it silently.
	 */
	function placeholderWithFullHistory(f: Fixture): Placeholder {
		const email = `invitee-${crypto.randomUUID()}@example.test`;
		expect(members.addPerson(f.tripId, f.organizer, 'Guest', email)).toBe('invited');
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
		expect(schedule.setEventPeople(itemId, f.tripId, f.organizer, [id])).toBe(true);
		const taskId = tasks.addTask(f.tripId, f.organizer, 'prep', 'Pack', [id], null)!;
		expect(tasks.toggleTask(f.tripId, id, taskId).ok).toBe(true);
		const crewId = schedule.createCrew(f.tripId, f.organizer, 'Crew', [id])!;

		return { id, email, expenseId, poiId, optionId, itemId, taskId, crewId };
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
		expect(before.eventAssignments).toBe(1);
		expect(before.taskAssignments).toBe(1);
		expect(before.taskCompletions).toBe(1);
		expect(before.crewMemberships).toBe(1);

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
		expect(tableCount('event_people', 'event_id = ? AND user_id = ?', ph.itemId, real.id)).toBe(1);
		expect(tableCount('task_assignees', 'task_id = ? AND user_id = ?', ph.taskId, real.id)).toBe(1);
		expect(tableCount('task_done', 'task_id = ? AND user_id = ?', ph.taskId, real.id)).toBe(1);
		expect(tableCount('crew_members', 'crew_id = ? AND user_id = ?', ph.crewId, real.id)).toBe(1);

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
		expect(members.addPerson(f.tripId, f.organizer, 'Guest', email)).toBe('added');

		const ghost = `ghost-${crypto.randomUUID()}@example.test`;
		expect(members.addPerson(f.tripId, f.organizer, 'Guest', ghost)).toBe('invited');
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
		expect(schedule.setEventPeople(itemId, f.tripId, f.organizer, [real.id, phId])).toBe(true);
		const taskId = tasks.addTask(f.tripId, f.organizer, 'prep', 'Visa', [real.id, phId], null)!;
		expect(tasks.toggleTask(f.tripId, real.id, taskId).ok).toBe(true);
		expect(tasks.toggleTask(f.tripId, phId, taskId).ok).toBe(true);
		const crewId = schedule.createCrew(f.tripId, f.organizer, 'Crew', [real.id, phId])!;

		// Rows in the same tables that do NOT collide, so the merge has to both
		// collapse duplicates and carry the placeholder's own history across.
		const soloItem = createScheduleItem(f);
		expect(schedule.setEventPeople(soloItem, f.tripId, f.organizer, [phId])).toBe(true);
		const soloTask = tasks.addTask(f.tripId, f.organizer, 'prep', 'Insurance', [phId], null)!;
		expect(tasks.toggleTask(f.tripId, phId, soloTask).ok).toBe(true);

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
		expect(tableCount('event_people', 'event_id = ?', itemId)).toBe(1);
		expect(tableCount('event_people', 'event_id = ? AND user_id = ?', itemId, real.id)).toBe(1);
		expect(tableCount('task_assignees', 'task_id = ?', taskId)).toBe(1);
		expect(tableCount('task_done', 'task_id = ?', taskId)).toBe(1);
		expect(tableCount('crew_members', 'crew_id = ?', crewId)).toBe(1);
		expect(tableCount('crew_members', 'crew_id = ? AND user_id = ?', crewId, real.id)).toBe(1);

		// On a collision the real account keeps the completion it made itself.
		expect(
			scalar(`SELECT done_at FROM task_done WHERE task_id = ? AND user_id = ?`, taskId, real.id)
		).toBe(1111);

		// The non-colliding row still moves: payer_id is under no unique index.
		expect(tableCount('expenses', 'id = ? AND payer_id = ?', placeholderExpense, real.id)).toBe(1);
		// The placeholder's own, non-colliding assignments survive the merge too.
		expect(tableCount('event_people', 'event_id = ? AND user_id = ?', soloItem, real.id)).toBe(1);
		expect(tableCount('task_assignees', 'task_id = ? AND user_id = ?', soloTask, real.id)).toBe(1);
		expect(tableCount('task_done', 'task_id = ? AND user_id = ?', soloTask, real.id)).toBe(1);
		expect(tableCount('trip_invites', 'trip_id = ? AND email = ?', f.tripId, email)).toBe(0);
	});

	// The old party_membership was time-segmented, so a relink had to decide what
	// to do with two overlapping-but-different windows and deliberately left that
	// unresolved. A crew is a plain set of people, so the question is gone: a
	// collision collapses and everything else moves.
	it('merges crew membership as a set, keeping crews the placeholder alone was in', () => {
		const f = createTripFixture('relink-crews');
		const email = `crew-${crypto.randomUUID()}@example.test`;
		const real = auth.createUser(email, 'Crewmate', 'password123');
		expect(members.addPerson(f.tripId, f.organizer, 'Guest', email)).toBe('added');
		const ghost = `ghost-${crypto.randomUUID()}@example.test`;
		expect(members.addPerson(f.tripId, f.organizer, 'Guest', ghost)).toBe('invited');
		const phId = members.listPeople(f.tripId).find((p) => p.placeholder)!.id;

		const crew = schedule.createCrew(f.tripId, f.organizer, 'Crew', [real.id, phId])!;
		const other = schedule.createCrew(f.tripId, f.organizer, 'Other', [phId])!;

		db.prepare(`UPDATE trip_invites SET email = ? WHERE trip_id = ? AND email = ?`).run(
			email,
			f.tripId,
			ghost
		);
		members.consumeInvites(real.id, email);

		expect(tableCount('crew_members', 'user_id = ?', real.id)).toBe(2);
		expect(tableCount('crew_members', 'crew_id = ?', crew)).toBe(1);
		expect(tableCount('crew_members', 'crew_id = ? AND user_id = ?', other, real.id)).toBe(1);
		expect(tableCount('crew_members', 'user_id = ?', phId)).toBe(0);
	});
});

describe('balances survive a departure', () => {
	// This used to be a known bug: `balances()` reported only current members, so
	// a removed participant's stake vanished from the total and the ledger stopped
	// summing to zero without anybody being told. It is now covered properly in
	// `concurrency.test.ts`; this case stays as the regression pin for the
	// simplest shape of it.
	it('still sums to zero after a participant is removed', () => {
		const f = createTripFixture('removed-participant');
		expenses.addExpense(f.tripId, f.organizer, f.member, 'Tickets', 1200, 'USD', [
			{ userId: f.organizer, weight: 1 },
			{ userId: f.member, weight: 1 }
		]);
		expect(sumBalances(f.tripId)).toBe(0);

		expect(members.removeMember(f.tripId, f.organizer, f.member)).toBe(true);

		expect(sumBalances(f.tripId)).toBe(0);
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
		const event = createScheduleItem(tripA);
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
		expect(event).toBeTruthy();
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
			['expenses', 'spent_on', 'TEXT'],
			['expense_participants', 'weight', 'REAL'],
			['cities', 'photo', 'TEXT'],
			['cities', 'region', 'TEXT'],
			['trips', 'start_date', 'TEXT'],
			['trips', 'end_date', 'TEXT'],
			['events', 'travel_mode', 'TEXT']
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

		// The tracks model is gone, and its tables go with it. This is the one
		// destructive step in db.ts, so it is pinned here: a stale table left
		// behind would let a forgotten caller keep writing to it unnoticed.
		const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
			name: string;
		}[];
		for (const gone of [
			'tracks',
			'schedule_items',
			'item_assignees',
			'parties',
			'party_day',
			'party_membership'
		]) {
			expect(tables.map((t) => t.name)).not.toContain(gone);
		}
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
		// `events.lodging_id` and `events.city_id` are both ON DELETE SET NULL, so
		// deleting the thing an event was booked into leaves the event standing
		// with the link cleared rather than taking the block off the day.
		const stayId = schedule.createEvent(f.tripId, f.organizer, {
			day: '2026-10-01',
			title: 'Hotel',
			type: 'stay',
			startMin: 21 * 60,
			endMin: 9 * 60,
			cityId: f.cityId,
			lodgingId: optionId,
			people: [f.organizer]
		})!;

		db.prepare(`DELETE FROM lodging_options WHERE id = ?`).run(optionId);
		expect(scalarOrNull(`SELECT lodging_id FROM events WHERE id = ?`, stayId)).toBeNull();
		db.prepare(`DELETE FROM cities WHERE id = ?`).run(f.cityId);
		expect(scalarOrNull(`SELECT city_id FROM events WHERE id = ?`, stayId)).toBeNull();
		db.prepare(`DELETE FROM users WHERE id = ?`).run(placeholder);

		expect(db.prepare(`SELECT 1 FROM expenses WHERE id = ?`).get(expenseId)).toBeUndefined();
		expect(tableCount('expense_participants', 'expense_id = ?', expenseId)).toBe(0);
		expect(tableCount('poi_votes', 'poi_id = ? AND user_id = ?', poiId, placeholder)).toBe(0);
		expect(tableCount('memberships', 'user_id = ?', placeholder)).toBe(0);
	});
});

describe('trip name length', () => {
	it('holds a trip name to the same limit as every other name', () => {
		const organizer = createUser('trip-name-length');
		const tooLong = 'Z'.repeat(MAX_NAME_LENGTH + 1);

		const created = trips.createTrip(organizer, {
			name: tooLong,
			startDate: '2026-10-01',
			endDate: '2026-10-03',
			homeCurrency: 'USD'
		});
		expect(created.id).toBeNull();
		expect(created.error).toBe(nameTooLong());

		const atLimit = trips.createTrip(organizer, {
			name: 'Z'.repeat(MAX_NAME_LENGTH),
			startDate: '2026-10-01',
			endDate: '2026-10-03',
			homeCurrency: 'USD'
		});
		expect(atLimit.id).not.toBeNull();

		const f = createTripFixture('trip-name-length-edit');
		expect(
			trips.updateTrip(f.tripId, f.organizer, {
				name: tooLong,
				startDate: '2026-10-01',
				endDate: '2026-10-03',
				currency: 'USD'
			})
		).toBe(nameTooLong());
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

describe('duplicate cities', () => {
	it('refuses a city the trip already has, whatever the spacing or case', () => {
		const f = createTripFixture('dupe-city');
		const kyoto = {
			name: 'Kyoto',
			country: 'Japan',
			region: 'Kyoto Prefecture',
			tz: 'Asia/Tokyo'
		};
		expect(trips.addCity(f.tripId, f.organizer, kyoto)).toBeTruthy();
		expect(trips.addCity(f.tripId, f.organizer, kyoto)).toBeNull();
		expect(
			trips.addCity(f.tripId, f.organizer, { ...kyoto, name: '  kyoto ', country: 'JAPAN' })
		).toBeNull();
		expect(
			trips.getTripForUser(f.tripId, f.organizer)!.cities.filter((c) => c.name === 'Kyoto')
		).toHaveLength(1);
	});

	it('treats a blank region as the missing one it is stored as', () => {
		const f = createTripFixture('dupe-blank-region');
		expect(
			trips.addCity(f.tripId, f.organizer, {
				name: 'Singapore',
				country: 'Singapore',
				tz: 'Asia/Singapore'
			})
		).toBeTruthy();
		expect(
			trips.addCity(f.tripId, f.organizer, {
				name: 'Singapore',
				country: 'Singapore',
				region: '   ',
				tz: 'Asia/Singapore'
			})
		).toBeNull();
	});

	// The whole reason identity is not the name alone: a trip can legitimately
	// visit two different places that share one.
	it('still allows two same-named cities in different regions', () => {
		const f = createTripFixture('dupe-two-nashvilles');
		const base = { name: 'Nashville', country: 'United States', tz: 'America/Chicago' };
		expect(trips.addCity(f.tripId, f.organizer, { ...base, region: 'Tennessee' })).toBeTruthy();
		expect(trips.addCity(f.tripId, f.organizer, { ...base, region: 'Georgia' })).toBeTruthy();
	});

	it('will not rename one city onto another, but leaves a city saving itself alone', () => {
		const f = createTripFixture('dupe-rename');
		const lisbon = trips.addCity(f.tripId, f.organizer, {
			name: 'Lisbon',
			country: 'Portugal',
			region: 'Lisbon',
			tz: 'Europe/Lisbon'
		})!;
		const porto = trips.addCity(f.tripId, f.organizer, {
			name: 'Porto',
			country: 'Portugal',
			region: 'Porto',
			tz: 'Europe/Lisbon'
		})!;
		expect(
			trips.updateCity(f.tripId, f.organizer, porto, {
				name: 'Lisbon',
				country: 'Portugal',
				region: 'Lisbon',
				tz: 'Europe/Lisbon'
			})
		).toBe(false);
		expect(cityRow(porto).name).toBe('Porto');
		// Saving a city without changing its name is not a collision with itself.
		expect(
			trips.updateCity(f.tripId, f.organizer, lisbon, {
				name: 'Lisbon',
				country: 'Portugal',
				region: 'Lisbon',
				tz: 'Atlantic/Azores'
			})
		).toBe(true);
		expect(cityRow(lisbon).tz).toBe('Atlantic/Azores');
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
		expect(members.addPerson(f.tripId, f.organizer, 'Guest', auth.findUserById(third)!.email)).toBe(
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

	it('divides an expense into per-person shares that sum to it and match the balances', () => {
		const f = createTripFixture('shares-view');
		const third = createUser('shares-third');
		expect(members.addPerson(f.tripId, f.organizer, 'Guest', auth.findUserById(third)!.email)).toBe(
			'added'
		);

		expenses.addExpense(f.tripId, f.organizer, f.organizer, 'Uneven bill', 1000, 'USD', [
			{ userId: f.organizer, weight: 1 },
			{ userId: f.member, weight: 1 },
			{ userId: third, weight: 1 }
		]);
		expenses.addExpense(f.tripId, f.organizer, f.member, 'Just the two of us', 500, 'USD', [
			{ userId: f.member, weight: 1 },
			{ userId: third, weight: 1 }
		]);

		const splits = [...expenses.expenseShares(f.tripId).values()];
		for (const s of splits) {
			const sum = Object.values(s.shares).reduce((n, cents) => n + cents, 0);
			expect(sum).toBe(s.totalCents);
		}

		// What the ledger charges a person, read row by row, is exactly what their
		// balance is built from: paid minus owed.
		const owedBy = (id: string) =>
			splits.reduce((n, s) => n + (s.shares[id] ?? 0), 0) -
			splits.reduce((n, s) => n + (s.payerId === id ? s.totalCents : 0), 0);
		for (const b of expenses.balances(f.tripId)) expect(b.netCents).toBe(-owedBy(b.id));
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
		expect(members.addPerson(tripId, organizer, 'Guest', auth.findUserById(member)!.email)).toBe(
			'added'
		);

		expenses.addExpense(tripId, organizer, organizer, 'USD meal', 1000, 'USD', [
			{ userId: organizer, weight: 1 },
			{ userId: member, weight: 1 }
		]);

		const balances = expenses.balances(tripId);
		expect(balances.reduce((sum, b) => sum + b.netCents, 0)).toBe(0);
		expect(balances.map((b) => b.netCents).sort((a, b) => a - b)).toEqual([-460, 460]);
	});
});

/**
 * An expense is dated by the day it happened, not the keystroke that recorded
 * it. The two are the same thing right up until somebody reconciles a week of
 * receipts on the flight home, which is the case this column exists for.
 */
describe('the day an expense happened', () => {
	const today = (): string => new Date().toISOString().slice(0, 10);

	function addOn(f: Fixture, description: string, spentOn?: string | null): string {
		return expenses.addExpense(
			f.tripId,
			f.organizer,
			f.organizer,
			description,
			1000,
			'USD',
			[
				{ userId: f.organizer, weight: 1 },
				{ userId: f.member, weight: 1 }
			],
			'even',
			spentOn
		)!;
	}

	function rowFor(f: Fixture, id: string) {
		return expenses.listExpenses(f.tripId).find((e) => e.id === id)!;
	}

	it('stores the day it is given and falls back to today when it is not', () => {
		const f = createTripFixture('spent-on');

		expect(rowFor(f, addOn(f, 'Backdated lunch', '2026-10-02')).spent_on).toBe('2026-10-02');
		// No date at all, so the day it was entered is the only honest answer.
		expect(rowFor(f, addOn(f, 'Typed just now')).spent_on).toBe(today());
		// A date is descriptive, so unusable input is backstopped rather than
		// allowed to throw the whole expense away.
		for (const bad of ['', '   ', 'yesterday', '2026-13-01', '2026-02-31', '10/02/2026']) {
			expect(rowFor(f, addOn(f, `Bad: ${bad}`, bad)).spent_on, bad).toBe(today());
		}
		// Absurd but real days are stored as typed. Bounding them is the API
		// layer's job, where there is an error channel to explain the refusal.
		expect(rowFor(f, addOn(f, 'Ancient', '1200-01-01')).spent_on).toBe('1200-01-01');
		expect(rowFor(f, addOn(f, 'Distant', '3000-01-01')).spent_on).toBe('3000-01-01');
	});

	it('keeps the stored day when an edit leaves it out, and moves it when given', () => {
		const f = createTripFixture('spent-on-edit');
		const id = addOn(f, 'Dinner', '2026-10-02');
		const parts = [
			{ userId: f.organizer, weight: 1 },
			{ userId: f.member, weight: 1 }
		];

		// An edit that says nothing about the date is not a claim that the expense
		// happened today.
		expect(
			expenses.updateExpense(
				f.tripId,
				f.organizer,
				id,
				f.organizer,
				'Dinner, actually',
				1000,
				'USD',
				parts,
				'even',
				null
			).ok
		).toBe(true);
		expect(rowFor(f, id).spent_on).toBe('2026-10-02');

		expect(
			expenses.updateExpense(
				f.tripId,
				f.organizer,
				id,
				f.organizer,
				'Dinner, actually',
				1000,
				'USD',
				parts,
				'even',
				null,
				'2026-10-03'
			).ok
		).toBe(true);
		expect(rowFor(f, id).spent_on).toBe('2026-10-03');

		// A row from before the column existed, edited without a date: there is
		// nothing to keep, so it lands on today rather than staying null.
		db.prepare(`UPDATE expenses SET spent_on = NULL WHERE id = ?`).run(id);
		expect(
			expenses.updateExpense(
				f.tripId,
				f.organizer,
				id,
				f.organizer,
				'Dinner, actually',
				1000,
				'USD',
				parts,
				'even',
				null
			).ok
		).toBe(true);
		expect(rowFor(f, id).spent_on).toBe(today());
	});

	it('lists newest day first and breaks a tie on entry time', () => {
		const f = createTripFixture('spent-on-order');
		const older = addOn(f, 'Older day', '2026-10-01');
		const sameDayFirst = addOn(f, 'Same day, entered first', '2026-10-02');
		const sameDayLast = addOn(f, 'Same day, entered last', '2026-10-02');
		const newer = addOn(f, 'Newer day', '2026-10-03');

		// Entry times are pinned rather than raced: four inserts can land inside
		// one millisecond, and the tiebreaker is exactly what is under test here.
		const stamp = db.prepare(`UPDATE expenses SET created_at = ? WHERE id = ?`);
		stamp.run(4000, older);
		stamp.run(1000, sameDayFirst);
		stamp.run(2000, sameDayLast);
		stamp.run(3000, newer);

		expect(expenses.listExpenses(f.tripId).map((e) => e.id)).toEqual([
			newer,
			sameDayLast,
			sameDayFirst,
			older
		]);
	});

	it('backfills a row written before the column existed from its entry time', async () => {
		const f = createTripFixture('spent-on-backfill');
		const legacy = crypto.randomUUID();
		db.prepare(
			`INSERT INTO expenses (id, trip_id, payer_id, description, amount_cents, currency, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(legacy, f.tripId, f.organizer, 'Legacy', 1000, 'USD', Date.UTC(2026, 9, 2, 13, 30));
		db.prepare(
			`INSERT INTO expense_participants (expense_id, user_id, weight) VALUES (?, ?, 1)`
		).run(legacy, f.organizer);
		expect(scalarOrNull(`SELECT spent_on FROM expenses WHERE id = ?`, legacy)).toBeNull();

		// Re-running the migrations is how this file exercises them; the backfill
		// is idempotent and only touches rows that have no day yet.
		(await import('../src/db.ts?spent-on-backfill')).db.close();

		expect(rowFor(f, legacy).spent_on).toBe('2026-10-02');
	});
});

describe('zero-weight participants', () => {
	interface ThreeWay extends Fixture {
		payer: string;
	}

	function threeWayFixture(label: string): ThreeWay {
		const f = createTripFixture(label);
		const payer = createUser(`${label}-payer`);
		expect(members.addPerson(f.tripId, f.organizer, 'Guest', auth.findUserById(payer)!.email)).toBe(
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
		expect(
			members.addPerson(f.tripId, f.organizer, 'Guest', auth.findUserById(fourth)!.email)
		).toBe('added');

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
		eventAssignments: scalar(
			`SELECT COUNT(*) FROM event_people a JOIN events e ON e.id = a.event_id WHERE a.user_id = ? AND e.trip_id = ?`,
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
		crewMemberships: scalar(
			`SELECT COUNT(*) FROM crew_members cm JOIN crews c ON c.id = cm.crew_id WHERE cm.user_id = ? AND c.trip_id = ?`,
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

/** The same read, for a column whose whole point is that it can be null. */
function scalarOrNull(sql: string, ...args: unknown[]): unknown {
	const row = db.prepare(sql).get(...args) as Record<string, unknown> | undefined;
	return row ? row[Object.keys(row)[0]] : undefined;
}

function zeroCounts() {
	return {
		expensesPaid: 0,
		expensesPaidCents: 0,
		expenseShares: 0,
		otherPeopleSharesLost: 0,
		poiVotes: 0,
		lodgingVotes: 0,
		eventAssignments: 0,
		taskAssignments: 0,
		taskCompletions: 0,
		crewMemberships: 0,
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
