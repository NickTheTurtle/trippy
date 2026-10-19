import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiURL, createApiFixture, readTrip, type ApiFixture } from './fixtures/api';
import { copy } from './fixtures/copy';

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
			const sloppy = await addCity(request, fixture, {
				...KYOTO,
				name: '  kyoto',
				country: 'japan'
			});
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
			// a disabled row), and it must still not pick anything: the dialog's
			// submit stays unavailable.
			await row.click({ force: true });
			await expect(
				dialog.getByRole('button', { name: copy.addCity.submit(0), exact: true })
			).toBeDisabled();
		} finally {
			fixture.teardown();
		}
	});
});

/** Answers every city search with the same fixed hits, so the picker is deterministic. */
async function stubCitySearch(page: Page, results: Record<string, unknown>[]) {
	await page.route('**/api/citysearch**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ results })
		})
	);
}

const LISBON = {
	name: 'Lisbon',
	country: 'Portugal',
	region: 'Lisbon',
	tz: 'Europe/Lisbon',
	lat: 38.7223,
	lng: -9.1393
};
const PORTO = {
	name: 'Porto',
	country: 'Portugal',
	region: 'Porto',
	tz: 'Europe/Lisbon',
	lat: 41.1579,
	lng: -8.6291
};
const OSAKA = {
	name: 'Osaka',
	country: 'Japan',
	region: 'Osaka Prefecture',
	tz: 'Asia/Tokyo',
	lat: 34.6937,
	lng: 135.5023
};

test.describe('several cities are added at once', () => {
	test('two picks become one request, and both land on the trip in pick order', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await stubCitySearch(page, [LISBON, PORTO]);
			await signIn(page, fixture);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			// A fresh trip has no cities, so Discover opens its first-run panel.
			await page.getByRole('button', { name: copy.discover.noCities.cta }).click();
			const dialog = page.getByRole('dialog', { name: copy.addCity.title });
			await expect(dialog).toBeVisible();
			const input = dialog.getByRole('combobox');
			const submit = (n: number) =>
				dialog.getByRole('button', { name: copy.addCity.submit(n), exact: true });
			await expect(submit(0)).toBeDisabled();

			// Porto first: the list keeps pick order, not the order of the results.
			await input.fill('Po');
			await dialog.getByRole('option').filter({ hasText: 'Porto' }).click();
			// The box is emptied and keeps focus, ready for the next city.
			await expect(input).toHaveValue('');
			await expect(input).toBeFocused();
			await expect(dialog.getByText(copy.addCity.pickedHeading(1))).toBeVisible();
			await expect(submit(1)).toBeEnabled();

			await input.pressSequentially('Li');
			await dialog.getByRole('option').filter({ hasText: 'Lisbon' }).click();
			await expect(dialog.getByText(copy.addCity.pickedHeading(2))).toBeVisible();

			// A city already in the list is shown, marked, and cannot be picked again.
			await input.fill('Po');
			const again = dialog.getByRole('option').filter({ hasText: 'Porto' });
			await expect(again).toContainText(copy.addCity.picked);
			await expect(again).toHaveAttribute('aria-disabled', 'true');
			await page.keyboard.press('Escape');
			await expect(dialog).toBeVisible();

			const posted = page.waitForRequest(
				(r) => r.method() === 'POST' && r.url().endsWith(`/trips/${fixture.tripId}/cities`)
			);
			await submit(2).click();
			const body = (await posted).postDataJSON() as { cities: { name: string }[] };
			expect(body.cities.map((c) => c.name)).toEqual(['Porto', 'Lisbon']);
			await expect(dialog).toBeHidden();

			const cities = page.getByRole('navigation', { name: copy.discover.cityList.navLabel });
			await expect(cities.getByText('Porto', { exact: true })).toBeVisible();
			await expect(cities.getByText('Lisbon', { exact: true })).toBeVisible();

			const trip = (await (await readTrip(request, fixture)).json()) as {
				trip: { cities: { name: string }[] };
			};
			expect(trip.trip.cities.map((c) => c.name)).toEqual(['Porto', 'Lisbon']);
		} finally {
			fixture.teardown();
		}
	});

	test('a refused city keeps the list, and removing it lets the rest through', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await stubCitySearch(page, [KYOTO, OSAKA]);
			await signIn(page, fixture);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			await page.getByRole('button', { name: copy.discover.noCities.cta }).click();
			const dialog = page.getByRole('dialog', { name: copy.addCity.title });
			const input = dialog.getByRole('combobox');

			await input.fill('Ky');
			await dialog.getByRole('option').filter({ hasText: 'Kyoto' }).click();
			await input.fill('Os');
			await dialog.getByRole('option').filter({ hasText: 'Osaka' }).click();

			// Someone else adds Kyoto while this dialog is open.
			expect((await addCity(request, fixture, KYOTO)).status()).toBe(201);

			await dialog.getByRole('button', { name: copy.addCity.submit(2), exact: true }).click();
			// The visible copy is the corner toast; the dialog also carries an
			// sr-only announcement of the same sentence (see trips.spec.ts).
			await expect(
				page.locator('.toast.bad').filter({ hasText: 'Kyoto is already on this trip.' })
			).toBeVisible();
			// All or nothing: the dialog and both picks are still there.
			await expect(dialog.getByText(copy.addCity.pickedHeading(2))).toBeVisible();

			await dialog.getByRole('button', { name: copy.addCity.remove('Kyoto') }).click();
			await expect(dialog.getByText(copy.addCity.pickedHeading(1))).toBeVisible();
			await dialog.getByRole('button', { name: copy.addCity.submit(1), exact: true }).click();
			await expect(dialog).toBeHidden();

			const trip = (await (await readTrip(request, fixture)).json()) as {
				trip: { cities: { name: string }[] };
			};
			expect(trip.trip.cities.map((c) => c.name)).toEqual(['Kyoto', 'Osaka']);
		} finally {
			fixture.teardown();
		}
	});
});
