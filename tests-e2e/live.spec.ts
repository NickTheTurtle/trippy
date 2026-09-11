import { expect, test } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { addCity, addExpense, addTask, toggleTask } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn, signedInContext } from './fixtures/session';

/**
 * Live collaboration over the SSE stream. Each test opens a trip in one context
 * and makes the change from elsewhere (another authenticated session writing
 * through the API), then asserts the open page catches up on its own, with no
 * reload. The stream carries no rows: an event names a section and the page
 * reloads it, so the assertions are web-first and simply wait for the section
 * to reflect the write.
 *
 * There is no arbitrary timeout here. A web-first assertion retries until the
 * event arrives and the section reloads, which is exactly the signal we want;
 * a fixed sleep would either be flaky or slow.
 */

const cd = copy.discover;

test.describe('live collaboration', () => {
	test('an expense written by another session appears without a reload', async ({
		browser,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { context, page } = await signedInContext(browser, fixture.sessionCookie);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/expenses`);
			// The ledger starts empty, so the row that turns up is unambiguously the
			// one the other session just wrote.
			await expect(page.getByRole('listitem').filter({ hasText: 'Rooftop drinks' })).toHaveCount(0);

			await addExpense(request, fixture, fixture.tripId, {
				description: 'Rooftop drinks',
				amount: 40,
				payerId: fixture.userId,
				participantIds: [fixture.userId]
			});

			await expect(
				page.getByRole('listitem').filter({ hasText: 'Rooftop drinks' })
			).toBeVisible();
		} finally {
			await context.close();
			fixture.teardown();
		}
	});

	test('a city written by another session appears in the sidebar without a reload', async ({
		browser,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { context, page } = await signedInContext(browser, fixture.sessionCookie);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/discover`);
			const cities = page.getByRole('navigation', { name: cd.cityList.navLabel });

			await addCity(request, fixture, {
				name: 'Seville',
				country: 'Spain',
				region: 'Andalusia',
				tz: 'Europe/Madrid'
			});

			await expect(cities.getByText('Seville', { exact: true })).toBeVisible();
		} finally {
			await context.close();
			fixture.teardown();
		}
	});

	test('a task ticked by another session shows as done without a reload', async ({
		browser,
		request
	}) => {
		const fixture = await createApiFixture(request);
		// Seeded unticked, so the box the other session ticks is the state change.
		const taskId = await addTask(request, fixture, { label: 'Confirm the rental' });
		const { context, page } = await signedInContext(browser, fixture.sessionCookie);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/pretrip`);
			const box = page.getByRole('button', {
				name: copy.preparation.taskList.sharedBoxLabel(false, 'Confirm the rental')
			});
			await expect(box).toHaveAttribute('aria-pressed', 'false');

			// Another session marks it done through the API; the open page should
			// flip the same box without being reloaded.
			await toggleTask(request, fixture, fixture.tripId, taskId, true);

			await expect(
				page.getByRole('button', {
					name: copy.preparation.taskList.sharedBoxLabel(true, 'Confirm the rental')
				})
			).toHaveAttribute('aria-pressed', 'true');
		} finally {
			await context.close();
			fixture.teardown();
		}
	});

	test('closing one session does not break the other session live stream', async ({
		browser,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const a = await signedInContext(browser, fixture.sessionCookie);
		const b = await signedInContext(browser, fixture.sessionCookie);
		try {
			await a.page.goto(`/trips/${fixture.tripId}/expenses`);
			await b.page.goto(`/trips/${fixture.tripId}/expenses`);
			await expect(b.page.getByRole('listitem').filter({ hasText: 'Group taxi' })).toHaveCount(0);

			// One collaborator closes their tab. The other's stream must carry on.
			await a.context.close();

			await addExpense(request, fixture, fixture.tripId, {
				description: 'Group taxi',
				amount: 24,
				payerId: fixture.userId,
				participantIds: [fixture.userId]
			});

			await expect(
				b.page.getByRole('listitem').filter({ hasText: 'Group taxi' })
			).toBeVisible();
		} finally {
			await b.context.close();
			fixture.teardown();
		}
	});
});
