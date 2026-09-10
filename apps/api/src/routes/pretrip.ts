import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, num, optStr, str, strList } from '../parse';
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

export const pretrip = new Hono<Env>();

pretrip.use('*', requireMember);

pretrip.get('/', (c) => {
	const trip = c.get('trip');
	return c.json({
		me: c.get('user').id,
		members: trip.memberList.map((m) => ({ id: m.id, name: m.name })),
		tasks: listTasks(trip.id, 'task'),
		packing: listTasks(trip.id, 'packing'),
		currency: trip.home_currency,
		memberCount: trip.members.length,
		categories: [...COST_CATEGORIES],
		cities: trip.cities.map((x) => ({ id: x.id, name: x.name })),
		budget: getItemizedBudget(trip.id)
	});
});

// --- Tasks and packing ------------------------------------------------------

pretrip.post('/tasks', async (c) => {
	const b = await body(c);
	const label = str(b.label);
	if (!label) return fail(c, 400, 'Describe the task.');

	const kind = str(b.kind) === 'packing' ? 'packing' : 'task';
	const id = addTask(c.get('trip').id, c.get('user').id, kind, label, strList(b.assignees), null);
	if (!id) return fail(c, 400, 'Could not add that task.');
	return c.json({ id }, 201);
});

/** Rewrites the wording and the roster together; the ticks that survive stay. */
pretrip.put('/tasks/:taskId', async (c) => {
	const b = await body(c);
	const label = str(b.label);
	if (!label) return fail(c, 400, 'Describe the task.');
	return okOr(
		c,
		updateTask(
			c.get('trip').id,
			c.get('user').id,
			c.req.param('taskId'),
			label,
			strList(b.assignees)
		),
		404,
		'Could not save that task.'
	);
});

/**
 * Ticks one person's box. `userId` is optional and defaults to the caller; any
 * member may tick any assignee's box.
 */
pretrip.post('/tasks/:taskId/toggle', async (c) => {
	const userId = optStr((await body(c)).userId) ?? undefined;
	return okOr(
		c,
		toggleTask(c.get('trip').id, c.get('user').id, c.req.param('taskId'), userId),
		404,
		'Could not tick that box.'
	);
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

/** The four fields a cost item carries, read the same way on create and update. */
function readItem(b: Record<string, unknown>) {
	const amount = num(b.amount);
	return {
		cityId: optStr(b.cityId),
		category: str(b.category),
		label: str(b.label),
		cents: amount === null ? null : Math.round(amount * 100)
	};
}

pretrip.post('/costs', async (c) => {
	const item = readItem(await body(c));
	if (item.cents === null) return fail(c, 400, 'Enter a valid amount.');
	if (!addCostItem(c.get('trip').id, c.get('user').id, { ...item, cents: item.cents })) {
		return fail(c, 400, 'Could not add that item.');
	}
	return c.json({ ok: true }, 201);
});

pretrip.put('/costs/:itemId', async (c) => {
	const item = readItem(await body(c));
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
