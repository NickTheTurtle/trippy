import { expect, test } from '@playwright/test';
import { apiURL, createApiFixture } from './fixtures/api';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

/**
 * The schedule lock, from the organizer's side.
 *
 * The server refusal is covered by the API tests. What is worth a browser is
 * the shape of the page after the switch goes on: the board is still readable,
 * and every way into an edit has gone rather than staying put and failing on
 * save.
 */
test.describe('schedule lock', () => {
	test('freezes the board and thaws it again', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		const created = await request.post(`${apiURL}/trips/${fixture.tripId}/schedule/events`, {
			headers: { cookie: fixture.sessionCookie },
			data: { day, start: 600, end: 660, type: 'activity', title: 'Museum' }
		});
		expect(created.status()).toBe(201);

		await signIn(page, fixture.sessionCookie);
		await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);
		const add = page.getByRole('button', { name: copy.schedule.add, exact: true });
		await expect(add).toBeVisible();

		await lock(page, true);
		await expect(page.getByText(copy.schedule.lock.tag)).toBeVisible();
		await expect(add).toHaveCount(0);
		await expect(page.locator('.bedit')).toHaveCount(0);
		await expect(page.locator('.bresize')).toHaveCount(0);
		// The plan is still there to be read. That is the point of locking it.
		await expect(page.getByText('Museum')).toBeVisible();

		await lock(page, false);
		await expect(page.getByText(copy.schedule.lock.tag)).toHaveCount(0);
		await expect(add).toBeVisible();
		await expect(page.locator('.bedit')).toHaveCount(1);

		fixture.teardown();
	});
});

async function lock(page: import('@playwright/test').Page, on: boolean): Promise<void> {
	await page.getByRole('button', { name: copy.tripShell.editTrip }).click();
	const box = page.getByLabel(copy.tripShell.editDialog.lockLabel);
	if (on) await box.check();
	else await box.uncheck();
	await page.getByRole('button', { name: copy.common.save, exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
}
