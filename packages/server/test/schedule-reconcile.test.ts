import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { routeKey } from '@trippy/core/travel';
import { tmpdir } from 'node:os';

/**
 * Travel that has to survive writes which are not event writes.
 *
 * The stored legs used to be reconciled only by `touched()`, which only event
 * writes call, while `legsForDay` dropped any planned journey without a row.
 * So anything that changed the plan from elsewhere (a roster change, a place or
 * stay deleted from Discover, a city removed, a stay learning where it is)
 * made travel vanish from the board, and because the leg key carried the
 * expanded roster, every roster change also orphaned every pinned mode on the
 * trip. These cases pin both halves of the fix: reads and those writes
 * reconcile, and the key is the pair of events, so a pin outlives a roster
 * change.
 *
 * They also pin the event writes that now bump `version` without checking it
 * (a drag, a resize, a people save, and a reflow), which is what stops a
 * dialog opened earlier from silently writing the old values back.
 */

const tempRoot = join(tmpdir(), `trippy-schedule-reconcile-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'schedule-reconcile.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let auth: typeof import('../src/infra/auth.ts');
let trips: typeof import('../src/persistence/trips.ts');
let members: typeof import('../src/persistence/members.ts');
let schedule: typeof import('../src/persistence/schedule.ts');
let pois: typeof import('../src/persistence/pois.ts');
let lodging: typeof import('../src/persistence/lodging.ts');
let expenses: typeof import('../src/persistence/expenses.ts');
let bus: typeof import('../src/events.ts');

beforeAll(async () => {
	[{ db }, auth, trips, members, schedule, pois, lodging, expenses, bus] = await Promise.all([
		import('../src/db.ts'),
		import('../src/infra/auth.ts'),
		import('../src/persistence/trips.ts'),
		import('../src/persistence/members.ts'),
		import('../src/persistence/schedule.ts'),
		import('../src/persistence/pois.ts'),
		import('../src/persistence/lodging.ts'),
		import('../src/persistence/expenses.ts'),
		import('../src/events.ts')
	]);
});

afterAll(() => {
	bus.closeAll();
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const path = `${dbPath}${suffix}`;
		if (existsSync(path)) rmSync(path, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

const DAY = '2026-10-01';
const NEXT = '2026-10-02';
const HOTEL = { lat: 37.975, lng: 23.734 };
const MUSEUM = { lat: 37.968, lng: 23.729 };
const PARK = { lat: 37.99, lng: 23.742 };

let alice: string;
let bob: string;
let tripId: string;
let athens: string;
let seq = 0;

beforeEach(() => {
	bus.closeAll();
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
	seq += 1;
	alice = auth.createUser(`alice-${seq}@example.test`, 'Alice', 'hunter2hunter2').id;
	bob = auth.createUser(`bob-${seq}@example.test`, 'Bob', 'hunter2hunter2').id;
	tripId = trips.createTrip(alice, {
		name: 'ZZ Athens',
		startDate: DAY,
		endDate: '2026-10-05',
		homeCurrency: 'EUR'
	})!.id!;
	db.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'member')`).run(
		tripId,
		bob
	);
	athens = trips.addCity(tripId, alice, {
		name: 'Athens',
		country: 'Greece',
		tz: 'Europe/Athens',
		lat: 37.98,
		lng: 23.73
	})!;
});

function add(
	over: {
		day?: string;
		endDay?: string;
		type?: 'activity' | 'food' | 'stay' | 'travel' | 'freetime';
		startMin: number;
		endMin: number;
		people?: string[];
		poiId?: string;
		lodgingId?: string;
		timeAuto?: boolean;
	} & Partial<{ lat: number; lng: number }>
): string {
	return schedule.createEvent(tripId, alice, {
		day: over.day ?? DAY,
		endDay: over.endDay ?? null,
		title: 'ZZ Stop',
		type: over.type ?? 'activity',
		startMin: over.startMin,
		endMin: over.endMin,
		poiId: over.poiId ?? null,
		lodgingId: over.lodgingId ?? null,
		lat: over.lat ?? null,
		lng: over.lng ?? null,
		people: over.people ?? [],
		timeAuto: over.timeAuto
	})!;
}

