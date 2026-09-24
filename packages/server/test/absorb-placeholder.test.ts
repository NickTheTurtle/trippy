import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Merging a placeholder into a real account, held against the schema itself.
 *
 * `absorbPlaceholder` re-points everything the stand-in held and then deletes
 * it, and every foreign key to `users(id)` cascades. Anything the list forgot
 * is destroyed by that cascade with no undo, which is what happened to
 * `cost_item_people` (a one-person estimate silently widened to the whole trip)
 * and `trip_tasks.owner_id` (the stand-in's packing list deleted). The first
 * case here reads every foreign key in the live schema and fails for any that
 * the merge neither hands over nor names as deliberately left behind, so the
 * next table to reference a user cannot be forgotten the same way.
 */

const tempRoot = join(tmpdir(), `trippy-absorb-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'absorb.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

let db: Awaited<typeof import('../src/db.ts')>['db'];
let auth: typeof import('../src/infra/auth.ts');
let trips: typeof import('../src/persistence/trips.ts');
let members: typeof import('../src/persistence/members.ts');
let bus: typeof import('../src/events.ts');

beforeAll(async () => {
	[{ db }, auth, trips, members, bus] = await Promise.all([
		import('../src/db.ts'),
		import('../src/infra/auth.ts'),
		import('../src/persistence/trips.ts'),
		import('../src/persistence/members.ts'),
		import('../src/events.ts')
	]);
});

beforeEach(() => {
	bus.closeAll();
	db.exec('PRAGMA foreign_keys = ON');
	db.prepare(`DELETE FROM users`).run();
});

afterAll(() => {
	bus.closeAll();
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

/** Every `table.column` in the schema that references `users(id)`. */
function userReferences(): string[] {
	const tables = db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
		.all() as { name: string }[];
	const out: string[] = [];
	for (const t of tables) {
		const fks = db.prepare(`PRAGMA foreign_key_list(${t.name})`).all() as {
			table: string;
			from: string;
		}[];
		for (const fk of fks) if (fk.table === 'users') out.push(`${t.name}.${fk.from}`);
	}
	return out.sort();
}

describe('absorbPlaceholder', () => {
	it('accounts for every foreign key to users, one way or the other', () => {
		const handled = members.ABSORBED_USER_REFERENCES.map((r) => `${r.table}.${r.column}`);
		const left = members.UNABSORBED_USER_REFERENCES.map((r) => `${r.table}.${r.column}`);
		// Nothing is in both lists, and each handed-over column has a statement
		// that actually names it.
		expect(handled.filter((k) => left.includes(k))).toEqual([]);
		for (const r of members.ABSORBED_USER_REFERENCES) {
			expect(r.sql).toContain(r.table);
			expect(r.sql).toContain(r.column);
		}
		const refs = userReferences();
		expect(refs.length).toBeGreaterThan(10);
		// A reference nobody accounted for is a reference the cascade destroys.
		expect(refs.filter((k) => !handled.includes(k) && !left.includes(k))).toEqual([]);
		// And neither list names a column that no longer exists.
		expect([...handled, ...left].filter((k) => !refs.includes(k))).toEqual([]);
	});

	it('hands over who an estimate is for and the stand-in packing list', () => {
		const organizer = auth.createUser('org@example.test', 'ZZ Org', 'hunter2hunter2').id;
		const tripId = trips.createTrip(organizer, {
			name: 'ZZ Merge Trip',
			startDate: '2026-10-01',
			endDate: '2026-10-03',
			homeCurrency: 'EUR'
		})!.id!;
		expect(members.addPerson(tripId, organizer, 'ZZ Stand-in', '')).toBe('created');
		const placeholder = (
			db.prepare(`SELECT id FROM users WHERE name = 'ZZ Stand-in'`).get() as { id: string }
		).id;

		// Raw rows, so the case pins the merge rather than the writers' own rules.
		db.prepare(
			`INSERT INTO cost_items (id, trip_id, category, label, amount_cents, currency, sort, created_at)
			 VALUES ('zz-cost', ?, 'food', 'ZZ Dinner', 1000, 'EUR', 0, 0)`
		).run(tripId);
		db.prepare(`INSERT INTO cost_item_people (item_id, user_id) VALUES ('zz-cost', ?)`).run(
			placeholder
		);
		db.prepare(
			`INSERT INTO trip_tasks (id, trip_id, kind, label, done, sort, created_at, owner_id)
			 VALUES ('zz-pack', ?, 'packing', 'ZZ Socks', 0, 0, 0, ?)`
		).run(tripId, placeholder);

		const real = auth.createUser('real@example.test', 'ZZ Real', 'hunter2hunter2').id;
		expect(members.setMemberEmail(tripId, organizer, placeholder, 'real@example.test')).toBe(
			'merged'
		);

		expect(db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(placeholder)).toBeUndefined();
		expect(
			db.prepare(`SELECT user_id FROM cost_item_people WHERE item_id = 'zz-cost'`).all()
		).toEqual([{ user_id: real }]);
		expect(db.prepare(`SELECT owner_id FROM trip_tasks WHERE id = 'zz-pack'`).get()).toEqual({
			owner_id: real
		});
	});
});
