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

			await expect(profile.getByText(ca.profile.saved)).toBeVisible();

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
});
