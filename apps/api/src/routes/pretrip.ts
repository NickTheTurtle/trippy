import { Hono } from 'hono';
import { requireMember } from '../middleware';
import { body, bool, int, num, optStr, str, strList } from '../parse';
import { fail, goneMessage, okOr } from '../respond';
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
import { crewsForTrip } from '@trippy/server/schedule';
import { isCurrencyCode, unknownCurrency } from '@trippy/core/currency';
import { amountTooLarge, isAmountInRange, isNameLength, nameTooLong } from '@trippy/core/validate';
import { isNotesBodyLength, notesBodyTooLong } from '@trippy/core/notes';
import { getNotes, saveNotes } from '@trippy/server/notes';

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
		// Crews ride along for the people pickers in the task and cost dialogs:
		// assigning a saved group is one pick there instead of five.
		crews: crewsForTrip(trip.id),
		tasks: listTasks(trip.id, 'task'),
		packing: listTasks(trip.id, 'packing', c.get('user').id),
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
	if (!isNameLength(label)) return fail(c, 400, nameTooLong());

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
	if (!isNameLength(label)) return fail(c, 400, nameTooLong());
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
			: fail(c, 404, goneMessage('task'));
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
	if (!result.ok) return fail(c, 404, goneMessage('task'));
	return c.json({ ok: true, done: result.done });
});

pretrip.delete('/tasks/:taskId', (c) =>
	okOr(
		c,
		removeTask(c.get('trip').id, c.get('user').id, c.req.param('taskId')),
		404,
		goneMessage('task')
	)
);

// --- Estimated costs --------------------------------------------------------

/** The fields a cost item carries, read the same way on create and update. */
function readItem(b: Record<string, unknown>) {
	const amount = num(b.amount);
	return {
		category: str(b.category),
		label: str(b.label),
		// Upper-cased here so the check below judges exactly what gets stored.
		// Blank stays blank, and blank means the trip's home currency.
		currency: str(b.currency).toUpperCase(),
		assignees: strList(b.assignees),
		cents: amount === null ? null : Math.round(amount * 100)
	};
}

/**
 * What is wrong with a cost item's amount, or null when nothing is.
 *
 * Shared by create and update so the two cannot drift. Each case used to fall
 * through to "Could not add that item.", which is the same sentence for a
 * negative price, a rounding-to-nothing price and a price large enough to make
 * the trip total meaningless. An estimate of `0.001` rounded to zero cents and
 * saved as `$0` without a word.
 */
function amountProblem(cents: number | null): string | null {
	if (cents === null) return 'Enter a valid amount.';
	if (cents < 0) return 'An estimate cannot be negative.';
	if (cents === 0) return 'Enter an amount above zero.';
	if (!isAmountInRange(cents)) return amountTooLarge();
	return null;
}

pretrip.post('/costs', async (c) => {
	const item = readItem(await body(c));
	// Checked here rather than left to `addCostItem`, which can only answer
	// false and would report a missing description as "Could not add that item."
	if (!item.label) return fail(c, 400, 'Enter a description.');
	if (!isNameLength(item.label)) return fail(c, 400, nameTooLong());
	if (item.currency && !isCurrencyCode(item.currency)) return fail(c, 400, unknownCurrency());
	const bad = amountProblem(item.cents);
	if (bad) return fail(c, 400, bad);
	if (!addCostItem(c.get('trip').id, c.get('user').id, { ...item, cents: item.cents as number })) {
		return fail(c, 400, 'Could not add that item.');
	}
	return c.json({ ok: true }, 201);
});

