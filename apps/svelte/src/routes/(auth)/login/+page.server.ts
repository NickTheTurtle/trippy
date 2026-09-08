import { fail, redirect } from '@sveltejs/kit';
import { createSession, findUserByEmail, verifyPassword } from '@trippy/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) throw redirect(303, '/trips');
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');

		if (!email || !password) {
			return fail(400, { email, error: 'Enter your email and password.' });
		}

		const user = findUserByEmail(email);
		if (!user || !verifyPassword(password, user.password_hash)) {
			return fail(400, { email, error: 'Email or password is incorrect.' });
		}

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