function version(eventId: string): number {
	return (db.prepare(`SELECT version FROM events WHERE id = ?`).get(eventId) as { version: number })
		.version;
}

function startOf(eventId: string): number {
	return (
		db.prepare(`SELECT start_min FROM events WHERE id = ?`).get(eventId) as { start_min: number }
	).start_min;
}

/** Two Everyone blocks with a ferry pinned on the journey between them. */
function pinnedDay(): { from: string; to: string; legId: string } {
	const from = add({ startMin: 540, endMin: 600, ...HOTEL });
	const to = add({ startMin: 660, endMin: 720, ...MUSEUM });
	const leg = schedule.legsForDay(tripId, DAY)[0];
	expect(schedule.editLeg(leg.id, tripId, alice, 'ferry', 45, 'The 10:15')).toBe(true);
	return { from, to, legId: leg.id };
}

function expectPinned(legId: string, people: string[]) {
	const legs = schedule.legsForDay(tripId, DAY);
	expect(legs).toHaveLength(1);
	expect(legs[0]).toMatchObject({
		id: legId,
		resolvedMode: 'ferry',
		resolvedMins: 45,
		title: 'The 10:15',
		manual: true
	});
	expect(legs[0].people).toEqual([...people].sort());
}

describe('a roster change keeps travel, and keeps the pin', () => {
	it('when somebody new is added', () => {
		const { legId } = pinnedDay();
		expect(members.addPerson(tripId, alice, 'ZZ Carol', '')).toBe('created');
		const carol = (
			db.prepare(`SELECT id FROM users WHERE name = 'ZZ Carol'`).get() as { id: string }
		).id;
		expectPinned(legId, [alice, bob, carol]);
	});

	it('when a member is removed', () => {
		const { legId } = pinnedDay();
		expect(members.removeMember(tripId, alice, bob)).toBe(true);
		expectPinned(legId, [alice]);
	});

	it('when a member leaves', () => {
		const { legId } = pinnedDay();
		expect(trips.leaveTrip(tripId, bob)).toBe(true);
		expectPinned(legId, [alice]);
	});

	it('when a placeholder is merged into the account it turned out to be', () => {
		expect(members.addPerson(tripId, alice, 'ZZ Dana', 'dana@example.test')).toBe('invited');
		const placeholder = (
			db.prepare(`SELECT id FROM users WHERE name = 'ZZ Dana'`).get() as { id: string }
		).id;
		const from = add({ startMin: 540, endMin: 600, people: [alice, placeholder], ...HOTEL });
		add({ startMin: 660, endMin: 720, people: [alice, placeholder], ...MUSEUM });
		const leg = schedule.legsForDay(tripId, DAY)[0];
		expect(schedule.editLeg(leg.id, tripId, alice, 'ferry', 45, 'The 10:15')).toBe(true);

		const dana = auth.createUser('dana@example.test', 'Dana', 'hunter2hunter2').id;
		members.consumeInvites(dana, 'dana@example.test');

		expect(db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(placeholder)).toBeUndefined();
		expectPinned(leg.id, [alice, dana]);
		expect(from).toBeTruthy();
	});
});

