import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiURL, createApiFixture, type ApiFixture } from './fixtures/api';

const KYOTO = {
	name: 'Kyoto',
	country: 'Japan',
	region: 'Kyoto Prefecture',
	tz: 'Asia/Tokyo',
	lat: 35.0116,
	lng: 135.7681
};

async function addCity(
	request: APIRequestContext,
	fixture: ApiFixture,
	city: Record<string, unknown>
) {
	return request.post(`${apiURL}/trips/${fixture.tripId}/cities`, {
		headers: { cookie: fixture.sessionCookie },
		data: city
	});
}

/** Signs the browser in as the fixture's user, so the trip pages load. */
async function signIn(page: Page, fixture: ApiFixture) {
	const value = fixture.sessionCookie.split('session=')[1]?.split(';')[0] ?? '';
	await page.context().addCookies([
		{ name: 'session', value, domain: 'localhost', path: '/' },
		{ name: 'session', value, domain: '127.0.0.1', path: '/' }
	]);
}

test.describe('a city cannot be added to a trip twice', () => {
	test('the API refuses the duplicate and says which city', async ({ request }) => {
		const fixture = await createApiFixture(request);
		try {
			expect((await addCity(request, fixture, KYOTO)).status()).toBe(201);

			const again = await addCity(request, fixture, KYOTO);
			expect(again.status()).toBe(400);
			await expect(again.json()).resolves.toEqual(
				expect.objectContaining({ error: 'Kyoto is already on this trip.' })
			);

			// Case and spacing are not a different city.
			const sloppy = await addCity(request, fixture, { ...KYOTO, name: '  kyoto', country: 'japan' });
			expect(sloppy.status()).toBe(400);

			// A same-named city in another region is, and must still be allowed.
			const nashvilleTn = await addCity(request, fixture, {
				name: 'Nashville',
				country: 'United States',
				region: 'Tennessee',
				tz: 'America/Chicago'
			});
			expect(nashvilleTn.status()).toBe(201);
			const nashvilleGa = await addCity(request, fixture, {
				name: 'Nashville',
				country: 'United States',
				region: 'Georgia',
				tz: 'America/New_York'
			});
			expect(nashvilleGa.status()).toBe(201);
		} finally {
			fixture.teardown();
		}
	});

	test('the add-city search marks one the trip already has and will not pick it', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			expect((await addCity(request, fixture, KYOTO)).status()).toBe(201);

			await signIn(page, fixture);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			await page.getByRole('button', { name: 'Add city' }).click();
			const dialog = page.getByRole('dialog');
			await expect(dialog).toBeVisible();

			await dialog.getByRole('combobox').fill('Kyoto');
			const row = dialog.getByRole('option').filter({ hasText: 'Kyoto' }).first();
			await expect(row).toBeVisible({ timeout: 15_000 });
			await expect(row).toContainText('Added');
			await expect(row).toHaveAttribute('aria-disabled', 'true');

			// A real click is dispatched (Playwright would otherwise refuse to touch
			// a disabled row), and it must still not pick anything: the dialog's Add
			// stays unavailable.
			await row.click({ force: true });
			await expect(dialog.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
		} finally {
			fixture.teardown();
		}
	});
});
