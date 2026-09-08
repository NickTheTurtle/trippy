import { fail, redirect } from '@sveltejs/kit';
import { createSession, createUser, findUserByEmail } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) throw redirect(303, '/trips');
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');

		if (!name || !email || !password) {
			return fail(400, { name, email, error: 'All fields are required.' });
		}
		if (password.length < 8) {
			return fail(400, { name, email, error: 'Password must be at least 8 characters.' });
		}
		if (findUserByEmail(email)) {
			return fail(400, { name, email, error: 'An account with that email already exists.' });
		}

		const user = createUser(email, name, password);
		const sessionId = createSession(user.id);
		cookies.set('session', sessionId, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			maxAge: 60 * 60 * 24 * 30
		});
		throw redirect(303, '/trips');
	}
};