describe('a delete from outside the schedule settles the days it touched', () => {
	it('re-plans across a place deleted from Discover', () => {
		const poi = pois.addPoi(
			tripId,
			alice,
			athens,
			'ZZ Museum',
			'Sights',
			null,
			null,
			MUSEUM.lat,
			MUSEUM.lng
		)!;
		const first = add({ startMin: 540, endMin: 600, ...HOTEL });
		add({ startMin: 660, endMin: 720, poiId: poi, ...MUSEUM });
		const last = add({ startMin: 780, endMin: 840, ...PARK });
		expect(schedule.legsForDay(tripId, DAY).map((l) => l.toEventId)).toHaveLength(2);

		expect(pois.removePoi(tripId, alice, poi)).toBe(true);

		// The row for the journey that now runs straight past exists without any
		// read having asked for it.
		expect(
			db
				.prepare(`SELECT 1 FROM travel_legs WHERE from_event_id = ? AND to_event_id = ?`)
				.get(first, last)
		).toBeTruthy();
		const legs = schedule.legsForDay(tripId, DAY);
		expect(legs).toHaveLength(1);
		expect(legs[0]).toMatchObject({ fromEventId: first, toEventId: last });
	});

	it('takes the morning journey out of a stay option that is deleted', () => {
		const option = lodging.addOption(tripId, alice, athens, 'ZZ Hotel', HOTEL)!;
		const band = add({
			type: 'stay',
			day: DAY,
			endDay: NEXT,
			startMin: 1260,
			endMin: 1440,
			lodgingId: option,
			...HOTEL
		});
		const museum = add({ day: NEXT, startMin: 600, endMin: 660, ...MUSEUM });
		const legs = schedule.legsForDay(tripId, NEXT);
		expect(legs).toHaveLength(1);
		expect(legs[0]).toMatchObject({ fromEventId: band, toEventId: museum });

		expect(lodging.removeOption(tripId, alice, option)).toBe(true);
		expect(
			db.prepare(`SELECT COUNT(*) AS n FROM events WHERE lodging_id = ?`).get(option)
		).toMatchObject({ n: 0 });
		expect(schedule.legsForDay(tripId, NEXT)).toEqual([]);
	});

	it('deletes what was scheduled at a removed city, and nothing that merely defaulted to it', () => {
		const rome = trips.addCity(tripId, alice, {
			name: 'Rome',
			country: 'Italy',
			tz: 'Europe/Rome',
			lat: 41.9,
			lng: 12.5
		})!;
		const poi = pois.addPoi(
			tripId,
			alice,
			rome,
			'ZZ Forum',
			'Sights',
			null,
			null,
			MUSEUM.lat,
			MUSEUM.lng
		)!;
		const option = lodging.addOption(tripId, alice, rome, 'ZZ Roma Hotel', HOTEL)!;
		const first = add({ startMin: 540, endMin: 600, ...HOTEL });
		const atPoi = add({ startMin: 660, endMin: 720, poiId: poi, ...MUSEUM });
		const last = add({ startMin: 780, endMin: 840, ...PARK });
		const band = add({
			type: 'stay',
			day: DAY,
			endDay: NEXT,
			startMin: 1260,
			endMin: 1440,
			lodgingId: option,
			...HOTEL
		});
		// Nothing links this one to Rome except the default city id.
		db.prepare(`UPDATE events SET city_id = ? WHERE id = ?`).run(rome, last);

		expect(trips.removeCity(tripId, alice, rome)).toBe(true);

		const left = (
			db.prepare(`SELECT id FROM events WHERE trip_id = ?`).all(tripId) as { id: string }[]
		).map((r) => r.id);
		expect(left).toContain(first);
		expect(left).toContain(last);
		expect(left).not.toContain(atPoi);
		expect(left).not.toContain(band);
		const legs = schedule.legsForDay(tripId, DAY);
		expect(legs).toHaveLength(1);
		expect(legs[0]).toMatchObject({ fromEventId: first, toEventId: last });
	});
});

