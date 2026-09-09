import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
	[
		{ db },
		auth,
		trips,
		schedule,
		members,
		expenses,
		events,
		pois,
		lodging,
		parties,
		tasks
	] = await Promise.all([
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
		arrive: '2026-10-01',
		depart: '2026-10-03',
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
	return db.prepare(`SELECT title, start_min, end_min, booking FROM schedule_items WHERE id = ?`).get(
		itemId
	) as { title: string; start_min: number; end_min: number; booking: string | null } | undefined;
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
			parties.setPartyDay(tripB.tripId, tripB.organizer, partyA, '2026-10-01', tripB.cityId, optionB)
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
		const poiId = pois.addPoi(f.tripId, f.organizer, f.cityId, 'Acropolis', 'Sights', null, null, null, null)!;
		expect(pois.toggleVote(f.tripId, placeholder.id, poiId)).toBe(true);
		const stayId = lodging.addOption(f.tripId, f.organizer, f.cityId, 'Guesthouse')!;
		expect(lodging.vote(f.tripId, placeholder.id, stayId)).toBe(true);
		const itemId = createScheduleItem(f);
		expect(schedule.setAssignees(itemId, f.tripId, f.organizer, [placeholder.id])).toBe(true);
		const taskId = tasks.addTask(f.tripId, f.organizer, 'prep', 'Pack', [placeholder.id], null)!;
		expect(tasks.toggleTask(f.tripId, placeholder.id, taskId)).toBe(true);
		const crew = parties.createParty(f.tripId, f.organizer, 'Crew')!;
		expect(parties.assignMembership(f.tripId, f.organizer, crew, placeholder.id, '2026-10-01', 60, 120)).toBe(true);
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
		expect(db.prepare(`SELECT 1 FROM expenses WHERE id = ?`).get(paidByPlaceholder)).toBeUndefined();
		expect(tableCount('expense_participants', 'expense_id = ?', paidByPlaceholder)).toBe(0);
	});

	it('matches removalImpact for a registered member and removes only the membership row', () => {
		const f = createTripFixture('registered');
		const expenseId = expenses.addExpense(f.tripId, f.organizer, f.member, 'Tickets', 1200, 'USD', [
			{ userId: f.organizer, weight: 1 },
			{ userId: f.member, weight: 1 }
		])!;
		const poiId = pois.addPoi(f.tripId, f.organizer, f.cityId, 'Agora', 'Sights', null, null, null, null)!;
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
		expect(tableCount('expense_participants', 'expense_id = ? AND user_id = ?', expenseId, f.member)).toBe(1);
		expect(tableCount('poi_votes', 'poi_id = ? AND user_id = ?', poiId, f.member)).toBe(1);
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
			tz: 'Europe/Paris',
			arrive: '2026-10-02',
			depart: '2026-10-03'
		});
		const track = schedule.createTrack(tripA.tripId, '2026-10-01', 'Live');
		const expense = expenses.addExpense(tripA.tripId, tripA.organizer, tripA.organizer, 'Snacks', 301, 'USD', [
			{ userId: tripA.organizer, weight: 1 },
			{ userId: tripA.member, weight: 1 }
		]);

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
			const sub = events.subscribe(c.tripId, c.tripId === aged.tripId ? aged.organizer : active.organizer, () => undefined, {
				lastEventId: c.id
			});
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
	it('can run migrations twice against the same database and keeps additive columns singular', async () => {
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
			['trips', 'start_date', 'TEXT'],
			['trips', 'end_date', 'TEXT'],
			['tracks', 'party_id', 'TEXT']
		] as const;

		for (const [table, column, type] of expectedColumns) {
			const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[];
			const matches = rows.filter((r) => r.name === column);
			expect(matches, `${table}.${column}`).toHaveLength(1);
			expect(matches[0].type.toUpperCase()).toBe(type);
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
		const poiId = pois.addPoi(f.tripId, f.organizer, f.cityId, 'Temple', 'Sights', null, null, null, null)!;
		expect(pois.toggleVote(f.tripId, placeholder, poiId)).toBe(true);
		const optionId = lodging.addOption(f.tripId, f.organizer, f.cityId, 'Hotel')!;
		const partyId = parties.createParty(f.tripId, f.organizer, 'FK crew')!;
		expect(parties.setPartyDay(f.tripId, f.organizer, partyId, '2026-10-01', f.cityId, optionId)).toBe(true);

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

describe('money paths', () => {
	it('keeps uneven integer-cent splits zero-sum and settles exactly', () => {
		const f = createTripFixture('money');
		const third = createUser('third');
		expect(members.inviteToTrip(f.tripId, f.organizer, auth.findUserById(third)!.email)).toBe('added');
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
			expect(expenses.recordSettlement(f.tripId, f.organizer, s.fromId, s.toId, s.amountCents)).toBeTruthy();
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

function snapshotRemovalCounts(tripId: string, userId: string) {
	const paid = db
		.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM expenses WHERE payer_id = ? AND trip_id = ?`)
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
		invitesSent: scalar(`SELECT COUNT(*) FROM trip_invites WHERE invited_by = ? AND trip_id = ?`, userId, tripId),
		memberships: scalar(`SELECT COUNT(*) FROM memberships WHERE user_id = ? AND trip_id = ?`, userId, tripId),
		tripsOrganized: scalar(`SELECT COUNT(*) FROM trips WHERE organizer_id = ? AND id = ?`, userId, tripId)
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
