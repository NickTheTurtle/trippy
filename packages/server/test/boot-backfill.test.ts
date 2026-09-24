import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Boot-time backfills run once, not on every boot.
 *
 * `db.ts` used to copy `trip_tasks.done = 1` into a `task_done` row for every
 * assignee on every start. A task keeps that legacy flag after it gains
 * assignees, so anybody who unticked their own box had it ticked again by the
 * next restart, which under `tsx watch` is the next saved file. Both task
 * backfills are behind a `schema_backfills` marker now. These cases boot the
 * same throwaway database more than once to prove it.
 */

const tempRoot = join(tmpdir(), `trippy-boot-backfill-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'boot-backfill.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

type Db = Awaited<typeof import('../src/db.ts')>['db'];
let db: Db | null = null;

/** Open the database the way the server does on start, closing any previous boot. */
async function boot(): Promise<Db> {
	db?.close();
	vi.resetModules();
	db = (await import('../src/db.ts')).db;
	db.exec('PRAGMA foreign_keys = ON');
	return db;
}

afterAll(() => {
	db?.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

let seq = 0;
/** A trip with one member and one task, written with plain SQL so any boot can read it. */
function seedTask(d: Db, name: string): { taskId: string; userId: string } {
	seq += 1;
	const userId = `zz-user-${seq}`;
	const tripId = `zz-trip-${seq}`;
	const taskId = `zz-task-${seq}`;
	d.prepare(
		`INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, 'x', 0)`
	).run(userId, `${userId}@example.test`, name);
	d.prepare(
		`INSERT INTO trips (id, name, dates, cover, organizer_id, created_at)
		 VALUES (?, 'ZZ Trip', '', '', ?, 0)`
	).run(tripId, userId);
	d.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'organizer')`).run(
		tripId,
		userId
	);
	d.prepare(
		`INSERT INTO trip_tasks (id, trip_id, kind, label, assignee, done, sort, created_at)
		 VALUES (?, ?, 'task', 'ZZ Visa', ?, 1, 0, 0)`
	).run(taskId, tripId, name);
	return { taskId, userId };
}

function ticks(d: Db, taskId: string): number {
	return (
		d.prepare(`SELECT COUNT(*) AS n FROM task_done WHERE task_id = ?`).get(taskId) as { n: number }
	).n;
}

describe('the task roster backfill', () => {
	it('does not re-tick a box somebody unticked, however many times the server starts', async () => {
		let d = await boot();
		const { taskId, userId } = seedTask(d, 'ZZ Ana');
		// A task in the state that used to trip it: the legacy shared flag still
		// set, an assignee row, and no tick from that assignee.
		d.prepare(`INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)`).run(taskId, userId);
		expect(ticks(d, taskId)).toBe(0);

		d = await boot();
		expect(ticks(d, taskId)).toBe(0);
		d = await boot();
		expect(ticks(d, taskId)).toBe(0);
	});

	it('does not re-match names onto a task whose roster was emptied', async () => {
		let d = await boot();
		const { taskId } = seedTask(d, 'ZZ Ben');
		// `assignee` still holds the name, the rows are gone: an emptied roster.
		expect(
			d.prepare(`SELECT COUNT(*) AS n FROM task_assignees WHERE task_id = ?`).get(taskId)
		).toMatchObject({ n: 0 });
		d = await boot();
		expect(
			d.prepare(`SELECT COUNT(*) AS n FROM task_assignees WHERE task_id = ?`).get(taskId)
		).toMatchObject({ n: 0 });
	});

	it('still carries a legacy database across once, and only once', async () => {
		let d = await boot();
		// What a database from before per-person tasks looks like: no roster
		// tables, no marker, and a ticked task naming its person in `assignee`.
		d.exec(`DROP TABLE task_done; DROP TABLE task_assignees;`);
		d.prepare(`DELETE FROM schema_backfills WHERE name = 'task-assignees-from-names'`).run();
		const { taskId, userId } = seedTask(d, 'ZZ Cy');

		d = await boot();
		expect(d.prepare(`SELECT user_id FROM task_assignees WHERE task_id = ?`).all(taskId)).toEqual([
			{ user_id: userId }
		]);
		expect(ticks(d, taskId)).toBe(1);
		// The shared flag is released once the rows are the answer.
		expect(d.prepare(`SELECT done FROM trip_tasks WHERE id = ?`).get(taskId)).toMatchObject({
			done: 0
		});

		// Cy unticks, and the next two starts leave it that way.
		d.prepare(`DELETE FROM task_done WHERE task_id = ?`).run(taskId);
		d = await boot();
		expect(ticks(d, taskId)).toBe(0);
		d = await boot();
		expect(ticks(d, taskId)).toBe(0);
	});
});
