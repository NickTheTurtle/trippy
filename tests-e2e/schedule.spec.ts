import { expect, test } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { seedMembers } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

/**
 * The schedule toolbar: the two controls that decide which board you are
 * looking at. Both are bounded, and the bounds are the point of the tests.
 */

test.describe('schedule toolbar', () => {
	test('day navigation stops at the ends of the trip', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const { startDate, endDate } = fixture.tripBody;
		try {
			await signIn(page, fixture.sessionCookie);

			const prev = page.getByRole('button', { name: 'Previous day' });
			const next = page.getByRole('button', { name: 'Next day' });
			const prevLink = page.getByRole('link', { name: 'Previous day' });
			const nextLink = page.getByRole('link', { name: 'Next day' });

			// First day: there is nothing before it, and the arrow says so rather
			// than walking into days the trip does not have.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);
			await expect(prev).toBeDisabled();
			await expect(nextLink).toBeVisible();

			// Middle day: both ways are open.
			await nextLink.click();
			await expect(prevLink).toBeVisible();
			await expect(nextLink).toBeVisible();

			// Last day.
			await nextLink.click();
			await expect(prevLink).toBeVisible();
			await expect(next).toBeDisabled();

			// A day typed past the end lands on the last day the trip offers, not on
			// an empty board with no way back.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=2030-01-01&view=day`);
			await expect(next).toBeDisabled();
			await expect(prevLink).toBeVisible();

			await page.goto(`/trips/${fixture.tripId}/schedule?day=1999-01-01&view=day`);
			await expect(prev).toBeDisabled();

			// The 3-day view is a window, and this trip is exactly three days long,
			// so its one anchor is pinned at both ends.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${endDate}&view=3day`);
			await expect(prev).toBeDisabled();
			await expect(next).toBeDisabled();
		} finally {
			fixture.teardown();
		}
	});

	test('"view as" offers the whole trip or one person, and nothing in between', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await seedMembers(request, fixture, ['Ada', 'Bo']);
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule`);

			const control = page.getByRole('button', { name: 'View the schedule as' });
			await expect(control).toHaveText(copy.viewAs.everyone);

			await control.click();
			const options = page.getByRole('option');
			// Everyone plus the three members, and no way to tick several at once:
			// picking closes the menu on one value.
			await expect(options).toHaveCount(4);
			await expect(options.first()).toHaveText(copy.viewAs.everyone);

			await page.getByRole('option', { name: 'Ada', exact: true }).click();
			await expect(options).toHaveCount(0);
			await expect(control).toHaveText('Ada');
		} finally {
			fixture.teardown();
		}
	});
});