pretrip.put('/costs/:itemId', async (c) => {
	const item = readItem(await body(c));
	if (!item.label) return fail(c, 400, 'Enter a description.');
	if (!isNameLength(item.label)) return fail(c, 400, nameTooLong());
	if (item.currency && !isCurrencyCode(item.currency)) return fail(c, 400, unknownCurrency());
	const bad = amountProblem(item.cents);
	if (bad) return fail(c, 400, bad);
	return okOr(
		c,
		updateCostItem(c.get('trip').id, c.get('user').id, c.req.param('itemId'), {
			...item,
			cents: item.cents as number
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
		goneMessage('item')
	)
);

// --- Notes ------------------------------------------------------------------

/** What a save that cannot be read as notes is told. `copy.preparation.notes.saveFallback`. */
const NOTES_MALFORMED = 'Could not save the notes.';

/** What a save that lost the race is told; the current notes ride along. */
export const NOTES_CONFLICT = 'Someone else changed the notes.';

/**
 * The trip's shared notepad: `{ body, version, updatedAt, updatedBy }`.
 *
 * Its own endpoint rather than a field on `GET /`, because it is saved every
 * time somebody pauses typing and refetched on every `notes` event; carrying it
 * on the page payload would make each of those reload tasks, packing and the
 * budget too.
 */
pretrip.get('/notes', (c) => c.json(getNotes(c.get('trip').id)));

/**
 * Save the notepad. `{ body, version, base?, priorBase? }`, where `version` is
 * the one the editor loaded (0 for a trip that has never saved notes) and
 * `base` is the stored text at that version, which `body` was typed on top of.
 *
 * A stale version without `base` is a 409 carrying the current notes, so the
 * client can merge its text into them (`mergeNotes`) and save again. With
 * `base`, the server does that merge itself whenever the stored text is no
 * longer `base`, even at a matching version (a background save may send an
 * optimistic version that someone else's save already took), and answers 200
 * with `merged: true`, because the saves that most need it are the ones
 * nobody is left to retry: a keepalive save from a closing page, or from a
 * notepad that has already unmounted. A merge over the ceiling is refused with
 * the too-long sentence and the current notes, and nothing is written.
 *
 * `priorBase?` is for a speculative save sent on hide or background while
 * another save is still in flight: `base` is that in-flight save's text and
 * `priorBase` the base it was sent from. A store holding either is written
 * with `body` as is; anything else is merged from `priorBase`, the older
 * ancestor, so an in-flight save that never landed loses nothing. It is only
 * accepted alongside `base`.
 *
 * The body is stored exactly as sent, untrimmed: leading spaces and blank lines
 * are part of what was typed. Any member may save; the schedule lock does not
 * reach Preparation.
 */
pretrip.put('/notes', async (c) => {
	const b = await body(c);
	const text = b.body;
	const version = b.version;
	const base = b.base;
	const priorBase = b.priorBase;
	if (typeof text !== 'string') return fail(c, 400, NOTES_MALFORMED);
	if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
		return fail(c, 400, NOTES_MALFORMED);
	}
	// Absent means "no merge". Anything sent must be a string the server could
	// itself have stored; a longer one cannot be a text this notepad ever held.
	if (base !== undefined && (typeof base !== 'string' || !isNotesBodyLength(base))) {
		return fail(c, 400, NOTES_MALFORMED);
	}
	// The same for the older ancestor, which means nothing without a base.
	if (
		priorBase !== undefined &&
		(base === undefined || typeof priorBase !== 'string' || !isNotesBodyLength(priorBase))
	) {
		return fail(c, 400, NOTES_MALFORMED);
	}
	if (!isNotesBodyLength(text)) return fail(c, 400, notesBodyTooLong());

	const result = saveNotes(
		c.get('trip').id,
		c.get('user').id,
		text,
		version,
		typeof base === 'string' ? base : undefined,
		typeof priorBase === 'string' ? priorBase : undefined
	);
	if (result.ok) {
		return c.json(result.merged ? { ...result.notes, merged: true } : result.notes);
	}
	if (result.reason === 'conflict') {
		return c.json({ error: NOTES_CONFLICT, notes: result.notes }, 409);
	}
	if (result.reason === 'too-long') {
		return c.json({ error: notesBodyTooLong(), notes: result.notes }, 400);
	}
	return fail(c, 400, NOTES_MALFORMED);
});