describe('a stay that learns where it is', () => {
	it('hands its coordinates to the bands already booked into it, and plans the morning', () => {
		const option = lodging.addOption(tripId, alice, athens, 'ZZ Typed Hotel')!;
		const band = add({
			type: 'stay',
			day: DAY,
			endDay: NEXT,
			startMin: 1260,
			endMin: 1440,
			lodgingId: option
		});
		add({ day: NEXT, startMin: 600, endMin: 660, ...MUSEUM });
		// No position on the band, so the morning has nowhere to leave from.
		expect(schedule.legsForDay(tripId, NEXT)).toEqual([]);

		lodging.fillLodgingPlace(tripId, option, HOTEL.lat, HOTEL.lng);

		expect(db.prepare(`SELECT lat, lng FROM events WHERE id = ?`).get(band)).toMatchObject(HOTEL);
		const legs = schedule.legsForDay(tripId, NEXT);
		expect(legs).toHaveLength(1);
		expect(legs[0].fromEventId).toBe(band);
	});

	it('does not move a band somebody already placed', () => {
		const option = lodging.addOption(tripId, alice, athens, 'ZZ Typed Hotel')!;
		const band = add({
			type: 'stay',
			day: DAY,
			endDay: NEXT,
			startMin: 1260,
			endMin: 1440,
			lodgingId: option,
			...PARK
		});
		lodging.fillLodgingPlace(tripId, option, HOTEL.lat, HOTEL.lng);
		expect(db.prepare(`SELECT lat, lng FROM events WHERE id = ?`).get(band)).toMatchObject(PARK);
	});

	it('repairs, on the next boot, a band whose stay was found before the bands were filled', async () => {
		// What production holds: the lookup ran under the old code, so the stay
		// has coordinates and is marked checked, and its band still has none.
		// `fillLodgingPlace` never fires again for it, so only the boot repair
		// can reach it.
		const option = lodging.addOption(tripId, alice, athens, 'ZZ Old Hotel')!;
		const band = add({
			type: 'stay',
			day: DAY,
			endDay: NEXT,
			startMin: 1260,
			endMin: 1440,
			lodgingId: option
		});
		// Another night in the same stay that somebody placed by hand.
		const placed = add({
			type: 'stay',
			day: NEXT,
			endDay: '2026-10-03',
			startMin: 1260,
			endMin: 1440,
			lodgingId: option,
			...PARK
		});
		add({ day: NEXT, startMin: 600, endMin: 660, ...MUSEUM });
		db.prepare(`UPDATE lodging_options SET lat = ?, lng = ?, place_checked = 1 WHERE id = ?`).run(
			HOTEL.lat,
			HOTEL.lng,
			option
		);

		// A second import runs db.ts again against the same file, as a restart does.
		(await import('../src/db.ts?reboot')).db.close();

		expect(db.prepare(`SELECT lat, lng FROM events WHERE id = ?`).get(band)).toMatchObject(HOTEL);
		// Only a hole is filled: the band somebody placed keeps its own position.
		expect(db.prepare(`SELECT lat, lng FROM events WHERE id = ?`).get(placed)).toMatchObject(PARK);
		expect(schedule.legsForDay(tripId, NEXT).map((l) => l.fromEventId)).toContain(band);
	});
});

