import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiURL, registerUser } from './fixtures/api';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

/**
 * Account settings: the profile the app greets you by. The two forms fail for
 * unrelated reasons and keep separate messages, so the Save being driven is
 * scoped to the Profile section rather than picked by position.
 */

const ca = copy.account;

test.describe('account', () => {
	test('profile changes to name, email and home time zone persist across a reload', async ({
		page,
		request
	}) => {
		const user = await registerUser(request);
		const newEmail = `nova-${randomUUID()}@example.test`;
		try {
			await signIn(page, user.sessionCookie);
			await page.goto('/account');

			// Two Save buttons on the page, so everything is scoped to the Profile card.
			const profile = page
				.locator('section')
				.filter({ has: page.getByRole('heading', { name: ca.profile.heading }) });

			await profile.getByLabel(ca.profile.nameLabel).fill('Nova Traveler');
			await profile.getByLabel(ca.profile.emailLabel).fill(newEmail);
			// The home zone is a custom Select, opened by its accessible name.
			await profile.getByRole('button', { name: ca.profile.timeZoneAriaLabel }).click();
			await page.getByRole('option', { name: 'America/New York', exact: true }).click();
			await profile.getByRole('button', { name: copy.common.save }).click();

			// The confirmation is a corner toast, so it is on the page rather than in
			// the card: the save outlives the form, which remounts on a new email.
			await expect(page.locator('.toast.ok').filter({ hasText: ca.profile.saved })).toBeVisible();

			// A reload reseeds the fields from what was stored, so surviving it is the
			// proof the change persisted rather than lingering in form state.
			await page.reload();
			await expect(profile.getByLabel(ca.profile.nameLabel)).toHaveValue('Nova Traveler');
			await expect(profile.getByLabel(ca.profile.emailLabel)).toHaveValue(newEmail);
			await expect(profile.locator('button.seltrigger')).toContainText('America/New York');

			// And the server agrees, underscore and all, not just the rendered label.
			const account = await page.request.get(`${apiURL}/account`);
			const body = await account.json();
			expect(body.profile.name).toBe('Nova Traveler');
			expect(body.profile.email).toBe(newEmail);
			expect(body.profile.homeTz).toBe('America/New_York');
		} finally {
			user.teardown();
		}
	});

	/**
	 * The corner popups, driven from the one page that can raise both tones a few
	 * seconds apart: the profile save succeeds and the password save is refused.
	 */
	test('results stack in the corner, an error waits to be dismissed and a success expires', async ({
		page,
		request
	}) => {
		const user = await registerUser(request);
		try {
			await signIn(page, user.sessionCookie);
			await page.goto('/account');

			const profile = page
				.locator('section')
				.filter({ has: page.getByRole('heading', { name: ca.profile.heading }) });
			const password = page
				.locator('section')
				.filter({ has: page.getByRole('heading', { name: ca.password.heading }) });

			await profile.getByRole('button', { name: copy.common.save }).click();
			const ok = page.locator('.toast.ok');
			await expect(ok).toHaveCount(1);
			// Politely for a success, so it waits its turn rather than cutting in.
			await expect(ok.locator('span[role="status"]')).toBeVisible();

			await password.getByLabel(ca.password.currentLabel).fill('not-the-password');
			await password.getByLabel(/^New password/).fill('Another-Pass-2026!');
			await password.getByLabel(ca.password.confirmLabel).fill('Another-Pass-2026!');
			await password.getByRole('button', { name: copy.common.save }).click();

			// Both at once: the second does not replace the first.
			const bad = page.locator('.toast.bad');
			await expect(bad).toHaveCount(1);
			await expect(bad.locator('span[role="alert"]')).toBeVisible();
			await expect(page.locator('.toast')).toHaveCount(2);

			// The success goes on its own clock. The refusal does not: it is the only
			// account of why the save did not happen.
			await expect(ok).toHaveCount(0, { timeout: 8000 });
			await expect(bad).toHaveCount(1);

			await bad.getByRole('button').click();
			await expect(page.locator('.toast')).toHaveCount(0);
		} finally {
			user.teardown();
		}
	});

	/**
	 * A failed load is now two things at once: the server's reason in the corner,
	 * where it does not expire, and a line left on the page so the screen is not
	 * blank. Driven on two unrelated pages, because the panel sits in a different
	 * layout on each.
	 */
	test('a page that cannot load says so on the page and why in the corner', async ({
		page,
		request
	}) => {
		const user = await registerUser(request);
		const reason = 'Could not reach the trips service.';
		try {
			await signIn(page, user.sessionCookie);

			for (const path of ['/account', '/trips']) {
				await page.route(
					(u) => u.pathname === `/api${path}`,
					(route) => route.fulfill({ status: 500, json: { error: reason } })
				);
				await page.goto(path);

				// The page keeps a statement of its own, and does not repeat the
				// server's sentence underneath it.
				await expect(page.getByText(copy.api.loadFailed)).toBeVisible();
				const bad = page.locator('.toast.bad').filter({ hasText: reason });
				await expect(bad).toHaveCount(1);
				await expect(bad.getByRole('alert')).toHaveText(reason);

				// Errors do not expire, so it is still there to be read.
				await page.waitForTimeout(6000);
				await expect(bad).toHaveCount(1);
				await bad.getByRole('button').click();
				await expect(page.locator('.toast')).toHaveCount(0);
				await page.unrouteAll();
			}
		} finally {
			user.teardown();
		}
	});
});
