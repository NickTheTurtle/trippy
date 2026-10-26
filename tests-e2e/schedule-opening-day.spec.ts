import { expect, test } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { signIn } from './fixtures/session';
import { copy } from './fixtures/copy';

test('the schedule opens on today first, then on the day last viewed', async ({
	page,
	request
}) => {
	const fixture = await createApiFixture(request);
	try {
		await page.clock.setFixedTime(new Date(2027, 1, 11, 12));
		await signIn(page, fixture.sessionCookie);
		await page.goto(`/trips/${fixture.tripId}/schedule`);
		await expect(page).toHaveURL(/day=2027-02-11&view=day/);
		await expect(page.locator('.sched .boardhead .curday')).toContainText('Feb 11');

		await page.getByRole('link', { name: copy.schedule.nav.nextDay }).click();
		await expect(page).toHaveURL(/day=2027-02-12/);
		await page.getByRole('link', { name: copy.nav.discover }).click();
		await page.getByRole('link', { name: copy.nav.schedule }).click();
		await expect(page).toHaveURL(/day=2027-02-12&view=day/);
		await expect(page.locator('.sched .boardhead .curday')).toContainText('Feb 12');

		await page.goto(`/trips/${fixture.tripId}/schedule?day=2027-02-10&view=day`);
		await expect(page.locator('.sched .boardhead .curday')).toContainText('Feb 10');
	} finally {
		fixture.teardown();
	}
});
