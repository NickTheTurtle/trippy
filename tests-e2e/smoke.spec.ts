import { expect, test } from '@playwright/test';
import { apiURL, createApiFixture, readTrip } from './fixtures/api';

test('web and api smoke', async ({ page, request }) => {
	await page.goto('/');
	const title = await page.title();
	expect(title.trim().length).toBeGreaterThan(0);

	const health = await request.get(`${apiURL}/health`);
	expect(health.status()).toBe(200);
	await expect(health.json()).resolves.toEqual(expect.objectContaining({ ok: true }));

	const fixture = await createApiFixture(request);
	try {
		const trip = await readTrip(request, fixture);
		expect(trip.status()).toBe(200);
		await expect(trip.json()).resolves.toEqual({
			trip: expect.objectContaining({
				id: fixture.tripId,
				name: fixture.tripBody.name,
				start_date: fixture.tripBody.startDate,
				end_date: fixture.tripBody.endDate,
				home_currency: fixture.tripBody.homeCurrency
			})
		});
	} finally {
		fixture.teardown();
	}
});
