import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { publish } from '../events';

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
}

function isMember(tripId: string, userId: string): boolean {
	return !!db
		.prepare(`SELECT 1 FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.get(tripId, userId);
}

interface TaskBase {
	id: string;
	kind: string;
	label: string;
	flag: string | null;
	done: number;
}

/**
 * Tasks with their assignees. A task with assignees is done only when *every*
 * assignee has ticked their own box; "apply for a visa" isn't finished because
 * one person filed. A task with no assignees falls back to one shared tick.
 */
export function listTasks(tripId: string, kind: string): TaskRow[] {
	const rows = db
		.prepare(
			`SELECT id, kind, label, flag, done FROM trip_tasks
			 WHERE trip_id = ? AND kind = ? ORDER BY sort, created_at`
		)
		.all(tripId, kind) as unknown as TaskBase[];
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
			doneCount
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

	const valid = assigneeIds.filter((uid) => isMember(tripId, uid));
	// Names are still written for the legacy display column, but the assignee
	// rows are the source of truth for who owes what.
	const names = valid.length
		? (
				db
					.prepare(
						`SELECT name FROM users WHERE id IN (${valid.map(() => '?').join(',')}) ORDER BY name`
					)
					.all(...valid) as unknown as { name: string }[]
			)
				.map((r) => r.name)
				.join(', ')
		: '';

	db.exec('BEGIN');
	try {
		db.prepare(
			`INSERT INTO trip_tasks (id, trip_id, kind, label, assignee, flag, done, sort, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
		).run(id, tripId, kind, label, names, flag, sort, Date.now());
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
 * Tick or untick one person's box.
 *
 * `targetId` defaults to the actor, but any member may tick any assignee's box.
 * A trip is planned by people standing next to each other: whoever is holding
 * the phone is the one who ticks, and a rule that only the assignee may say a
 * thing is done just leaves the list wrong. The row records who the task is
 * for, not who pressed the button.
 *
 * A task with no assignees has no per-person rows, so it toggles the shared
 * flag instead.
 */
export function toggleTask(
	tripId: string,
	actorId: string,
	taskId: string,
	targetId?: string
): boolean {
	if (!isMember(tripId, actorId)) return false;
	const task = db
		.prepare(`SELECT id FROM trip_tasks WHERE id = ? AND trip_id = ?`)
		.get(taskId, tripId) as { id: string } | undefined;
	if (!task) return false;

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
		if (anyAssignee) return false;
		db.prepare(`UPDATE trip_tasks SET done = 1 - done WHERE id = ? AND trip_id = ?`).run(
			taskId,
			tripId
		);
		publish(tripId, 'tasks');
		return true;
	}

	const already = !!db
		.prepare(`SELECT 1 FROM task_done WHERE task_id = ? AND user_id = ?`)
		.get(taskId, who);
	if (already) {
		db.prepare(`DELETE FROM task_done WHERE task_id = ? AND user_id = ?`).run(taskId, who);
	} else {
		db.prepare(`INSERT OR IGNORE INTO task_done (task_id, user_id, done_at) VALUES (?, ?, ?)`).run(
			taskId,
			who,
			Date.now()
		);
	}
	publish(tripId, 'tasks');
	return true;
}

export function removeTask(tripId: string, actorId: string, taskId: string): boolean {
	if (!isMember(tripId, actorId)) return false;
	const res = db.prepare(`DELETE FROM trip_tasks WHERE id = ? AND trip_id = ?`).run(taskId, tripId);
	if (Number(res.changes) > 0) publish(tripId, 'tasks');
	return Number(res.changes) > 0;
}
