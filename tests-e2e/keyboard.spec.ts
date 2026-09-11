import { expect, test } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { seedMembers, addExpense } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

/**
 * Keyboard and accessibility for the three custom widgets, which are not native
 * form controls and so have to put back by hand everything a native one gives
 * away: the arrow keys, Home and End, Enter and Escape, and a focus that stays
 * where it should. CSS handles are used here on purpose: these widgets are the
 * one place with no better selector than their own classes.
 */

const ce = copy.expenses;
const cp = copy.preparation;

test.describe('keyboard', () => {
	test('the Select is driven entirely from the keyboard and closes on Escape', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			// Three members give the Paid by select a top, a middle and an end to move between.
			await seedMembers(request, fixture, ['Alice', 'Bob']);
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/expenses`);
			await page.getByRole('button', { name: ce.addExpense, exact: true }).click();
			const dialog = page.getByRole('dialog');

			const trigger = dialog.getByRole('button', { name: ce.addDialog.paidByLabel });
			const menu = dialog.locator('ul.selmenu');
			const active = dialog.locator('li.selopt.active');

			// ArrowDown opens without moving, landing on the current value.
			await trigger.focus();
			await page.keyboard.press('ArrowDown');
			await expect(menu).toBeVisible();
			await expect(active).toHaveText('E2E User');

			// Arrows step, Home and End jump, and ArrowUp clamps at the top.
			await page.keyboard.press('ArrowDown');
			await expect(active).toHaveText('Alice');
			await page.keyboard.press('End');
			await expect(active).toHaveText('Bob');
			await page.keyboard.press('Home');
			await expect(active).toHaveText('E2E User');
			await page.keyboard.press('ArrowUp');
			await expect(active).toHaveText('E2E User');

			// Enter chooses the highlighted row and closes onto it.
			await page.keyboard.press('ArrowDown');
			await page.keyboard.press('ArrowDown');
			await expect(active).toHaveText('Bob');
			await page.keyboard.press('Enter');
			await expect(menu).toBeHidden();
			await expect(trigger).toContainText('Bob');

			// Escape closes the menu and leaves the dialog around it open, which is
			// the case the shared hook exists to get right.
			await trigger.focus();
			await page.keyboard.press('ArrowDown');
			await expect(menu).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(menu).toBeHidden();
			await expect(dialog).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('the MultiSelect stays open across ticks and Escape closes only the menu', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await seedMembers(request, fixture, ['Alice', 'Bob']);
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/pretrip`);
			await page.getByRole('button', { name: cp.add, exact: true }).click();

			// A .mtrigger can also sit on the page behind the modal, so the one under
			// test is always the one inside the open dialog.
			const dialog = page.locator('dialog[open]');
			const menu = dialog.locator('ul.mmenu');
			await dialog.locator('.mtrigger').click();
			await expect(menu).toBeVisible();

			// Picking does not close it: several people are one visit, by design.
			await dialog.getByRole('option', { name: 'Alice', exact: true }).click();
			await expect(menu).toBeVisible();
			await dialog.getByRole('option', { name: 'Bob', exact: true }).click();
			await expect(menu).toBeVisible();

			// Both ticks registered, shown by the box turning on.
			await expect(
				dialog.getByRole('option', { name: 'Alice', exact: true }).locator('span.mbox')
			).toHaveClass(/on/);
			await expect(
				dialog.getByRole('option', { name: 'Bob', exact: true }).locator('span.mbox')
			).toHaveClass(/on/);

			// Escape inside the modal closes the menu and leaves the dialog open.
			await page.keyboard.press('Escape');
			await expect(menu).toBeHidden();
			await expect(dialog).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('the add-city SearchDropdown is a combobox driven by arrows and Enter', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			// The city search hits a paid geocoder, so it is stubbed to two fixed
			// results: this exercises the combobox, not the provider.
			await page.route('**/api/citysearch**', (route) =>
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						results: [
							{ name: 'Testville', country: 'Testland', lat: 1, lng: 2, tz: 'Europe/Lisbon' },
							{ name: 'Otherton', country: 'Otherland', lat: 3, lng: 4, tz: 'Europe/Paris' }
						]
					})
				})
			);
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			// A fresh trip has no cities, so Discover opens its first-run panel.
			await page.getByRole('button', { name: copy.discover.noCities.cta }).click();
			const dialog = page.getByRole('dialog');
			const input = dialog.getByRole('combobox');
			const menu = dialog.locator('.sdropmenu');
			const active = dialog.locator('li.sdropopt.active');

			// Park the cursor away from where the results will render, so a stray
			// hover cannot move the highlight the keyboard is being tested on.
			await page.mouse.move(0, 0);
			await input.fill('Test');
			await expect(dialog.getByRole('option').filter({ hasText: 'Testville' })).toBeVisible();
			// The highlight starts on the first pickable row and steps with the arrows.
			await expect(active).toContainText('Testville');
			await page.keyboard.press('ArrowDown');
			await expect(active).toContainText('Otherton');

			// Enter picks the highlighted row, which closes the popup and clears the box.
			await page.keyboard.press('Enter');
			await expect(menu).toBeHidden();
			await expect(input).toHaveValue('');
			await expect(dialog.getByText('Otherton')).toBeVisible();

			// Escape dismisses a reopened popup without closing the dialog behind it.
			await input.fill('Test');
			await expect(menu).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(menu).toBeHidden();
			await expect(dialog).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('a dialog moves focus into itself and returns it to the trigger on close', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			// A seeded expense gives both dialog shapes to check against the same
			// row: the delete ConfirmDialog stays mounted and toggles `open`, and
			// the edit dialog is rendered conditionally and unmounts on close. The
			// second shape is the one the native restore misses, so both are
			// asserted rather than assuming one stands for the other.
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Solo lunch',
				amount: 20,
				payerId: fixture.userId,
				participantIds: [fixture.userId]
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/expenses`);

			const trigger = page.getByRole('button', { name: ce.row.deleteLabel('Solo lunch') });
			await trigger.click();

			const dialog = page.getByRole('dialog');
			await expect(dialog).toBeVisible();

			// Opening moves focus into the dialog rather than leaving it on the
			// page behind it. The dialog element itself counts as inside: a native
			// modal can hold focus there, which is still trapped. (The trap itself
			// is the browser's native <dialog> behaviour; what is worth asserting
			// is that this app hands focus in on open and back out on close.)
			const focusInDialog = await page.evaluate(() => {
				const d = document.querySelector('dialog[open]');
				return !!d && (d === document.activeElement || d.contains(document.activeElement));
			});
			expect(focusInDialog).toBe(true);

			// Cancelling closes it and hands focus back to the control that opened it.
			await dialog.getByRole('button', { name: copy.common.cancel }).click();
			await expect(dialog).toBeHidden();
			await expect(trigger).toBeFocused();

			// The same promise, from a dialog that unmounts instead of closing.
			// React tears its DOM down after the close effect runs, so nothing
			// native fires and focus lands on <body> unless the app puts it back.
			const editTrigger = page.getByRole('button', { name: ce.row.editLabel('Solo lunch') });
			await editTrigger.click();
			const editDialog = page.getByRole('dialog');
			await expect(editDialog).toBeVisible();
			await editDialog.getByRole('button', { name: copy.common.cancel }).click();
			await expect(editDialog).toBeHidden();
			await expect(editTrigger).toBeFocused();

			// Escape is the other way out, and has to restore focus too.
			await editTrigger.click();
			await expect(page.getByRole('dialog')).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(page.getByRole('dialog')).toBeHidden();
			await expect(editTrigger).toBeFocused();
		} finally {
			fixture.teardown();
		}
	});
});
