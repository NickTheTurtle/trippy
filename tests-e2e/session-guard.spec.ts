import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { apiURL, registerUser, sessionValue } from './fixtures/api';

/**
 * The session middleware's 401, from the outside.
 *
 * `session-guard.test.ts` in `@trippy/server` pins that the lookup returns null
 * for a bad or expired id; this pins that the API turns that null into a 401 on
 * a real authenticated route, so a request carrying a made-up cookie, or one
 * whose session has aged out, is refused rather than served.
 */

/** The throwaway database the e2e API server writes to, for expiring a session. */
function throwawayDb(): DatabaseSync {
	const configured = process.env.E2E_TRIPPY_DB ?? process.env.TRIPPY_DB;
	if (!configured) throw new Error('Set E2E_TRIPPY_DB or TRIPPY_DB to the throwaway database.');
	return new DatabaseSync(resolve(configured));
}

test.describe('session middleware', () => {
	test('refuses an authenticated route with a made-up cookie', async ({ request }) => {
		const res = await request.get(`${apiURL}/trips`, {
			headers: { cookie: 'session=not-a-real-session-id' }
		});
		expect(res.status()).toBe(401);
		expect((await res.json()).error).toBe('Not signed in.');
	});

	test('refuses once the session has expired', async ({ request }) => {
		const user = await registerUser(request);
		try {
			// The freshly issued cookie works.
			const ok = await request.get(`${apiURL}/trips`, {
				headers: { cookie: user.sessionCookie }
			});
			expect(ok.status()).toBe(200);

			// Age the session out the way real time passing would.
			const id = sessionValue(user.sessionCookie);
			const db = throwawayDb();
			try {
				db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, id);
			} finally {
				db.close();
			}

			const res = await request.get(`${apiURL}/trips`, {
				headers: { cookie: user.sessionCookie }
			});
			expect(res.status()).toBe(401);
			expect((await res.json()).error).toBe('Not signed in.');
		} finally {
			user.teardown();
		}
	});
});
