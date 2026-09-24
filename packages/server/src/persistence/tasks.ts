import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { publish } from '../events';
import { conflict, isStale, missing, written, type WriteResult } from './versioning';
import { isMember } from './membership';

export interface TaskPerson {
	id: string;
	name: string;
	done: boolean;
}

export interface TaskRow {
	id: string;
	kind: string;
	label: string;
	flag: string | null;
	/** Everyone responsible for this task, each with their own completion. */
	people: TaskPerson[];
	/** Shared flag, only meaningful when nobody is assigned. */
	shared: boolean;
	/** True when the task needs nothing further from anyone. */
	done: boolean;
	doneCount: number;
	/** Bumped by every edit. Send it back with a PUT to detect a lost update. */
	version: number;
}

/**
 * The names behind a set of ids, for the legacy `assignee` display column.
 * The assignee rows are the source of truth for who owes what; this column is
 * only still written so older readers of the table keep working.
 */
function memberNames(userIds: string[]): string {
	if (userIds.length === 0) return '';
	const rows = db
		.prepare(
			`SELECT name FROM users WHERE id IN (${userIds.map(() => '?').join(',')}) ORDER BY name`
		)
		.all(...userIds) as unknown as { name: string }[];
	return rows.map((r) => r.name).join(', ');
}

interface TaskBase {
	id: string;
	kind: string;
	label: string;
	flag: string | null;
	done: number;
	version: number;
}

/**
 * Tasks with their assignees. A task with assignees is done only when *every*
 * assignee has ticked their own box; "apply for a visa" isn't finished because
 * one person filed. A task with no assignees falls back to one shared tick.
 *
 * A packing list is private, so `ownerId` scopes the rows to one person. It is
 * required for packing and meaningless for tasks, which belong to the trip.
 */
export function listTasks(tripId: string, kind: string, ownerId?: string): TaskRow[] {
	const mine = kind === 'packing';
	const rows = db
		.prepare(
			`SELECT id, kind, label, flag, done, version FROM trip_tasks
			 WHERE trip_id = ? AND kind = ?${mine ? ' AND owner_id = ?' : ''} ORDER BY sort, created_at`
		)
		.all(...(mine ? [tripId, kind, ownerId ?? ''] : [tripId, kind])) as unknown as TaskBase[];
	if (rows.length === 0) return [];

	const people = db
		.prepare(
			`SELECT a.task_id AS task_id, u.id AS id, u.name AS name,
			        (d.user_id IS NOT NULL) AS done
			   FROM task_assignees a
			   JOIN trip_tasks t ON t.id = a.task_id
			   JOIN users u ON u.id = a.user_id
			   LEFT JOIN task_done d ON d.task_id = a.task_id AND d.user_id = a.user_id
			  WHERE t.trip_id = ? AND t.kind = ?
			  ORDER BY u.name`
		)
		.all(tripId, kind) as unknown as {
		task_id: string;
		id: string;
		name: string;
		done: number;
	}[];

	const byTask = new Map<string, TaskPerson[]>();
	for (const p of people) {
		const list = byTask.get(p.task_id) ?? [];
		list.push({ id: p.id, name: p.name, done: !!p.done });
		byTask.set(p.task_id, list);
	}

	const tasks = rows.map((r) => {
		const assigned = byTask.get(r.id) ?? [];
		const doneCount = assigned.filter((p) => p.done).length;
		return {
			id: r.id,
			kind: r.kind,
			label: r.label,
			flag: r.flag,
			people: assigned,
			shared: !!r.done,
			done: assigned.length > 0 ? doneCount === assigned.length : !!r.done,
			doneCount,
			version: r.version
		};
	});

	// Outstanding work first. Sorted here rather than in SQL because whether a
	// task is done now depends on the assignee rows, not a single column.
	return tasks.sort((a, b) => Number(a.done) - Number(b.done));
}

