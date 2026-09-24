import { expect, test } from '@playwright/test';
import { createApiFixture, registerUser } from './fixtures/api';
import { addCity, addPlace, addStay, invite } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn, signedInContext } from './fixtures/session';

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

	test('a double tap on a vote counts once, and shows at once', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			const cityId = await addCity(request, fixture, LISBON);
			await addPlace(request, fixture, { cityId, name: 'Miradouro' });
			await signIn(page, fixture.sessionCookie);
			// Slow the vote down so the second tap lands while the first is still
			// on the wire, which is the case the guard exists for.
			let votes = 0;
			await page.route(/\/api\/trips\/[^/]+\/discover\/pois\/[^/]+\/vote$/, async (route) => {
				votes++;
				await new Promise((r) => setTimeout(r, 600));
				await route.continue();
			});
			await page.goto(`/trips/${fixture.tripId}/discover`);

			const pill = page.getByRole('button', {
				name: copy.discover.card.voteLabel(false, 'Miradouro')
			});
			await expect(pill).toContainText('0');
			await pill.dblclick();

			// Optimistic: the pill has flipped before the slowed request returns.
			const voted = page.getByRole('button', {
				name: copy.discover.card.voteLabel(true, 'Miradouro')
			});
			await expect(voted).toContainText('1', { timeout: 400 });
			await expect(voted).toHaveAttribute('aria-pressed', 'true');

			// And it stays there once the server has answered and the grid reloaded:
			// one request, not a toggle and its undo.
			await page.waitForTimeout(1200);
			await expect(voted).toContainText('1');
			expect(votes).toBe(1);
		} finally {
			fixture.teardown();
		}
	});

	test('the organizer locks a stay from its card, and a member only sees the lock', async ({
		page,
		browser,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const member = await registerUser(request, { name: 'Lodger' });
		await invite(request, fixture, member.email);
		const sc = copy.discover.stayCard;
		try {
			const cityId = await addCity(request, fixture, LISBON);
			await addStay(request, fixture, { cityId, name: 'Casa Azul', priceCents: 9000 });
			await addStay(request, fixture, { cityId, name: 'Hotel Rio', priceCents: 15000 });
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			const casa = page.locator('article').filter({ hasText: 'Casa Azul' });
			const rio = page.locator('article').filter({ hasText: 'Hotel Rio' });
			await casa.getByRole('button', { name: sc.lockLabel(false, 'Casa Azul') }).click();
			await expect(casa.getByText(sc.locked, { exact: true })).toBeVisible();

			// One lock per city: locking the other moves it rather than adding one.
			await rio.getByRole('button', { name: sc.lockLabel(false, 'Hotel Rio') }).click();
			await expect(rio.getByText(sc.locked, { exact: true })).toBeVisible();
			await expect(casa.getByText(sc.locked, { exact: true })).toHaveCount(0);

			// And it is a toggle: pressing it again releases the lock.
			await rio.getByRole('button', { name: sc.lockLabel(true, 'Hotel Rio') }).click();
			await expect(rio.getByText(sc.locked, { exact: true })).toHaveCount(0);
			await rio.getByRole('button', { name: sc.lockLabel(false, 'Hotel Rio') }).click();
			await expect(rio.getByText(sc.locked, { exact: true })).toBeVisible();

			// The member sees which stay is locked, and no control to change it.
			const other = await signedInContext(browser, member.sessionCookie);
			try {
				await other.page.goto(`/trips/${fixture.tripId}/discover`);
				const theirRio = other.page.locator('article').filter({ hasText: 'Hotel Rio' });
				await expect(theirRio.getByText(sc.locked, { exact: true })).toBeVisible();
				await expect(other.page.getByRole('button', { name: /^(Lock|Unlock) / })).toHaveCount(0);
			} finally {
				await other.context.close();
			}
		} finally {
			fixture.teardown();
			member.teardown();
		}
	});

	test('a stay delete the server refuses keeps the confirmation open', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			const cityId = await addCity(request, fixture, LISBON);
			await addStay(request, fixture, { cityId, name: 'Pensao Flor' });
			await signIn(page, fixture.sessionCookie);
			const reason = 'Could not delete that just now.';
			await page.route(/\/api\/trips\/[^/]+\/discover\/stays\/[^/]+$/, (route) =>
				route.request().method() === 'DELETE'
					? route.fulfill({ status: 500, json: { error: reason } })
					: route.continue()
			);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			await page.getByRole('button', { name: copy.common.editLabel('Pensao Flor') }).click();
			await page
				.getByRole('dialog')
				.getByRole('button', { name: copy.common.delete, exact: true })
				.click();
			const confirm = page.getByRole('dialog');
			await confirm.getByRole('button', { name: copy.common.delete, exact: true }).click();

			// Still asking, with the reason in the corner, and the stay still there.
			await expect(page.locator('.toast.bad').filter({ hasText: reason })).toBeVisible();
			await expect(confirm.getByText(copy.ui.confirmDialog.undone)).toBeVisible();

			// Cancelled and asked again, the old refusal is not waiting for it.
			await confirm.getByRole('button', { name: copy.common.cancel, exact: true }).click();
			await page
				.getByRole('dialog')
				.getByRole('button', { name: copy.common.delete, exact: true })
				.click();
			await expect(page.getByRole('dialog').getByText(copy.ui.confirmDialog.undone)).toBeVisible();
			await expect(page.locator('.toast.bad').filter({ hasText: reason })).toHaveCount(0);
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

	test('a stay can be booked onto the calendar from the schedule dialog', async ({
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

			await page.getByRole('button', { name: copy.common.deleteLabel('Porto') }).click();
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
