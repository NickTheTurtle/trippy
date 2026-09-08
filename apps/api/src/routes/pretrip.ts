import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, num, optStr, str, strList } from '../parse';
import type { Env } from '../types';
import { addTask, listTasks, removeTask, toggleTask } from '@trippy/server/tasks';
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
	if (!label) return c.json({ error: 'Describe the task.' }, 400);

	const kind = str(b.kind) === 'packing' ? 'packing' : 'task';
	const id = addTask(c.get('trip').id, c.get('user').id, kind, label, strList(b.assignees), null);
	if (!id) return c.json({ error: 'Could not add that task.' }, 400);
	return c.json({ id }, 201);
});

/**
 * Ticks one person's box. `userId` is optional and defaults to the caller;
 * tasks.ts refuses to complete someone else's share regardless.
 */
pretrip.post('/tasks/:taskId/toggle', async (c) => {
	const userId = optStr((await body(c)).userId) ?? undefined;
	const ok = toggleTask(c.get('trip').id, c.get('user').id, c.req.param('taskId'), userId);
	if (!ok) return c.json({ error: 'You can only tick your own box.' }, 403);
	return c.json({ ok: true });
});

pretrip.delete('/tasks/:taskId', (c) => {
	removeTask(c.get('trip').id, c.get('user').id, c.req.param('taskId'));
	return c.json({ ok: true });
});

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
	if (item.cents === null) return c.json({ error: 'Enter a valid amount.' }, 400);
	if (!addCostItem(c.get('trip').id, c.get('user').id, { ...item, cents: item.cents })) {
		return c.json({ error: 'Could not add that item.' }, 400);
	}
	return c.json({ ok: true }, 201);
});

pretrip.put('/costs/:itemId', async (c) => {
	const item = readItem(await body(c));
	if (item.cents === null) return c.json({ error: 'Enter a valid amount.' }, 400);
	const ok = updateCostItem(c.get('trip').id, c.get('user').id, c.req.param('itemId'), {
		...item,
		cents: item.cents
	});
	if (!ok) return c.json({ error: 'Could not save that item.' }, 400);
	return c.json({ ok: true });
});

pretrip.delete('/costs/:itemId', (c) => {
	removeCostItem(c.get('trip').id, c.get('user').id, c.req.param('itemId'));
	return c.json({ ok: true });
});