export function addTask(
	tripId: string,
	actorId: string,
	kind: string,
	label: string,
	assigneeIds: string[],
	flag: string | null
): string | null {
	if (!isMember(tripId, actorId)) return null;
	const id = randomUUID();
	const sort =
		(
			db
				.prepare(
					`SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM trip_tasks WHERE trip_id = ? AND kind = ?`
				)
				.get(tripId, kind) as { n: number } | undefined
		)?.n ?? 0;

	// A packing item is one person's own bag: it takes no roster, and it belongs
	// to whoever wrote it rather than to the trip.
	const valid = (kind === 'packing' ? [] : assigneeIds).filter((uid) => isMember(tripId, uid));
	const names = memberNames(valid);
	const owner = kind === 'packing' ? actorId : null;

	db.exec('BEGIN');
	try {
		db.prepare(
			`INSERT INTO trip_tasks (id, trip_id, kind, label, assignee, flag, done, sort, created_at, owner_id)
			 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
		).run(id, tripId, kind, label, names, flag, sort, Date.now(), owner);
		const ins = db.prepare(`INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)`);
		for (const uid of valid) ins.run(id, uid);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	publish(tripId, 'tasks'); // after COMMIT
	return id;
}

/**
 * Rewrites a task's wording and its roster.
 *
 * A task is written before the trip is worked out, so both halves of it change:
 * the wording because "book something" becomes "book the 9:40 ferry", and the
 * roster because the person it was for drops out. Deleting and re-adding was
 * the only way to do either, which threw away everyone else's ticks.
 *
 * Dropping someone also drops their tick. Keeping it would leave a row that
 * counts as done by a person the task is no longer for.
 *
 * A packing item takes no roster whatever it is sent, so an older client, or
 * one editing an item from before the rule, cannot put one back on. It is also
 * its owner's alone: nobody else may rewrite what is in your bag.
 *
 * `expectedVersion` is the version the editor was looking at. If the row has
 * moved on since, the write is refused instead of applied: the caller's copy of
 * the label and the roster is stale, and writing it would put back whatever the
 * other editor just changed. Omitting it keeps the old unchecked behaviour.
 */
export function updateTask(
	tripId: string,
	actorId: string,
	taskId: string,
	label: string,
	assigneeIds: string[],
	expectedVersion?: number | null
): WriteResult {
	if (!isMember(tripId, actorId)) return missing;
	const row = db
		.prepare(`SELECT kind, version, owner_id FROM trip_tasks WHERE id = ? AND trip_id = ?`)
		.get(taskId, tripId) as { kind: string; version: number; owner_id: string | null } | undefined;
	if (!row) return missing;
	if (row.owner_id && row.owner_id !== actorId) return missing;
	if (isStale(expectedVersion, row.version)) return conflict;

	const valid = (row.kind === 'packing' ? [] : assigneeIds).filter((uid) => isMember(tripId, uid));
	const names = memberNames(valid);
	const holes = valid.map(() => '?').join(',');
	const next = row.version + 1;

	db.exec('BEGIN');
	try {
		// A task with people on it is answered by their own ticks, so the shared
		// flag is released as it gains them. Left set, it resurfaced as "done" the
		// moment the roster was emptied again, and a boot-time backfill that read
		// it re-ticked everyone who had unticked (see TASK_ROSTER_BACKFILL).
		db.prepare(
			`UPDATE trip_tasks SET label = ?, assignee = ?, version = ?${valid.length ? ', done = 0' : ''}
			 WHERE id = ? AND trip_id = ?`
		).run(label, names, next, taskId, tripId);
		db.prepare(
			`DELETE FROM task_assignees WHERE task_id = ?${valid.length ? ` AND user_id NOT IN (${holes})` : ''}`
		).run(taskId, ...valid);
		db.prepare(
			`DELETE FROM task_done WHERE task_id = ?${valid.length ? ` AND user_id NOT IN (${holes})` : ''}`
		).run(taskId, ...valid);
		const ins = db.prepare(`INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)`);
		for (const uid of valid) ins.run(taskId, uid);
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	publish(tripId, 'tasks'); // after COMMIT
	return written(next);
}

/**
 * Set one person's box to a given state.
 *
 * `targetId` defaults to the actor, but any member may tick any assignee's box.
 * A trip is planned by people standing next to each other: whoever is holding
 * the phone is the one who ticks, and a rule that only the assignee may say a
 * thing is done just leaves the list wrong. The row records who the task is
 * for, not who pressed the button.
 *
 * `desired` is the state to end up in, not an instruction to flip. That
 * distinction is the whole point of this signature. A flip applies the caller's
 * *action*; a set applies the caller's *intent*, and only the second one is
 * safe when the same box can be tapped from four phones. Two members who both
 * mean "this is done" used to cancel each other out and leave it undone, and so
 * did one member double-tapping because the first tap looked like it did
 * nothing. Neither was reported as an error, because from the server's side
 * both requests succeeded.
 *
 * Omitting `desired` still flips, so an older client keeps working.
 *
 * A task with no assignees has no per-person rows, so it sets the shared flag
 * instead. Returns the state the box is now in, which lets a client correct
 * itself when its optimistic guess disagreed.
 *
 * A packing item is the exception to "anyone may tick anyone": it is one
 * person's own list, and nobody else can see it to tick it.
 */
export function toggleTask(
	tripId: string,
	actorId: string,
	taskId: string,
	targetId?: string,
	desired?: boolean | null
): { ok: false } | { ok: true; done: boolean } {
	if (!isMember(tripId, actorId)) return { ok: false };
	const task = db
		.prepare(`SELECT id, owner_id FROM trip_tasks WHERE id = ? AND trip_id = ?`)
		.get(taskId, tripId) as { id: string; owner_id: string | null } | undefined;
	if (!task) return { ok: false };
	if (task.owner_id && task.owner_id !== actorId) return { ok: false };

	const who = targetId ?? actorId;
	// Membership of the target is not checked separately: the assignee lookup
	// below only matches rows that were written through `addTask`, which takes
	// members.
	const assigned = !!db
		.prepare(`SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ?`)
		.get(taskId, who);

	if (!assigned) {
		// Fall back to the shared flag only when the task is unassigned entirely.
		// Otherwise this is someone else's task and there is nothing to toggle.
		const anyAssignee = !!db.prepare(`SELECT 1 FROM task_assignees WHERE task_id = ?`).get(taskId);
		if (anyAssignee) return { ok: false };
		const current = !!(
			db.prepare(`SELECT done FROM trip_tasks WHERE id = ? AND trip_id = ?`).get(taskId, tripId) as
				{ done: number } | undefined
		)?.done;
		const next = desired ?? !current;
		if (next !== current) {
			db.prepare(`UPDATE trip_tasks SET done = ? WHERE id = ? AND trip_id = ?`).run(
				next ? 1 : 0,
				taskId,
				tripId
			);
			publish(tripId, 'tasks');
		}
		return { ok: true, done: next };
	}

	const already = !!db
		.prepare(`SELECT 1 FROM task_done WHERE task_id = ? AND user_id = ?`)
		.get(taskId, who);
	const next = desired ?? !already;
	// A no-op write still publishes nothing: the second of two identical taps
	// changes no rows, so sending an invalidation would make every other client
	// refetch a section that did not move.
	if (next === already) return { ok: true, done: next };

	if (next) {
		db.prepare(`INSERT OR IGNORE INTO task_done (task_id, user_id, done_at) VALUES (?, ?, ?)`).run(
			taskId,
			who,
			Date.now()
		);
	} else {
		db.prepare(`DELETE FROM task_done WHERE task_id = ? AND user_id = ?`).run(taskId, who);
	}
	publish(tripId, 'tasks');
	return { ok: true, done: next };
}

export function removeTask(tripId: string, actorId: string, taskId: string): boolean {
	if (!isMember(tripId, actorId)) return false;
	// `owner_id IS NULL` is the trip's own row, which any member may remove; a
	// packing item can only be thrown out by the person whose bag it is.
	const res = db
		.prepare(
			`DELETE FROM trip_tasks WHERE id = ? AND trip_id = ? AND (owner_id IS NULL OR owner_id = ?)`
		)
		.run(taskId, tripId, actorId);
	if (Number(res.changes) > 0) publish(tripId, 'tasks');
	return Number(res.changes) > 0;
}
