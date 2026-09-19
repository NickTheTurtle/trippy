import { expect, test } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { addCity, addPlace, addStay, apiSend } from './fixtures/seed';
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

			// The card opens its own dialog and the delete lives in that dialog's
			// footer, behind the house confirmation.
			await page.getByRole('button', { name: 'Oceanario', exact: true }).click();
			await page
				.getByRole('dialog')
				.getByRole('button', { name: copy.common.delete, exact: true })
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

	test('a place scheduled on the calendar is marked as such on its card', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			const cityId = await addCity(request, fixture, LISBON);
			const poiId = await addPlace(request, fixture, { cityId, name: 'Oceanario' });
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			// Nothing is scheduled yet, so the corner of the card is empty.
			const mark = page.getByText(copy.discover.card.onCalendar(1), { exact: true });
			await expect(page.getByRole('button', { name: 'Oceanario', exact: true })).toBeVisible();
			await expect(mark).toHaveCount(0);

			// Scheduled through the API: the point here is what the card says about
			// it afterwards, not the dialog that puts it there.
			const res = await apiSend(
				request,
				fixture,
				'POST',
				`/trips/${fixture.tripId}/schedule/events`,
				{
					day: fixture.tripBody.startDate,
					title: 'Oceanario',
					type: 'activity',
					start: 10 * 60,
					duration: 90,
					cityId,
					poiId
				}
			);
			expect(res.status(), await res.text()).toBe(201);

			await page.reload();
			// The count is the mark's name, because the mark itself is a drawing.
			await expect(mark).toHaveCount(1);
		} finally {
			fixture.teardown();
		}
	});

	test('a stay booked onto the calendar is marked as such on its card', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			const cityId = await addCity(request, fixture, LISBON);
			await addStay(request, fixture, { cityId, name: 'Alfama rooms' });
			await signIn(page, fixture.sessionCookie);

			// Booked through the dialog, because the picker offering the trip's
			// proposed stays rather than its saved places is the thing under test.
			await page.goto(
				`/trips/${fixture.tripId}/schedule?day=${fixture.tripBody.startDate}&view=day`
			);
			await page.getByRole('button', { name: '+ Add stay' }).click();
			const dialog = page.getByRole('dialog');
			// The block takes its name from the stay it is booked into, so picking
			// one is all there is to say.
			await dialog.getByRole('combobox', { name: 'Stay' }).click();
			await page.getByRole('option', { name: /Alfama rooms/ }).click();
			await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();
			await expect(
				page.getByRole('button', { name: /Alfama rooms\. Show on the map/ })
			).toBeVisible();

			await page.goto(`/trips/${fixture.tripId}/discover`);
			await expect(page.getByText(copy.discover.card.onCalendar(1), { exact: true })).toHaveCount(
				1
			);
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

			await page.getByRole('button', { name: copy.discover.cityList.removeLabel('Porto') }).click();
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
