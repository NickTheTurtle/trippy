import { fail, redirect } from '@sveltejs/kit';
import { changePassword, findUserById, updateProfile } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

function timeZones(): string[] {
	// Full IANA list where supported, with a small fallback set otherwise.
	const withValues = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
	if (typeof withValues.supportedValuesOf === 'function') {
		try {
			return withValues.supportedValuesOf('timeZone');
		} catch {
			// fall through
		}
	}
	return ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Shanghai'];
}

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const user = findUserById(locals.user.id);
	if (!user) throw redirect(303, '/login');
	return {
		profile: { name: user.name, email: user.email, homeTz: user.home_tz },
		timeZones: timeZones()
	};
};

export const actions: Actions = {
	profile: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const form = await request.formData();
		const name = String(form.get('name') ?? '');
		const email = String(form.get('email') ?? '');
		const homeTz = String(form.get('homeTz') ?? 'UTC');
		const res = updateProfile(locals.user.id, name, email, homeTz);
		if (!res.ok) return fail(400, { section: 'profile', error: res.error });
		return { section: 'profile', ok: true };
	},

	password: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const form = await request.formData();
		const current = String(form.get('current') ?? '');
		const next = String(form.get('next') ?? '');
		const confirm = String(form.get('confirm') ?? '');
		if (next !== confirm)
			return fail(400, { section: 'password', error: 'New passwords do not match.' });
		const res = changePassword(locals.user.id, current, next);
		if (!res.ok) return fail(400, { section: 'password', error: res.error });
		return { section: 'password', ok: true };
	}
};
