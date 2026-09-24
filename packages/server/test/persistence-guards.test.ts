import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Refusal and validation branches on the persistence layer that nothing else
 * pins: the organizer-only edits to a trip and its roster, the member-only
 * writes to costs and places, the last-city guard, and the check-in / check-out
 * range that (today) is not validated at all.
 *
 * These live one layer below the routes, where the decision is actually made,
 * so they are tested here directly rather than through the browser. A small
 * number of the organizer guards are additionally exercised through the API in
 * tests-e2e, purely to prove the route reaches this layer at all.
 */

const tempRoot = join(tmpdir(), `trippy-persistence-guards-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'persistence-guards.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let auth: typeof import('../src/infra/auth.ts');
let trips: typeof import('../src/persistence/trips.ts');
let members: typeof import('../src/persistence/members.ts');
let costs: typeof import('../src/persistence/costs.ts');
let pois: typeof import('../src/persistence/pois.ts');
let lodging: typeof import('../src/persistence/lodging.ts');
let events: typeof import('../src/events.ts');

beforeAll(async () => {
	[{ db }, auth, trips, members, costs, pois, lodging, events] = await Promise.all([
		import('../src/db.ts'),
		import('../src/infra/auth.ts'),
		import('../src/persistence/trips.ts'),
		import('../src/persistence/members.ts'),
		import('../src/persistence/costs.ts'),
		import('../src/persistence/pois.ts'),
		import('../src/persistence/lodging.ts'),
		import('../src/events.ts')
	]);
});

beforeEach(() => {
	events.closeAll();
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
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

interface Fixture {
	organizer: string;
	member: string;
	outsider: string;
	tripId: string;
	cityId: string;
}

let seq = 0;
function makeUser(label: string): string {
	seq += 1;
	return auth.createUser(`${label}-${seq}@example.test`, label, 'hunter2hunter2').id;
}

function makeTrip(label = 'trip'): Fixture {
	const organizer = makeUser(`${label}-org`);
	const member = makeUser(`${label}-member`);
	const outsider = makeUser(`${label}-outsider`);
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

describe('trip edits are organizer-only', () => {
	const edit = { name: 'Renamed', startDate: '2026-10-02', endDate: '2026-10-05', currency: 'EUR' };

	it('lets the organizer edit, refuses a member and an outsider by message', () => {
		const f = makeTrip('edit');
		expect(trips.updateTrip(f.tripId, f.organizer, edit)).toBeNull();
		// A plain member is on the trip but is not the organizer, so the guard is
		// the only gate: without it, any member could re-date the trip.
		expect(trips.updateTrip(f.tripId, f.member, edit)).toBe('Only the organizer can edit this trip.');
		expect(trips.updateTrip(f.tripId, f.outsider, edit)).toBe(
			'Only the organizer can edit this trip.'
		);
	});

	it('lets only the organizer delete', () => {
		const f = makeTrip('delete');
		expect(trips.deleteTrip(f.tripId, f.member)).toBe(false);
		expect(trips.deleteTrip(f.tripId, f.outsider)).toBe(false);
		expect(trips.deleteTrip(f.tripId, f.organizer)).toBe(true);
	});

	it('lets only the organizer add, edit and remove a city', () => {
		const f = makeTrip('cities');
		const kyoto = { name: 'Kyoto', country: 'Japan', tz: 'Asia/Tokyo', lat: 35.01, lng: 135.77 };
		expect(trips.addCity(f.tripId, f.member, kyoto)).toBeNull();
		expect(trips.addCity(f.tripId, f.outsider, kyoto)).toBeNull();
		const kyotoId = trips.addCity(f.tripId, f.organizer, kyoto);
		expect(kyotoId).toBeTruthy();

		const rename = { name: 'Nara', country: 'Japan', tz: 'Asia/Tokyo', lat: 34.68, lng: 135.8 };
		expect(trips.updateCity(f.tripId, f.member, kyotoId!, rename)).toBe(false);
		expect(trips.updateCity(f.tripId, f.organizer, kyotoId!, rename)).toBe(true);
	});
});

describe('removeCity keeps at least one city and is organizer-only', () => {
	it('refuses a member even when more than one city exists', () => {
		const f = makeTrip('remove-city-member');
		const second = trips.addCity(f.tripId, f.organizer, {
			name: 'Kyoto',
			country: 'Japan',
			tz: 'Asia/Tokyo',
			lat: 35.01,
			lng: 135.77
		})!;
		expect(trips.removeCity(f.tripId, f.member, second)).toBe(false);
	});

	it('refuses the organizer when it would empty the itinerary', () => {
		const f = makeTrip('remove-last-city');
		// One city on the trip: removing it would leave an itinerary with no spine.
		expect(trips.removeCity(f.tripId, f.organizer, f.cityId)).toBe(false);
	});

	it('lets the organizer remove a city when another remains', () => {
		const f = makeTrip('remove-city-ok');
		const second = trips.addCity(f.tripId, f.organizer, {
			name: 'Kyoto',
			country: 'Japan',
			tz: 'Asia/Tokyo',
			lat: 35.01,
			lng: 135.77
		})!;
		expect(trips.removeCity(f.tripId, f.organizer, second)).toBe(true);
	});
});

describe('removeMember is organizer-only and never removes the organizer', () => {
	it('refuses a member acting as remover', () => {
		const f = makeTrip('remove-member-actor');
		expect(members.removeMember(f.tripId, f.member, f.organizer)).toBe(false);
		expect(members.removeMember(f.tripId, f.outsider, f.member)).toBe(false);
	});

	it('refuses the organizer removing the organizer, who cannot be removed', () => {
		const f = makeTrip('remove-organizer');
		// Only the .toBe(true) success was pinned before; this pins the refusal
		// that stops the trip being left with no organizer.
		expect(members.removeMember(f.tripId, f.organizer, f.organizer)).toBe(false);
	});

	it('lets the organizer remove a regular member', () => {
		const f = makeTrip('remove-member-ok');
		expect(members.removeMember(f.tripId, f.organizer, f.member)).toBe(true);
	});
});

describe('cost items are member-only and validated', () => {
	const base = { category: 'lodging', label: 'Deposit', cents: 5000, assignees: [] as string[] };

	it('refuses a non-member', () => {
		const f = makeTrip('cost-outsider');
		expect(costs.addCostItem(f.tripId, f.outsider, base)).toBe(false);
	});

	it('rejects a blank or over-long label, a bad category and a negative amount', () => {
		const f = makeTrip('cost-validation');
		expect(costs.addCostItem(f.tripId, f.member, { ...base, label: '   ' })).toBe(false);
		// The shared name ceiling, which the route also checks with its message.
		expect(costs.addCostItem(f.tripId, f.member, { ...base, label: 'x'.repeat(201) })).toBe(false);
		expect(costs.addCostItem(f.tripId, f.member, { ...base, label: 'x'.repeat(200) })).toBe(true);
		expect(costs.addCostItem(f.tripId, f.member, { ...base, category: 'not-a-category' })).toBe(
			false
		);
		expect(costs.addCostItem(f.tripId, f.member, { ...base, cents: -1 })).toBe(false);
	});

	it('accepts a zero amount and trims the label', () => {
		const f = makeTrip('cost-zero');
		expect(costs.addCostItem(f.tripId, f.member, { ...base, label: '  Free walking tour  ', cents: 0 })).toBe(
			true
		);
		expect(costs.listCostItems(f.tripId)[0].label).toBe('Free walking tour');
		expect(costs.listCostItems(f.tripId)[0].amountCents).toBe(0);
	});

	it('refuses an update from a non-member, to a missing item, or across trips', () => {
		const f = makeTrip('cost-update');
		const other = makeTrip('cost-update-other');
		expect(costs.addCostItem(f.tripId, f.organizer, base)).toBe(true);
		const itemId = costs.listCostItems(f.tripId)[0].id;

		expect(costs.updateCostItem(f.tripId, f.outsider, itemId, base)).toBe(false);
		expect(costs.updateCostItem(f.tripId, f.member, 'no-such-item', base)).toBe(false);
		// A member of another trip cannot reach this item through that trip's id.
		expect(costs.updateCostItem(other.tripId, other.organizer, itemId, base)).toBe(false);
	});

	it('refuses removal from a non-member and a no-op for a missing item', () => {
		const f = makeTrip('cost-remove');
		expect(costs.addCostItem(f.tripId, f.organizer, base)).toBe(true);
		const itemId = costs.listCostItems(f.tripId)[0].id;
		expect(costs.removeCostItem(f.tripId, f.outsider, itemId)).toBe(false);
		expect(costs.removeCostItem(f.tripId, f.organizer, 'no-such-item')).toBe(false);
	});
});

describe('places are member-only and scoped to a city on the trip', () => {
	function addAthensPoi(f: Fixture, actor: string) {
		return pois.addPoi(f.tripId, actor, f.cityId, 'Acropolis', 'Sights', null, null, null, null);
	}

	it('refuses a non-member', () => {
		const f = makeTrip('poi-outsider');
		expect(addAthensPoi(f, f.outsider)).toBeNull();
	});

	it('refuses a city that belongs to another trip', () => {
		const f = makeTrip('poi-city');
		const other = makeTrip('poi-city-other');
		// The actor is the organizer here, so only the city check can refuse it.
		expect(
			pois.addPoi(f.tripId, f.organizer, other.cityId, 'Wrong', 'Sights', null, null, null, null)
		).toBeNull();
	});

	it('refuses editing and removing from a non-member and across trips', () => {
		const f = makeTrip('poi-edit');
		const other = makeTrip('poi-edit-other');
		const poiId = addAthensPoi(f, f.organizer)!;

		expect(pois.updatePoi(f.tripId, f.outsider, poiId, { name: 'x', notes: null, url: null })).toBe(
			false
		);
		expect(pois.removePoi(f.tripId, f.outsider, poiId)).toBe(false);
		// Reachable only through its own trip: the other trip's organizer misses.
		expect(
			pois.updatePoi(other.tripId, other.organizer, poiId, { name: 'x', notes: null, url: null })
		).toBe(false);
		expect(pois.removePoi(other.tripId, other.organizer, poiId)).toBe(false);
	});
});

describe('setDates requires a positive night count', () => {
	/**
	 * A stay covers at least one night. `setDates` now refuses a checkout on or
	 * before the check-in day, matching the schedule stay path, so the same trip
	 * cannot hold a zero-night or negative stay through one path that the other
	 * would have rejected.
	 */
	it('refuses a checkout on the check-in day (zero nights)', () => {
		const f = makeTrip('set-dates-zero');
		const optionId = lodging.addOption(f.tripId, f.organizer, f.cityId, 'Ryokan')!;
		expect(lodging.setDates(f.tripId, f.member, optionId, '2026-10-01', '2026-10-01')).toBe(false);
		const row = db
			.prepare(`SELECT check_in, check_out FROM lodging_options WHERE id = ?`)
			.get(optionId) as { check_in: string | null; check_out: string | null };
		// The refusal is total: nothing was written.
		expect(row.check_in).toBeNull();
		expect(row.check_out).toBeNull();
	});

	it('refuses a checkout before the check-in day (negative nights)', () => {
		const f = makeTrip('set-dates-negative');
		const optionId = lodging.addOption(f.tripId, f.organizer, f.cityId, 'Ryokan')!;
		expect(lodging.setDates(f.tripId, f.member, optionId, '2026-10-02', '2026-10-01')).toBe(false);
	});

	it('accepts a valid range of one night or more', () => {
		const f = makeTrip('set-dates-ok');
		const optionId = lodging.addOption(f.tripId, f.organizer, f.cityId, 'Ryokan')!;
		expect(lodging.setDates(f.tripId, f.member, optionId, '2026-10-01', '2026-10-02')).toBe(true);
		const row = db
			.prepare(`SELECT check_in, check_out FROM lodging_options WHERE id = ?`)
			.get(optionId) as { check_in: string; check_out: string };
		expect(row.check_in).toBe('2026-10-01');
		expect(row.check_out).toBe('2026-10-02');
	});

	it('accepts a half-filled range, which is undated rather than invalid', () => {
		const f = makeTrip('set-dates-partial');
		const optionId = lodging.addOption(f.tripId, f.organizer, f.cityId, 'Ryokan')!;
		expect(lodging.setDates(f.tripId, f.member, optionId, '2026-10-01', null)).toBe(true);
		expect(lodging.setDates(f.tripId, f.member, optionId, null, null)).toBe(true);
	});

	it('refuses a non-member', () => {
		const f = makeTrip('set-dates-outsider');
		const optionId = lodging.addOption(f.tripId, f.organizer, f.cityId, 'Ryokan')!;
		expect(lodging.setDates(f.tripId, f.outsider, optionId, '2026-10-01', '2026-10-02')).toBe(false);
	});
});
