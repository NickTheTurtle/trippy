import { expect, test } from '@playwright/test';
import { registerUser } from './fixtures/api';
import { copy } from './fixtures/copy';

/**
 * Forgetting a password.
 *
 * The link itself cannot be followed here, because this deployment has no mail
 * provider and the suite has no inbox to read. What is checked is everything
 * either side of that: the page is reachable from log in, it answers the same
 * way for an address with an account and one without, and the reset page
 * refuses a link that is not one.
 */

const c = copy.auth.forgot;

test.describe('forgot password', () => {
	test('log in offers the link, and the form answers the same for any address', async ({
		page,
		request
	}) => {
		const user = await registerUser(request, { name: 'Forgetful' });
		try {
			await page.goto('/login');
			await page.getByRole('link', { name: c.link }).click();
			await expect(page).toHaveURL(/\/forgot$/);

			await page.getByLabel(c.emailLabel).fill(user.email);
			await page.getByRole('button', { name: c.submitLabel }).click();
			await expect(page.getByRole('heading', { name: c.sentTitle })).toBeVisible();
			await expect(page.getByText(c.sentBlurb)).toBeVisible();

			// The same answer for an address nobody owns. Anything else would turn
			// this form into a way to ask whether a given person has an account.
			await page.goto('/forgot');
			await page.getByLabel(c.emailLabel).fill('nobody-at-all@example.test');
			await page.getByRole('button', { name: c.submitLabel }).click();
			await expect(page.getByRole('heading', { name: c.sentTitle })).toBeVisible();
		} finally {
			user.teardown();
		}
	});

	test('a reset page with no token sends you back to ask for one', async ({ page }) => {
		await page.goto('/reset');
		await expect(page).toHaveURL(/\/forgot$/);
	});

	test('a reset link that is not one is refused, and the form is kept', async ({ page }) => {
		const r = copy.auth.reset;
		await page.goto('/reset?token=not-a-real-token');
		await page.getByLabel(r.passwordLabel).fill('correcthorsebattery');
		await page.getByRole('button', { name: r.submitLabel }).click();

		// Still on the form with the refusal beside it: the page has no way to
		// tell a wrong link from a spent or stale one, and says so once.
		await expect(page.getByText('That link is no longer valid. Ask for a new one.')).toBeVisible();
		await expect(page.getByRole('heading', { name: r.title })).toBeVisible();
	});

	test('a short password is refused before the link is spent', async ({ page }) => {
		const r = copy.auth.reset;
		await page.goto('/reset?token=not-a-real-token');
		await page.getByLabel(r.passwordLabel).fill('short');
		await page.getByRole('button', { name: r.submitLabel }).click();
		await expect(page.getByText('Use at least 8 characters.')).toBeVisible();
	});
});
