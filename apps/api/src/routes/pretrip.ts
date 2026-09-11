import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, bool, int, num, optStr, str, strList } from '../parse';
import { fail, okOr } from '../respond';
import type { Env } from '../types';
import { addTask, listTasks, removeTask, toggleTask, updateTask } from '@trippy/server/tasks';
import {
	COST_CATEGORIES,
	addCostItem,
	getItemizedBudget,
	removeCostItem,
	updateCostItem
} from '@trippy/server/costs';
import { ensureRatesFresh, knownCurrencies } from '@trippy/server/fx';

export const pretrip = new Hono<Env>();

pretrip.use('*', requireMember);

pretrip.get('/', (c) => {
	const trip = c.get('trip');
	// An estimate can be typed in any currency, so the rates the totals are
	// converted with have to be current, and the dialog needs the list to offer.
	ensureRatesFresh();
	return c.json({
		me: c.get('user').id,
		members: trip.memberList.map((m) => ({ id: m.id, name: m.name })),
		tasks: listTasks(trip.id, 'task'),
		packing: listTasks(trip.id, 'packing'),
		currency: trip.home_currency,
		currencies: knownCurrencies().sort(),
		memberCount: trip.members.length,
		categories: [...COST_CATEGORIES],
		budget: getItemizedBudget(trip.id)
	});
});

// --- Tasks and packing ------------------------------------------------------

pretrip.post('/tasks', async (c) => {
	const b = await body(c);
	const label = str(b.label);
	if (!label) return fail(c, 400, 'Enter a name.');

	const kind = str(b.kind) === 'packing' ? 'packing' : 'task';
	const id = addTask(c.get('trip').id, c.get('user').id, kind, label, strList(b.assignees), null);
	if (!id) return fail(c, 400, 'Could not add that task.');
	return c.json({ id }, 201);
});

/**
 * Rewrites the wording and the roster together; the ticks that survive stay.
 *
 * `version` is what the editor had on screen. A stale one means somebody else
 * saved first, and is answered 409 rather than being applied over their work.
 */
pretrip.put('/tasks/:taskId', async (c) => {
	const b = await body(c);
	const label = str(b.label);
	if (!label) return fail(c, 400, 'Enter a name.');
	const result = updateTask(
		c.get('trip').id,
		c.get('user').id,
		c.req.param('taskId'),
		label,
		strList(b.assignees),
		int(b.version)
	);
	if (!result.ok) {
		return result.reason === 'conflict'
			? fail(c, 409, 'Someone else changed this task. Reload to see their version.')
			: fail(c, 404, 'Could not save that task.');
	}
	return c.json({ ok: true, version: result.version });
});

/**
 * Sets one person's box.
 *
 * `userId` is optional and defaults to the caller; any member may tick any
 * assignee's box. `done` is the state to end up in. Sending it makes the call
 * idempotent, which is what stops two people (or one person tapping twice)
 * cancelling each other out; omitting it flips, for older clients.
 */
pretrip.post('/tasks/:taskId/toggle', async (c) => {
	const b = await body(c);
	const result = toggleTask(
		c.get('trip').id,
		c.get('user').id,
		c.req.param('taskId'),
		optStr(b.userId) ?? undefined,
		bool(b.done)
	);
	if (!result.ok) return fail(c, 404, 'Could not tick that box.');
	return c.json({ ok: true, done: result.done });
});

pretrip.delete('/tasks/:taskId', (c) =>
	okOr(
		c,
		removeTask(c.get('trip').id, c.get('user').id, c.req.param('taskId')),
		404,
		'Could not remove that task.'
	)
);

// --- Estimated costs --------------------------------------------------------

/** The fields a cost item carries, read the same way on create and update. */
function readItem(b: Record<string, unknown>) {
	const amount = num(b.amount);
	return {
		category: str(b.category),
		label: str(b.label),
		currency: str(b.currency),
		assignees: strList(b.assignees),
		cents: amount === null ? null : Math.round(amount * 100)
	};
}

pretrip.post('/costs', async (c) => {
	const item = readItem(await body(c));
	// Checked here rather than left to `addCostItem`, which can only answer
	// false and would report a missing description as "Could not add that item."
	if (!item.label) return fail(c, 400, 'Enter a description.');
	if (item.cents === null) return fail(c, 400, 'Enter a valid amount.');
	if (!addCostItem(c.get('trip').id, c.get('user').id, { ...item, cents: item.cents })) {
		return fail(c, 400, 'Could not add that item.');
	}
	return c.json({ ok: true }, 201);
});

pretrip.put('/costs/:itemId', async (c) => {
	const item = readItem(await body(c));
	if (!item.label) return fail(c, 400, 'Enter a description.');
	if (item.cents === null) return fail(c, 400, 'Enter a valid amount.');
	return okOr(
		c,
		updateCostItem(c.get('trip').id, c.get('user').id, c.req.param('itemId'), {
			...item,
			cents: item.cents
		}),
		400,
		'Could not save that item.'
	);
});

pretrip.delete('/costs/:itemId', (c) =>
	okOr(
		c,
		removeCostItem(c.get('trip').id, c.get('user').id, c.req.param('itemId')),
		404,
		'Could not remove that item.'
	)
);
