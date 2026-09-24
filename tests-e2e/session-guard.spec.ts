import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { apiURL, registerUser, sessionValue } from './fixtures/api';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

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

	test('a tab whose session ends is sent to log in, and back to where it was', async ({
		page,
		request
	}) => {
		const user = await registerUser(request);
		try {
			const created = await request.post(`${apiURL}/trips`, {
				headers: { cookie: user.sessionCookie },
				data: {
					name: 'Expiring trip',
					dates: '',
					startDate: '2027-02-10',
					endDate: '2027-02-12',
					homeCurrency: 'USD'
				}
			});
			expect(created.status()).toBe(201);
			const tripId = ((await created.json()) as { trip: { id: string } }).trip.id;

			await signIn(page, user.sessionCookie);
			await page.goto(`/trips/${tripId}/expenses`);
			await expect(
				page.getByRole('button', { name: copy.expenses.addExpense, exact: true })
			).toBeVisible();

			// The session ends underneath the open tab.
			const db = throwawayDb();
			try {
				db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).run(
					Date.now() - 1,
					sessionValue(user.sessionCookie)
				);
			} finally {
				db.close();
			}

			// The next thing the tab loads is refused, and the tab stops pretending.
			await page.getByRole('link', { name: copy.nav.people, exact: true }).click();
			await expect(page).toHaveURL(/\/login$/);
			await expect(page.getByRole('heading', { name: copy.auth.login.title })).toBeVisible();

			// Logging in again returns to the page that was being opened.
			await page.getByLabel(copy.auth.login.emailLabel).fill(user.email);
			await page.getByLabel(copy.auth.login.passwordLabel).fill(user.password);
			await page.getByRole('button', { name: copy.auth.login.submitLabel }).click();
			await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/people$`));
		} finally {
			user.teardown();
		}
	});

	test('the public pages do not bounce a signed-out visitor around', async ({ page }) => {
		// A 401 from /auth/me is the answer for a visitor, not a session ending.
		await page.goto('/');
		await expect(
			page.getByRole('main').getByRole('link', { name: copy.landing.primaryCta })
		).toBeVisible();
		await page.goto('/login');
		await expect(page).toHaveURL(/\/login$/);
		// A wrong password is a 401 too, and must not be read as one either.
		await page.getByLabel(copy.auth.login.emailLabel).fill('nobody@example.test');
		await page.getByLabel(copy.auth.login.passwordLabel).fill('not-a-password');
		await page.getByRole('button', { name: copy.auth.login.submitLabel }).click();
		await expect(page.locator('.toast.bad')).toBeVisible();
		await expect(page).toHaveURL(/\/login$/);
	});
});
