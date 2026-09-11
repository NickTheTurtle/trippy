import { expect, test } from '@playwright/test';
import { apiURL, createApiFixture, deleteUser, registerUser } from './fixtures/api';
import { copy } from './fixtures/copy';
import { logOut, signIn } from './fixtures/session';

/**
 * Auth and session. These drive the real login and register forms rather than
 * seeding a cookie, because the forms and their error handling are the thing
 * under test. The login-backoff spec lives at the very bottom and is driven
 * through `request`, not the UI, so it can control the timing exactly and never
 * strand the rest of the suite behind a live 2-second lockout.
 */

const uniqueEmail = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

test.describe('auth and session', () => {
	test('a new account can register, log out, and log back in', async ({ page, request }) => {
		const email = uniqueEmail();
		const password = 'correct horse battery';
		let userId = '';
		try {
			await page.goto('/register');
			await page.getByLabel(copy.auth.register.nameLabel).fill('Ada Traveller');
			await page.getByLabel(copy.auth.register.emailLabel).fill(email);
			await page.getByLabel(copy.auth.register.passwordLabel).fill(password);
			await page.getByRole('button', { name: copy.auth.register.submitLabel }).click();

			// Registration lands on the signed-in trips home.
			await expect(page.getByRole('heading', { level: 1, name: copy.trips.heading })).toBeVisible();

			// Resolve the id from the session we now hold, so teardown can clean up.
			const me = await page.request.get(`${apiURL}/auth/me`);
			userId = (await me.json()).user.id;

			await logOut(page);
			// Logged out returns to the landing page with its call to action.
			await expect(
				page.getByRole('link', { name: copy.shell.register }).first()
			).toBeVisible();

			await page.goto('/login');
			await page.getByLabel(copy.auth.login.emailLabel).fill(email);
			await page.getByLabel(copy.auth.login.passwordLabel).fill(password);
			await page.getByRole('button', { name: copy.auth.login.submitLabel }).click();
			await expect(page.getByRole('heading', { level: 1, name: copy.trips.heading })).toBeVisible();
		} finally {
			if (userId) deleteUser(userId);
		}
	});

	test('a signed-in session survives a full page reload', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto('/trips');
			await expect(page.getByRole('heading', { level: 1, name: copy.trips.heading })).toBeVisible();

			await page.reload();
			// Still on trips, not bounced to /login: the session check must not
			// redirect while it is still loading.
			await expect(page).toHaveURL(/\/trips$/);
			await expect(page.getByRole('heading', { level: 1, name: copy.trips.heading })).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('visiting a trip URL while signed out redirects to the login page', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			// No cookie set on this context: the guard should turn the deep link away.
			await page.goto(`/trips/${fixture.tripId}/expenses`);
			await expect(page).toHaveURL(/\/login$/);
			await expect(page.getByRole('button', { name: copy.auth.login.submitLabel })).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('a wrong password shows one generic message that does not reveal the email', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await page.goto('/login');
			await page.getByLabel(copy.auth.login.emailLabel).fill(fixture.email);
			await page.getByLabel(copy.auth.login.passwordLabel).fill('not-the-password');
			await page.getByRole('button', { name: copy.auth.login.submitLabel }).click();

			// The server sends "Wrong email or password" for both a bad password and
			// a missing account, so the message must never name which was wrong.
			const alert = page.getByRole('alert');
			await expect(alert).toBeVisible();
			await expect(alert).toHaveText('Wrong email or password.');
			await expect(alert).not.toContainText(fixture.email);
			// Still on the login page, not signed in.
			await expect(page).toHaveURL(/\/login$/);
		} finally {
			fixture.teardown();
		}
	});

	test('changing a password signs other devices out but keeps the current one', async ({
		browser,
		request
	}) => {
		// Two contexts are the "two devices". A changes the password; B, which was
		// signed in on the old session, must be rejected on its next call while A
		// keeps working, because a password change deletes only the other sessions.
		const user = await registerUser(request, { password: 'first-password-1' });
		const contextA = await browser.newContext();
		const contextB = await browser.newContext();
		try {
			for (const ctx of [contextA, contextB]) {
				const value = user.sessionCookie.split('session=')[1].split(';')[0];
				await ctx.addCookies([
					{ name: 'session', value, domain: 'localhost', path: '/' },
					{ name: 'session', value, domain: '127.0.0.1', path: '/' }
				]);
			}

			// Both sessions share one cookie here, so to make them genuinely separate
			// devices A logs in freshly to mint its own session, then changes the
			// password from that session.
			const pageA = await contextA.newPage();
			const loginA = await pageA.request.post(`${apiURL}/auth/login`, {
				data: { email: user.email, password: 'first-password-1' }
			});
			expect(loginA.status()).toBe(200);

			const changed = await pageA.request.post(`${apiURL}/account/password`, {
				data: {
					current: 'first-password-1',
					next: 'second-password-2',
					confirm: 'second-password-2'
				}
			});
			expect(changed.status(), await changed.text()).toBe(200);

			// A's own session still works.
			const meA = await pageA.request.get(`${apiURL}/auth/me`);
			expect(meA.status()).toBe(200);

			// B held the pre-change session, which has now been revoked.
			const pageB = await contextB.newPage();
			const meB = await pageB.request.get(`${apiURL}/auth/me`);
			expect(meB.status()).toBe(401);
		} finally {
			await contextA.close();
			await contextB.close();
			user.teardown();
		}
	});
});

test.describe('login backoff', () => {
	// Kept last and driven through `request`, never the UI: the throttle is per
	// email AND per IP and only failures count, so a run here would otherwise add
	// IP-keyed failures that could slow every later login. A throwaway email is
	// used, and the whole thing is one test so nothing runs after it.
	test('the attempt after the free five for one email is throttled with a 429', async ({
		request
	}) => {
		const email = uniqueEmail();
		// Register the account so only the password is ever wrong, isolating the
		// per-email failure counter from "no such account".
		const created = await request.post(`${apiURL}/auth/register`, {
			data: { email, name: 'Backoff Tester', password: 'the-real-password-9' }
		});
		expect(created.status()).toBe(201);
		const userId = (await created.json()).user.id;

		try {
			// Five attempts are free, and the sixth failure still returns 401 while
			// arming the backoff, so six wrong passwords are each answered 401.
			for (let attempt = 1; attempt <= 6; attempt++) {
				const res = await request.post(`${apiURL}/auth/login`, {
					data: { email, password: `wrong-${attempt}` }
				});
				expect(res.status(), `attempt ${attempt}`).toBe(401);
			}

			// The next attempt is refused before the password is even checked.
			const throttled = await request.post(`${apiURL}/auth/login`, {
				data: { email, password: 'wrong-7' }
			});
			expect(throttled.status()).toBe(429);
			expect(await throttled.json()).toEqual(
				expect.objectContaining({ error: 'Too many attempts. Try again in a moment.' })
			);
			// A Retry-After header tells the client how long to wait.
			expect(Number(throttled.headers()['retry-after'])).toBeGreaterThan(0);
		} finally {
			deleteUser(userId);
		}
	});
});
