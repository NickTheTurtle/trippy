import { json, error } from '@sveltejs/kit';
import { cycleBooking, deleteItem, editItem, moveItem, resizeItem } from '@trippy/server/schedule';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');

	const body = await request.json();
	const itemId = String(body.itemId ?? '');
	const op = String(body.op ?? '');
	if (!itemId) throw error(400, 'Missing itemId');

	let ok = false;
	if (op === 'move') {
		ok = moveItem(itemId, locals.user.id, Number(body.startMin));
	} else if (op === 'resize') {
		ok = resizeItem(itemId, locals.user.id, Number(body.endMin));
	} else if (op === 'edit') {
		ok = editItem(itemId, locals.user.id, {
			title: body.title != null ? String(body.title) : undefined,
			type: body.type != null ? String(body.type) : undefined,
			travelBefore:
				body.travelBefore === undefined
					? undefined
					: body.travelBefore === null || body.travelBefore === ''
						? null
						: Number(body.travelBefore)
		});
	} else if (op === 'cycle') {
		ok = cycleBooking(itemId, locals.user.id);
	} else if (op === 'delete') {
		ok = deleteItem(itemId, locals.user.id);
	} else {
		throw error(400, 'Unknown op');
	}

	if (!ok) throw error(403, 'Not allowed');
	return json({ ok: true });
};
