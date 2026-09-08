import { redirect } from '@sveltejs/kit';
import { deleteSession } from '@trippy/server/auth';
import type { Actions } from './$types';

export const actions: Actions = {
	default: ({ cookies, locals }) => {
		if (locals.sessionId) deleteSession(locals.sessionId);
		cookies.delete('session', { path: '/' });
		throw redirect(303, '/');
	}
};
