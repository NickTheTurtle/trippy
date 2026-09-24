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
			// A different address asks for the current password, and only then.
			await profile.getByLabel(ca.profile.currentPasswordLabel).fill(user.password);
			// The home zone is a typeahead over the IANA list: typed, then picked.
			const zone = profile.getByRole('combobox', { name: ca.profile.timeZoneAriaLabel });
			await zone.click();
			await zone.fill('new york');
			await page.getByRole('option', { name: 'America/New York', exact: true }).click();
			await profile.getByRole('button', { name: copy.common.save }).click();

			// The confirmation is a corner toast, so it is on the page rather than in
			// the card: the save outlives the form, which remounts on a new email.
			// With no mail provider (this suite has none) the address applies at once.
			await expect(page.locator('.toast.ok').filter({ hasText: ca.profile.saved })).toBeVisible();

			// A reload reseeds the fields from what was stored, so surviving it is the
			// proof the change persisted rather than lingering in form state.
			await page.reload();
			await expect(profile.getByLabel(ca.profile.nameLabel)).toHaveValue('Nova Traveler');
			await expect(profile.getByLabel(ca.profile.emailLabel)).toHaveValue(newEmail);
			await expect(zone).toHaveValue('America/New York');
			// Back to the address on file, so no password is being asked for.
			await expect(profile.getByLabel(ca.profile.currentPasswordLabel)).toHaveCount(0);

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

	test('an email change asks for the password, and one waiting on its link says where it went', async ({
		page,
		request
	}) => {
		const user = await registerUser(request);
		const pending = `waiting-${randomUUID()}@example.test`;
		try {
			await signIn(page, user.sessionCookie);
			await page.goto('/account');
			const profile = page
				.locator('section')
				.filter({ has: page.getByRole('heading', { name: ca.profile.heading }) });

			// Only a changed address asks for a password.
			await expect(profile.getByLabel(ca.profile.currentPasswordLabel)).toHaveCount(0);
			await profile.getByLabel(ca.profile.emailLabel).fill(pending);
			const password = profile.getByLabel(ca.profile.currentPasswordLabel);
			await expect(password).toBeVisible();

			// The wrong one is refused by the server and nothing changes.
			await password.fill('not-my-password');
			await profile.getByRole('button', { name: copy.common.save }).click();
			await expect(page.locator('.toast.bad')).toBeVisible();
			const unchanged = await (await page.request.get(`${apiURL}/account`)).json();
			expect(unchanged.profile.email).toBe(user.email);

			// With a mail provider the server answers 202 and changes nothing until
			// the link is opened. This suite has no provider, so that answer is
			// stood in for here: the form's half of the contract is what is tested.
			await page.route(
				(u) => u.pathname === '/api/account/profile',
				(route) => route.fulfill({ status: 202, json: { ok: true, pendingEmail: pending } })
			);
			await page.route(
				(u) => u.pathname === '/api/account',
				async (route) => {
					const res = await route.fetch();
					const body = await res.json();
					body.profile.pendingEmail = pending;
					await route.fulfill({ response: res, json: body });
				}
			);
			await password.fill(user.password);
			await profile.getByRole('button', { name: copy.common.save }).click();

			await expect(profile.getByRole('status')).toHaveText(ca.profile.emailPending(pending));
			// The field is back on the address that still signs in.
			await expect(profile.getByLabel(ca.profile.emailLabel)).toHaveValue(user.email);
			await expect(profile.getByLabel(ca.profile.currentPasswordLabel)).toHaveCount(0);
			await expect(page.locator('.toast.ok')).toHaveCount(0);
		} finally {
			user.teardown();
		}
	});

	test('an email link that is not one says so, and offers the way on', async ({ page }) => {
		const v = copy.auth.verifyEmail;
		await page.goto('/verify-email?token=not-a-real-token');
		await expect(page.getByRole('heading', { name: v.failedTitle })).toBeVisible();
		await expect(page.getByText('That link is no longer valid. Ask for a new one.')).toBeVisible();
		await expect(page.getByRole('link', { name: copy.shell.logIn }).last()).toBeVisible();
		await expect(page).toHaveTitle(`${v.failedTitle} - ${copy.shell.brand}`);
	});

	/**
	 * The corner popups, driven from the one page that can raise both tones a few
	 * seconds apart: the profile save succeeds and the password save is refused.
	 */
	test('results stack in the corner, an error outlives a success and then goes too', async ({
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

			// The success goes on its own clock. The refusal is still there well
			// after it: an error is the only account of why the save did not happen,
			// so it is given time to be found and read.
			await expect(ok).toHaveCount(0, { timeout: 8000 });
			await expect(bad).toHaveCount(1);

			// It can be taken away by hand.
			await bad.getByRole('button').click();
			await expect(page.locator('.toast')).toHaveCount(0);

			// And it goes on its own if it is left alone, which is the half that
			// used to be missing: a refusal that had been read and acted on stayed
			// in the corner until somebody aimed at its button.
			await password.getByRole('button', { name: copy.common.save }).click();
			await expect(bad).toHaveCount(1);
			await expect(bad).toHaveCount(0, { timeout: 16000 });
		} finally {
			user.teardown();
		}
	});

	/**
	 * A failed load is now two things at once: the server's reason in the corner,
	 * which is given time to be read, and a line left on the page so the screen is
	 * not blank once that sentence has gone. Driven on two unrelated pages,
	 * because the panel sits in a different layout on each.
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

				// Long enough to be read, so it is still there six seconds later.
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
