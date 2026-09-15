import { expect, test, type Locator, type Page } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { seedMembers } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

/**
 * Preparation: tasks, packing and cost estimates. Members are seeded through
 * the API so the assignment widgets have people to pick; the tasks and costs
 * themselves are created through the UI, since those flows are the point.
 */

const cp = copy.preparation;

/** Opens a MultiSelect by its accessible name and ticks one option by name. */
async function tickInMultiSelect(scope: Locator, triggerName: string, option: string, page: Page) {
	await scope.getByRole('button', { name: triggerName }).click();
	await scope.getByRole('option', { name: option, exact: true }).click();
	// The menu stays open on pick by design, so close it with Escape, which must
	// leave the surrounding dialog open.
	await page.keyboard.press('Escape');
}

test.describe('preparation', () => {
	test('a task can be added, assigned, ticked, unticked and then deleted', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await seedMembers(request, fixture, ['Alice']);
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/preparation`);

			await page.getByRole('button', { name: cp.add, exact: true }).click();
			const dialog = page.getByRole('dialog');
			await dialog.getByLabel(cp.taskDialog.labelField).fill('Book the museum');
			await tickInMultiSelect(dialog, cp.taskDialog.assignLabel, 'Alice', page);
			// The menu closed but the dialog is still open.
			await expect(dialog).toBeVisible();
			await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();

			// The box leads with the whole-roster label once someone is assigned.
			const unticked = page.getByRole('button', {
				name: cp.taskList.allBoxLabel(false, 'Book the museum')
			});
			await expect(unticked).toBeVisible();
			await unticked.click();

			// Ticked: the box reports pressed and its label flips to "not done".
			const ticked = page.getByRole('button', {
				name: cp.taskList.allBoxLabel(true, 'Book the museum')
			});
			await expect(ticked).toHaveAttribute('aria-pressed', 'true');
			await ticked.click();
			await expect(unticked).toHaveAttribute('aria-pressed', 'false');

			// Delete lives inside the row's own dialog now, behind the house
			// confirmation, so the row is opened rather than hunted for a bin.
			await page
				.getByRole('button', { name: cp.taskList.editLabel('task', 'Book the museum') })
				.click();
			const form = page.getByRole('dialog');
			await form.getByRole('button', { name: copy.common.delete, exact: true }).click();
			const confirm = page.getByRole('dialog');
			await expect(confirm.getByText(copy.ui.confirmDialog.undone)).toBeVisible();
			await confirm.getByRole('button', { name: copy.common.delete, exact: true }).click();
			await expect(page.getByText('Book the museum', { exact: true })).toBeHidden();
		} finally {
			fixture.teardown();
		}
	});

	test('a packing item can be added to the packing list', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/preparation`);

			await page.getByRole('button', { name: cp.sections.packing }).click();
			await page.getByRole('button', { name: cp.add, exact: true }).click();
			const dialog = page.getByRole('dialog');
			// A packing item is your own bag, so the dialog offers no assignee field.
			await expect(
				dialog.getByRole('heading', { name: cp.taskDialog.title('packing', false) })
			).toBeVisible();
			await dialog.getByLabel(cp.taskDialog.labelField).fill('Sunscreen');
			await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();

			await expect(page.getByText('Sunscreen')).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('an estimate can be added for the whole group and for one person', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await seedMembers(request, fixture, ['Alice']);
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/preparation`);
			await page.getByRole('button', { name: cp.sections.costs }).click();

			await addCost(page, { label: 'Museum passes', amount: '60' });
			// A line with nobody on it is the whole trip's, and reads as Everyone.
			// Scope to the row, since the ViewAs bar also carries an "Everyone" control.
			const groupRow = page.locator('li', { hasText: 'Museum passes' });
			await expect(groupRow).toBeVisible();
			await expect(groupRow).toContainText(copy.viewAs.everyone);

			await addCost(page, { label: 'Alice flight', amount: '200', forMember: 'Alice' });
			// A line naming people is split between them, and reads as their names.
			const soloRow = page.locator('li', { hasText: 'Alice flight' });
			await expect(soloRow).toBeVisible();
			await expect(soloRow).toContainText('Alice');
		} finally {
			fixture.teardown();
		}
	});

	test('an estimate in another currency shows a converted home figure', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/preparation`);
			await page.getByRole('button', { name: cp.sections.costs }).click();

			// Home currency is USD; a euro estimate must show an approximate home
			// figure beside the amount, converted at the current rate.
			await addCost(page, { label: 'Gelato tour', amount: '30', currency: 'EUR' });

			const row = page.locator('li', { hasText: 'Gelato tour' });
			// The amount is rendered with the currency symbol, and the approximate
			// home figure follows it.
			await expect(row).toContainText('€');
			await expect(row).toContainText('≈');
			await expect(row).toContainText('$');
		} finally {
			fixture.teardown();
		}
	});

	test('a cost estimate can be edited and then deleted', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/preparation`);
			await page.getByRole('button', { name: cp.sections.costs }).click();

			await addCost(page, { label: 'Rental car', amount: '150' });
			await page.getByRole('button', { name: cp.costTable.editLabel('Rental car') }).click();
			const dialog = page.getByRole('dialog');
			await dialog.getByLabel(cp.costDialog.labelField).fill('Rental van');
			await dialog.getByRole('button', { name: copy.common.save }).click();
			await expect(page.getByText('Rental van')).toBeVisible();

			await page.getByRole('button', { name: cp.costTable.editLabel('Rental van') }).click();
			await page
				.getByRole('dialog')
				.getByRole('button', { name: copy.common.delete, exact: true })
				.click();
			const confirm = page.getByRole('dialog');
			await confirm.getByRole('button', { name: copy.common.delete, exact: true }).click();
			await expect(page.getByText('Rental van', { exact: true })).toBeHidden();
		} finally {
			fixture.teardown();
		}
	});
});

/** Fills and submits the Add cost dialog. */
async function addCost(
	page: Page,
	opts: { label: string; amount: string; currency?: string; forMember?: string }
) {
	await page.getByRole('button', { name: cp.add, exact: true }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel(cp.costDialog.labelField).fill(opts.label);
	await dialog.getByLabel(cp.costDialog.amountLabel).fill(opts.amount);
	if (opts.currency) {
		await dialog.getByRole('button', { name: cp.costDialog.currencyLabel }).click();
		await dialog.getByRole('option', { name: opts.currency, exact: true }).click();
	}
	if (opts.forMember) {
		await dialog.getByRole('button', { name: cp.costDialog.forLabel }).click();
		await dialog.getByRole('option', { name: opts.forMember, exact: true }).click();
		await page.keyboard.press('Escape');
	}
	await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();
	await expect(dialog).toBeHidden();
}
