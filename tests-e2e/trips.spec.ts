import { expect, test } from '@playwright/test';
import { apiURL, createApiFixture, registerUser } from './fixtures/api';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

/**
 * Trips: the list, and creating, renaming and deleting one. Creation runs
 * through the real dialog because the date rules it surfaces are the point;
 * rename and delete start from a seeded trip and drive the header controls.
 */

/**
 * The form's own refusal of an over-long range. Written out rather than read
 * from `copy` because the string is still awaiting clearance into
 * `@trippy/copy`; it moves to `copy.tripForm.tooLong` once it lands there.
 */
const TOO_LONG = 'A trip can run for at most a year.';

test.describe('trips', () => {
	test('the empty trips list shows the shared graphic and no action button', async ({
		page,
		request
	}) => {
		// A brand new account with no trips at all.
		const user = await registerUser(request);
		try {
			await signIn(page, user.sessionCookie);
			await page.goto('/trips');

			// The empty state states the emptiness with the house wording and carries
			// no call to action of its own: the only way to add is the header button,
			// which is always present.
			await expect(page.getByText(copy.common.nothingAdded, { exact: true })).toBeVisible();
			await expect(page.getByRole('button', { name: copy.common.add })).toHaveCount(1);
		} finally {
			user.teardown();
		}
	});

	test('a trip can be created through the add dialog and opens to its own page', async ({
		page,
		request
	}) => {
		const user = await registerUser(request);
		try {
			await signIn(page, user.sessionCookie);
			await page.goto('/trips');

			await page.getByRole('button', { name: copy.common.add }).click();
			const dialog = page.getByRole('dialog');
			await expect(dialog.getByRole('heading', { name: copy.trips.newDialog.title })).toBeVisible();

			await dialog.getByLabel(copy.tripForm.nameLabel).fill('Autumn in Kyoto');
			await dialog.getByLabel(copy.tripForm.startLabel).fill('2027-10-01');
			await dialog.getByLabel(copy.tripForm.endLabel).fill('2027-10-08');
			await dialog.getByRole('button', { name: copy.common.add }).click();

			// Creation navigates straight into the new trip, whose header carries the
			// name as the page's single h1.
			await expect(page).toHaveURL(/\/trips\/[^/]+\/discover$/);
			await expect(page.getByRole('heading', { level: 1, name: 'Autumn in Kyoto' })).toBeVisible();
		} finally {
			user.teardown();
		}
	});

	test('a trip cannot be created without both dates, and each end is named', async ({
		page,
		request
	}) => {
		const user = await registerUser(request);
		try {
			await signIn(page, user.sessionCookie);
			await page.goto('/trips');

			await page.getByRole('button', { name: copy.common.add }).click();
			const dialog = page.getByRole('dialog');
			await dialog.getByLabel(copy.tripForm.nameLabel).fill('No dates yet');

			// Native validation is off on purpose so the server's own wording is what
			// the user sees. These two sentences are server-authored (not in copy),
			// so they are asserted literally here. Each reads in the corner and is
			// announced from inside the dialog, which is the only part of the
			// document an open modal leaves non-inert.
			await dialog.getByRole('button', { name: copy.common.add }).click();
			await expect(
				page.locator('.toast.bad').filter({ hasText: 'Pick a start date.' })
			).toBeVisible();
			await expect(dialog.getByRole('alert')).toHaveText('Pick a start date.');
			await expect(dialog).toBeVisible();

			await dialog.getByLabel(copy.tripForm.startLabel).fill('2027-10-01');
			await dialog.getByRole('button', { name: copy.common.add }).click();
			await expect(
				page.locator('.toast.bad').filter({ hasText: 'Pick an end date.' })
			).toBeVisible();
			await expect(dialog.getByRole('alert')).toHaveText('Pick an end date.');
			await expect(dialog).toBeVisible();
		} finally {
			user.teardown();
		}
	});

	test('a refused save is readable once and spoken once', async ({ page, request }) => {
		const user = await registerUser(request);
		try {
			await signIn(page, user.sessionCookie);
			await page.goto('/trips');

			await page.getByRole('button', { name: copy.common.add }).click();
			const dialog = page.getByRole('dialog');
			await dialog.getByLabel(copy.tripForm.nameLabel).fill('No dates yet');
			await dialog.getByRole('button', { name: copy.common.add }).click();

			const reason = 'Pick a start date.';
			await expect(page.locator('.toast.bad').filter({ hasText: reason })).toBeVisible();

			// Testers driving the page by its text read this sentence twice and
			// filed it as a duplicate. It is on the page twice on purpose, but only
			// one of the two is drawn: `showModal()` makes the rest of the document
			// inert, and inertness takes the corner toast out of the accessibility
			// tree, so a dialog that only toasted would say nothing to a screen
			// reader. The second copy is the announcement, and it is `sr-only`.
			//
			// So the rule is about what is *visible*, not what is present. Exactly
			// one copy of the sentence can be seen anywhere on the page.
			const drawn = await page
				.getByText(reason, { exact: true })
				.evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().width > 1).length);
			expect(drawn).toBe(1);

			// And the one that cannot be seen is the one inside the dialog.
			const spoken = dialog.getByRole('alert');
			await expect(spoken).toHaveText(reason);
			await expect(spoken).not.toBeInViewport();

			// The footer draws no line of its own, so the buttons do not reflow
			// under a hand already moving towards them.
			await expect(dialog.locator('.mfoot p:not(.sr-only)')).toHaveCount(0);
		} finally {
			user.teardown();
		}
	});

	test('a trip longer than a year is refused by the form, before any request', async ({
		page,
		request
	}) => {
		const user = await registerUser(request);
		try {
			await signIn(page, user.sessionCookie);
			await page.goto('/trips');

			await page.getByRole('button', { name: copy.common.add }).click();
			const dialog = page.getByRole('dialog');
			await dialog.getByLabel(copy.tripForm.nameLabel).fill('The long way round');
			// Two years, which is what produced a schedule of four hundred day
			// columns and no way to reach the middle of them.
			await dialog.getByLabel(copy.tripForm.startLabel).fill('2027-01-01');
			await dialog.getByLabel(copy.tripForm.endLabel).fill('2029-01-01');
			await dialog.getByRole('button', { name: copy.common.add }).click();

			// The form says so itself; the dialog stays open on the range to fix.
			await expect(dialog.getByRole('alert')).toHaveText(TOO_LONG);
			await expect(dialog).toBeVisible();
			await expect(page).toHaveURL(/\/trips$/);

			// A year exactly is fine, and lands.
			await dialog.getByLabel(copy.tripForm.endLabel).fill('2027-12-01');
			await dialog.getByRole('button', { name: copy.common.add }).click();
			await expect(page).toHaveURL(/\/trips\/[^/]+\/discover$/);
		} finally {
			user.teardown();
		}
	});

	test('an organizer can rename a trip from the edit dialog', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/discover`);
			await expect(
				page.getByRole('heading', { level: 1, name: fixture.tripBody.name })
			).toBeVisible();

			await page.getByRole('button', { name: copy.tripShell.editTrip }).click();
			const dialog = page.getByRole('dialog');
			await dialog.getByLabel(copy.tripForm.nameLabel).fill('Renamed Trip');
			await dialog.getByRole('button', { name: copy.common.save }).click();

			await expect(page.getByRole('heading', { level: 1, name: 'Renamed Trip' })).toBeVisible();
			// The rename really persisted, not just re-rendered from local state.
			const trip = await page.request.get(`${apiURL}/trips/${fixture.tripId}`);
			expect((await trip.json()).trip.name).toBe('Renamed Trip');
		} finally {
			fixture.teardown();
		}
	});

	test('an organizer can delete a trip after confirming', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			await page.getByRole('button', { name: copy.tripShell.editTrip }).click();
			// Delete is reached from inside the edit dialog, which closes to make way
			// for a single confirmation rather than stacking two modals.
			await page.getByRole('dialog').getByRole('button', { name: copy.common.delete }).click();

			const confirm = page.getByRole('dialog');
			await expect(confirm.getByText(copy.ui.confirmDialog.undone)).toBeVisible();
			await confirm.getByRole('button', { name: copy.common.delete, exact: true }).click();

			// The trip is gone: back on the list, and the API no longer serves it.
			await expect(page).toHaveURL(/\/trips$/);
			const gone = await page.request.get(`${apiURL}/trips/${fixture.tripId}`);
			expect(gone.status()).toBe(404);
		} finally {
			fixture.teardown();
		}
	});
});