describe('leaving the trip and being removed from it do the same thing to the money', () => {
	it('re-divides an even split across whoever is left when a member leaves', () => {
		const carol = auth.createUser(`carol-${seq}@example.test`, 'Carol', 'hunter2hunter2').id;
		db.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'member')`).run(
			tripId,
			carol
		);
		const id = expenses.addExpense(tripId, alice, alice, 'ZZ Dinner', 9000, 'EUR', [
			{ userId: alice, weight: 1 },
			{ userId: bob, weight: 1 },
			{ userId: carol, weight: 1 }
		])!;
		expect(trips.leaveTrip(tripId, carol)).toBe(true);
		const left = (
			db
				.prepare(`SELECT user_id FROM expense_participants WHERE expense_id = ? ORDER BY user_id`)
				.all(id) as { user_id: string }[]
		).map((r) => r.user_id);
		expect(left).toEqual([alice, bob].sort());
	});
});

describe('writes that bump the version without checking it', () => {
	it('bumps on a drag, a resize and a people save', () => {
		const id = add({ startMin: 540, endMin: 600, ...HOTEL });
		const v0 = version(id);
		expect(schedule.moveEvent(id, alice, 560, tripId)).toBe(true);
		expect(version(id)).toBe(v0 + 1);
		expect(schedule.resizeEvent(id, alice, 700, tripId)).toBe(true);
		expect(version(id)).toBe(v0 + 2);
		expect(schedule.setEventPeople(id, tripId, alice, [alice])).toBe(true);
		expect(version(id)).toBe(v0 + 3);
		expect(schedule.eventVersion(id)).toBe(v0 + 3);
		// And none of them is refused for a stale number, because none sends one.
		expect(schedule.editEvent(id, alice, { title: 'Stale' }, tripId, v0).ok).toBe(false);
	});

	it('bumps a block the reflow moved, so a dialog open on it is refused', () => {
		const museum = add({ startMin: 540, endMin: 600, ...MUSEUM });
		const lunch = add({ startMin: 600, endMin: 660, timeAuto: true, ...MUSEUM });
		const opened = version(lunch);

		// Stretching the museum pushes the suggested lunch along behind it.
		expect(schedule.resizeEvent(museum, alice, 720, tripId)).toBe(true);
		expect(startOf(lunch)).toBe(720);
		expect(version(lunch)).toBe(opened + 1);

		const stale = schedule.editEvent(lunch, alice, { startMin: 600, endMin: 660 }, tripId, opened);
		expect(stale).toEqual({ ok: false, reason: 'conflict' });
		expect(startOf(lunch)).toBe(720);
	});

	it('hands back the version an edit left, even when settling the day reflowed the block', () => {
		const museum = add({ startMin: 540, endMin: 720, ...MUSEUM });
		const lunch = add({ startMin: 720, endMin: 780, timeAuto: true, ...MUSEUM });
		// Shrink the museum behind the reflow's back, so the next settle moves lunch.
		db.prepare(`UPDATE events SET end_min = 600 WHERE id = ?`).run(museum);

		const res = schedule.editEvent(lunch, alice, { title: 'ZZ Lunch' }, tripId, version(lunch));
		expect(res.ok).toBe(true);
		expect(startOf(lunch)).toBe(600);
		// The dialog can save again with what it was handed.
		expect(res.ok && res.version).toBe(version(lunch));
		expect(
			schedule.editEvent(
				lunch,
				alice,
				{ title: 'ZZ Lunch again' },
				tripId,
				res.ok ? res.version : 0
			).ok
		).toBe(true);
	});
});

describe('the leg key moved from from>to>people to from>to', () => {
	it('re-keys the pinned row of each pair and leaves the rest untouched', () => {
		const from = add({ startMin: 540, endMin: 600, ...HOTEL });
		const to = add({ startMin: 660, endMin: 720, ...MUSEUM });
		const current = schedule.legsForDay(tripId, DAY)[0];
		// What a database written before the change holds: the live row under the
		// old key, and a pinned twin left behind by an earlier roster change.
		db.prepare(`UPDATE travel_legs SET leg_key = ? WHERE id = ?`).run(
			`${from}>${to}>${[alice, bob].sort().join(',')}`,
			current.id
		);
		db.prepare(
			`INSERT INTO travel_legs (id, trip_id, day, leg_key, from_event_id, to_event_id, people, mode, mins)
			 VALUES ('zz-pinned', ?, ?, ?, ?, ?, ?, 'ferry', 45)`
		).run(tripId, DAY, `${from}>${to}>${alice}`, from, to, alice);

		expect(schedule.rekeyLegacyLegs()).toBe(1);

		const legs = schedule.legsForDay(tripId, DAY);
		expect(legs).toHaveLength(1);
		expect(legs[0]).toMatchObject({ id: 'zz-pinned', key: `${from}>${to}`, resolvedMode: 'ferry' });
		// The unpicked row is left as it was, not deleted.
		expect(
			db.prepare(`SELECT leg_key FROM travel_legs WHERE id = ?`).get(current.id)
		).toMatchObject({
			leg_key: `${from}>${to}>${[alice, bob].sort().join(',')}`
		});
	});

	it('merges a pinned legacy row into a new-format row a reconciliation wrote first', () => {
		const from = add({ startMin: 540, endMin: 600, ...HOTEL });
		const to = add({ startMin: 660, endMin: 720, ...MUSEUM });
		// The order the migrations used to run in: the reconciliation inserted an
		// unpinned `from>to` row, and the reader's pin is still on a legacy row.
		const fresh = schedule.legsForDay(tripId, DAY)[0];
		expect(fresh.manual).toBe(false);
		db.prepare(
			`INSERT INTO travel_legs (id, trip_id, day, leg_key, from_event_id, to_event_id, people, title, mode, mins)
			 VALUES ('zz-legacy', ?, ?, ?, ?, ?, ?, 'The 10:15', 'ferry', 45)`
		).run(tripId, DAY, `${from}>${to}>${alice}`, from, to, alice);

		expect(schedule.rekeyLegacyLegs()).toBe(1);

		const legs = schedule.legsForDay(tripId, DAY);
		expect(legs).toHaveLength(1);
		expect(legs[0]).toMatchObject({
			id: fresh.id,
			title: 'The 10:15',
			resolvedMode: 'ferry',
			resolvedMins: 45,
			manual: true
		});
	});

	it('leaves a pin on the new-format row alone when merging', () => {
		const from = add({ startMin: 540, endMin: 600, ...HOTEL });
		const to = add({ startMin: 660, endMin: 720, ...MUSEUM });
		const fresh = schedule.legsForDay(tripId, DAY)[0];
		expect(schedule.editLeg(fresh.id, tripId, alice, 'walk', 30)).toBe(true);
		db.prepare(
			`INSERT INTO travel_legs (id, trip_id, day, leg_key, from_event_id, to_event_id, people, mode, mins)
			 VALUES ('zz-legacy', ?, ?, ?, ?, ?, ?, 'ferry', 45)`
		).run(tripId, DAY, `${from}>${to}>${alice}`, from, to, alice);
		schedule.rekeyLegacyLegs();
		expect(schedule.legsForDay(tripId, DAY)[0]).toMatchObject({
			resolvedMode: 'walk',
			resolvedMins: 30
		});
	});
});

describe('a routed answer belongs to the two points it was bought for', () => {
	it('stops being used once an end of the journey moves, until it is routed again', () => {
		add({ startMin: 540, endMin: 600, ...HOTEL });
		const to = add({ startMin: 660, endMin: 720, ...MUSEUM });
		const leg = schedule.legsForDay(tripId, DAY)[0];
		const planned = schedule.plannedLegsForDay(tripId, DAY)[0];
		schedule.saveAutoLeg(tripId, DAY, leg.key, 'drive', 77, true, routeKey(planned, 'drive'));
		expect(schedule.legsForDay(tripId, DAY)[0]).toMatchObject({ autoMins: 77, resolvedMins: 77 });

		expect(schedule.editEvent(to, alice, { place: PARK }, tripId).ok).toBe(true);
		const after = schedule.legsForDay(tripId, DAY)[0];
		expect(after.id).toBe(leg.id);
		// The straight-line guess stands in until the board routes the new points.
		expect(after.autoMins).toBeNull();
		expect(after.resolvedMins).not.toBe(77);
		expect(schedule.storedAutoLegs(tripId, DAY).get(leg.key)?.routeKey).toBe(
			routeKey(planned, 'drive')
		);
	});
});

describe('settling after a roster change', () => {
	it('never fails the roster change, and rolls its own work back when it breaks', () => {
		const { legId } = pinnedDay();
		// Any write to the legs now throws, which is what a settle failing partway
		// through looks like from the outside.
		db.exec(`
			CREATE TEMP TRIGGER zz_legs_ins BEFORE INSERT ON travel_legs BEGIN SELECT RAISE(ABORT, 'zz boom'); END;
			CREATE TEMP TRIGGER zz_legs_upd BEFORE UPDATE ON travel_legs BEGIN SELECT RAISE(ABORT, 'zz boom'); END;
		`);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		let logCalls = 0;
		try {
			expect(members.addPerson(tripId, alice, 'ZZ Erin', '')).toBe('created');
		} finally {
			logCalls = logged.mock.calls.length;
			db.exec(`DROP TRIGGER zz_legs_ins; DROP TRIGGER zz_legs_upd;`);
			logged.mockRestore();
		}
		expect(logCalls).toBe(1);
		// The membership committed; the settle's half-done work did not.
		expect(
			db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE trip_id = ?`).get(tripId)
		).toMatchObject({ n: 3 });
		expect(db.prepare(`SELECT people FROM travel_legs WHERE id = ?`).get(legId)).toMatchObject({
			people: [alice, bob].sort().join(',')
		});
		// No transaction is left open behind it, and the next read puts it right.
		expect(() => db.exec('BEGIN; COMMIT;')).not.toThrow();
		expect(schedule.legsForDay(tripId, DAY)[0].people).toHaveLength(3);
	});
});
