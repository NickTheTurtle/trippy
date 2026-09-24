import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Persistence-level halves of the pre-1.0 review fixes: the rules that must hold
 * even for a caller that never goes through a route.
 */

const tempRoot = join(tmpdir(), `trippy-server-review-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'server.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let auth: typeof import('../src/infra/auth.ts');
let trips: typeof import('../src/persistence/trips.ts');
let costs: typeof import('../src/persistence/costs.ts');
let fx: typeof import('../src/providers/fx.ts');
let mail: typeof import('../src/providers/mail.ts');
let CURRENCY_CODES: string[];

beforeAll(async () => {
	db = (await import('../src/db.ts')).db;
	auth = await import('../src/infra/auth.ts');
	trips = await import('../src/persistence/trips.ts');
	costs = await import('../src/persistence/costs.ts');
	fx = await import('../src/providers/fx.ts');
	mail = await import('../src/providers/mail.ts');
	({ CURRENCY_CODES } = await import('@trippy/core/currency'));
});

beforeEach(() => {
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
});

afterAll(() => {
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

function trip() {
	const organizer = auth.createUser(`o-${crypto.randomUUID()}@example.test`, 'ZZ O', 'password1').id;
	const tripId = trips.createTrip(organizer, {
		name: 'ZZ Trip',
		startDate: '2026-10-10',
		endDate: '2026-10-15',
		homeCurrency: 'USD'
	}).id!;
	const cityId = trips.addCity(tripId, organizer, {
		name: 'Athens',
		country: 'Greece',
		tz: 'Europe/Athens'
	})!;
	return { organizer, tripId, cityId };
}

describe('currencies', () => {
	it('offers exactly the codes that convert offline', () => {
		expect(fx.knownCurrencies()).toEqual(CURRENCY_CODES);
	});

	it('refuses an estimate in a currency nothing can convert', () => {
		const f = trip();
		const item = { category: 'food', label: 'ZZ Lunch', cents: 1000, assignees: [] };
		expect(costs.addCostItem(f.tripId, f.organizer, { ...item, currency: 'AFN' })).toBe(false);
		expect(costs.addCostItem(f.tripId, f.organizer, { ...item, currency: 'eur' })).toBe(true);
		expect(costs.addCostItem(f.tripId, f.organizer, { ...item, currency: '' })).toBe(true);
		// And the budget, which converts every row, still reads.
		expect(() => costs.getItemizedBudget(f.tripId)).not.toThrow();
	});
});

describe('trip edits', () => {
	const edit = { name: 'ZZ Trip', startDate: '2026-10-10', endDate: '2026-10-15', currency: 'USD' };
	const locked = (tripId: string) =>
		(db.prepare(`SELECT schedule_locked AS l FROM trips WHERE id = ?`).get(tripId) as { l: number }).l;

	it('keeps the stored lock when an edit leaves it out', () => {
		const f = trip();
		expect(trips.updateTrip(f.tripId, f.organizer, { ...edit, scheduleLocked: true })).toBeNull();
		expect(trips.updateTrip(f.tripId, f.organizer, edit)).toBeNull();
		expect(locked(f.tripId)).toBe(1);
	});

	it('lets a legacy home currency through unchanged, but not a new unknown one', () => {
		const f = trip();
		db.prepare(`UPDATE trips SET home_currency = 'AFN' WHERE id = ?`).run(f.tripId);
		expect(
			trips.updateTrip(f.tripId, f.organizer, { ...edit, name: 'ZZ Renamed', currency: 'AFN' })
		).toBeNull();
		expect(trips.updateTrip(f.tripId, f.organizer, { ...edit, currency: 'XYZ' })).not.toBeNull();
	});

	it('reports why a city write was refused', () => {
		const f = trip();
		const other = auth.createUser(`x-${crypto.randomUUID()}@example.test`, 'ZZ X', 'password1').id;
		const city = { name: 'Delphi', country: 'Greece', tz: 'Europe/Athens' };
		expect(trips.addCityResult(f.tripId, other, city)).toEqual({ ok: false, reason: 'forbidden' });
		expect(trips.addCityResult(f.tripId, f.organizer, { ...city, tz: 'Mars/Base' })).toEqual({
			ok: false,
			reason: 'invalid'
		});
		expect(trips.addCityResult(f.tripId, f.organizer, { ...city, name: 'x'.repeat(201) })).toEqual({
			ok: false,
			reason: 'invalid'
		});
		expect(
			trips.addCityResult(f.tripId, f.organizer, { name: 'Athens', country: 'Greece', tz: 'UTC' })
		).toEqual({ ok: false, reason: 'duplicate' });
		expect(trips.removeCityResult(f.tripId, f.organizer, 'nope')).toEqual({
			ok: false,
			reason: 'missing'
		});
		expect(trips.removeCityResult(f.tripId, f.organizer, f.cityId)).toEqual({
			ok: false,
			reason: 'last'
		});
	});
});

describe('email change', () => {
	it('only moves the address when the token is spent, and only once', () => {
		const me = auth.createUser(`me-${crypto.randomUUID()}@example.test`, 'ZZ Me', 'password1');
		const target = `new-${crypto.randomUUID()}@example.test`;
		const { token } = auth.startEmailChange(me.id, target);
		expect(auth.findUserById(me.id)!.email).toBe(me.email);
		expect(auth.pendingEmailChange(me.id)).toBe(target);

		expect(auth.completeEmailChange(token)).toEqual({ ok: true, userId: me.id, email: target });
		expect(auth.findUserById(me.id)!.email).toBe(target);
		expect(auth.pendingEmailChange(me.id)).toBeNull();
		expect(auth.completeEmailChange(token).ok).toBe(false);
	});

	it('mails the confirmation to the web route', () => {
		const m = mail.emailChangeMail({ to: 'a@example.test', name: 'A', token: 'tok/en' });
		expect(m.to).toBe('a@example.test');
		expect(m.text).toContain('/verify-email?token=tok%2Fen');
		expect(m.html).toContain('/verify-email?token=tok%2Fen');
	});

	it('burns a derivation for a missing account without throwing', () => {
		expect(() => auth.burnPasswordCheck('anything')).not.toThrow();
	});
});
