import { expect, test } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { addCity, addPlace, addStay } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

/**
 * Discover: cities, places and stays. Cities and places are seeded through the
 * API where the point is a later edit or delete, and driven through the UI
 * where the flow itself (adding by hand, voting) is what is under test.
 */

const LISBON = { name: 'Lisbon', country: 'Portugal', region: 'Lisboa', tz: 'Europe/Lisbon' };

test.describe('discover', () => {
	test('a city with nothing in it shows the shared empty state', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			await addCity(request, fixture, LISBON);
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			// No full stop and no action button, the same shape every add-to list uses.
			await expect(page.getByText(copy.common.nothingAdded, { exact: true })).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('a place added by hand appears on its city', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			await addCity(request, fixture, LISBON);
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			await page.getByRole('button', { name: copy.discover.header.add, exact: true }).click();
			const dialog = page.getByRole('dialog');
			await expect(
				dialog.getByRole('heading', { name: copy.discover.addDialog.title })
			).toBeVisible();

			// The Name field is a combobox that doubles as a provider search. Typing
			// and submitting straight away keeps a place typed by hand, which is the
			// path being tested here (no provider result is picked).
			await dialog.getByRole('combobox').fill('Torre de Belem');
			await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();

			await expect(dialog).toBeHidden();
			await expect(page.getByRole('button', { name: 'Torre de Belem', exact: true })).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('a place can be renamed from its edit dialog', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			const cityId = await addCity(request, fixture, LISBON);
			await addPlace(request, fixture, { cityId, name: 'Jeronimos Monastery' });
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			// The card cover, title and meta are one button, and clicking it edits.
			await page.getByRole('button', { name: 'Jeronimos Monastery', exact: true }).click();
			const dialog = page.getByRole('dialog');
			await expect(
				dialog.getByRole('heading', { name: copy.discover.editPlace.title })
			).toBeVisible();
			await dialog.getByLabel(copy.discover.editPlace.nameLabel).fill('Jeronimos');
			await dialog.getByRole('button', { name: copy.common.save }).click();

			await expect(dialog).toBeHidden();
			await expect(page.getByRole('button', { name: 'Jeronimos', exact: true })).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('a place can be deleted after confirming, leaving the city empty', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			const cityId = await addCity(request, fixture, LISBON);
			await addPlace(request, fixture, { cityId, name: 'Oceanario' });
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			await page
				.getByRole('button', { name: copy.discover.placeCard.removeLabel('Oceanario') })
				.click();
			const confirm = page.getByRole('dialog');
			// The house wording, and a confirm button that repeats the bare verb.
			await expect(confirm.getByText(copy.ui.confirmDialog.undone)).toBeVisible();
			await confirm.getByRole('button', { name: copy.common.delete, exact: true }).click();

			await expect(page.getByRole('button', { name: 'Oceanario', exact: true })).toBeHidden();
			await expect(page.getByText(copy.common.nothingAdded, { exact: true })).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('a member voting on a stay moves its count from zero to one', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			const cityId = await addCity(request, fixture, LISBON);
			// The stay is seeded; the vote is the thing under test.
			await addStay(request, fixture, { cityId, name: 'Hotel Avenida', priceCents: 12000 });
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			// Switch the header view to Stays so the seeded stay is on screen.
			await page.getByRole('button', { name: copy.discover.header.typeAriaLabel }).click();
			await page.getByRole('option', { name: copy.discover.types.stay }).click();

			// Not yet voted: the pill offers to vote, and reads zero.
			const votePill = page.getByRole('button', {
				name: copy.discover.card.voteLabel(false, 'Hotel Avenida')
			});
			await expect(votePill).toContainText('0');
			await votePill.click();

			// After voting the pill flips to the remove-vote label and reads one.
			const voted = page.getByRole('button', {
				name: copy.discover.card.voteLabel(true, 'Hotel Avenida')
			});
			await expect(voted).toContainText('1');
			await expect(voted).toHaveAttribute('aria-pressed', 'true');
		} finally {
			fixture.teardown();
		}
	});

	test('deleting a city asks for confirmation and removes it from the sidebar', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			// Two cities, because the last one cannot be removed by design.
			await addCity(request, fixture, LISBON);
			await addCity(request, fixture, {
				name: 'Porto',
				country: 'Portugal',
				region: 'Porto',
				tz: 'Europe/Lisbon'
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			await page
				.getByRole('button', { name: copy.discover.cityList.removeLabel('Porto') })
				.click();
			const confirm = page.getByRole('dialog');
			await expect(confirm.getByText(copy.ui.confirmDialog.undone)).toBeVisible();
			await confirm.getByRole('button', { name: copy.common.delete, exact: true }).click();

			// Gone from the city navigation, Lisbon still there.
			const cities = page.getByRole('navigation', { name: copy.discover.cityList.navLabel });
			await expect(cities.getByText('Porto', { exact: true })).toBeHidden();
			await expect(cities.getByText('Lisbon', { exact: true })).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});
});
