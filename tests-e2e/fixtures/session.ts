import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { sessionValue } from './api';
import { copy } from './copy';

/**
 * Puts the app's session cookie on a page's context so trip pages load.
 *
 * The cookie is set for both `localhost` and `127.0.0.1`: the baseURL is
 * `localhost`, but the API server and the Vite host bind `127.0.0.1`, and a
 * spec that navigates to either host must arrive signed in. This is the same
 * shape the duplicate-city spec uses, kept in one place now.
 */
export async function signIn(page: Page, sessionCookie: string): Promise<void> {
	await addSessionCookie(page.context(), sessionCookie);
}

/**
 * A second signed-in browser context, for the collaboration and concurrency
 * specs. Two contexts are two people: they do not share cookies or storage, so
 * a change one makes reaches the other only through the API and the SSE stream,
 * which is the whole point of testing them apart.
 */
export async function signedInContext(
	browser: Browser,
	sessionCookie: string
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext();
	await addSessionCookie(context, sessionCookie);
	const page = await context.newPage();
	return { context, page };
}

async function addSessionCookie(context: BrowserContext, sessionCookie: string): Promise<void> {
	const value = sessionValue(sessionCookie);
	await context.addCookies([
		{ name: 'session', value, domain: 'localhost', path: '/' },
		{ name: 'session', value, domain: '127.0.0.1', path: '/' }
	]);
}

/**
 * Logs out through the account menu, the only path a real user has.
 *
 * The menu trigger has no stable text (it shows the signed-in name), so it is
 * reached as the header's one disclosure button, by its `aria-expanded`. The
 * panel it opens holds ordinary controls, not ARIA menu items, so Log out is
 * found as a button.
 */
export async function logOut(page: Page): Promise<void> {
	await page.locator('header button[aria-expanded]').click();
	await page.getByRole('button', { name: copy.shell.logOut }).click();
}
