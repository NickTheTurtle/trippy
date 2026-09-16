import { expect, test } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { addCity, seedMembers } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

const LISBON = { name: 'Lisbon', country: 'Portugal', region: 'Lisboa', tz: 'Europe/Lisbon' };

/**
 * How the two-axis pages narrow.
 *
 * On a phone the pages that carry a section column cannot afford one, so each
 * column becomes a dropdown that names where you are, with the section's own
 * action beside it. What these tests hold onto is the swap itself: exactly one
 * form is ever on the page, and nothing the wide layout offered is left behind
 * in it.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

test.describe('narrow layouts', () => {
	test('a phone gets the sections as a dropdown, a desktop gets the column', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);

			await page.setViewportSize(PHONE);
			await page.goto(`/trips/${fixture.tripId}/preparation`);

			const sections = page.getByRole('button', { name: copy.preparation.navAriaLabel });
			const column = page.getByRole('navigation', { name: copy.preparation.navAriaLabel });

			// The trigger names the section you are on, and the column it stands in
			// for is not rendered behind it.
			await expect(sections).toBeVisible();
			await expect(sections).toHaveText(copy.preparation.sections.tasks);
			await expect(column).toBeHidden();

			// The section's own button rides with the dropdown rather than staying in
			// the page header, so both are on the first row.
			const add = page.getByRole('button', { name: copy.preparation.add, exact: true });
			await expect(add).toBeVisible();
			const [pickerBox, addBox] = [await sections.boundingBox(), await add.boundingBox()];
			expect(pickerBox && addBox && Math.abs(pickerBox.y - addBox.y)).toBeLessThan(12);

			await sections.click();
			await page.getByRole('option', { name: copy.preparation.sections.packing }).click();
			await expect(sections).toHaveText(copy.preparation.sections.packing);

			// Given the room, the column comes back and the dropdown goes away.
			await page.setViewportSize(DESKTOP);
			await expect(column).toBeVisible();
			await expect(sections).toHaveCount(0);
		} finally {
			fixture.teardown();
		}
	});

	test('a phone gets the cities as a dropdown, with the organizer controls beside it', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			await addCity(request, fixture, LISBON);

			await page.setViewportSize(PHONE);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			// A city scopes the page rather than being a place in it, so it stays in
			// the header as a filter instead of going behind the menu button the
			// section lists use.
			const cities = page.getByRole('button', { name: copy.discover.cityList.navLabel });
			await expect(cities).toBeVisible();
			await expect(page.getByRole('dialog', { name: copy.discover.cityList.navLabel })).toHaveCount(
				0
			);
			await cities.click();
			await expect(page.getByRole('option', { name: LISBON.name })).toBeVisible();
			await page.keyboard.press('Escape');

			// A dropdown has no per-row delete, so both organizer controls sit beside
			// it: adding is how you get out of a one-city trip, and removing has to
			// stay reachable on a phone at all.
			await expect(
				page.getByRole('button', { name: copy.discover.cityList.addCity })
			).toBeVisible();
			await expect(
				page.getByRole('button', { name: copy.discover.cityList.removeLabel(LISBON.name) })
			).toBeVisible();

			// The type filter is pills here and a dropdown on a desktop, so only one
			// of the two forms is ever on the page.
			const types = page.getByRole('group', { name: copy.discover.header.typeAriaLabel });
			await expect(types).toBeVisible();
			await expect(
				page.getByRole('button', { name: copy.discover.header.typeAriaLabel })
			).toHaveCount(0);

			await page.setViewportSize(DESKTOP);
			await expect(types).toHaveCount(0);
			await expect(
				page.getByRole('button', { name: copy.discover.header.typeAriaLabel })
			).toBeVisible();
			await expect(
				page.getByRole('navigation', { name: copy.discover.cityList.navLabel })
			).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('the schedule toolbar gives the view switch its own line on a phone', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			// The "View as" filter is only rendered once there is somebody else to
			// read the board as, and it is the control the switch shares its row
			// with, so the crowded case is the one worth holding onto.
			await seedMembers(request, fixture, ['Wren']);

			await page.setViewportSize(PHONE);
			await page.goto(`/trips/${fixture.tripId}/schedule`);

			const pills = page.locator('.sched .toolbar .pills');
			const viewAs = page.locator('.sched .toolbar .viewas');
			const add = page.locator('.sched .toolbar .btn.primary');
			await expect(pills).toBeVisible();
			await expect(viewAs).toBeVisible();

			const boxes = async () => ({
				pills: await pills.boundingBox(),
				viewAs: await viewAs.boundingBox(),
				add: await add.boundingBox(),
				toolbar: await page.locator('.sched .toolbar').boundingBox()
			});

			let box = await boxes();
			// The filter and the button share the first line, and the switch is
			// below both of them rather than wedged between them.
			expect(box.viewAs && box.add && Math.abs(box.viewAs.y - box.add.y)).toBeLessThan(12);
			expect(box.pills && box.add && box.pills.y - box.add.y).toBeGreaterThan(12);

			// It takes the line it is given, so each half is a real target rather
			// than the smallest thing in the row.
			expect(box.pills && box.toolbar && box.pills.width / box.toolbar.width).toBeGreaterThan(0.9);
			expect(box.pills && box.pills.height).toBeGreaterThan(30);

			// Nothing bought that line by pushing the page sideways.
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
				)
			).toBe(true);

			// Given the room, all three go back to one line.
			await page.setViewportSize(DESKTOP);
			box = await boxes();
			expect(box.pills && box.add && Math.abs(box.pills.y - box.add.y)).toBeLessThan(12);
			expect(box.viewAs && box.add && Math.abs(box.viewAs.y - box.add.y)).toBeLessThan(12);
		} finally {
			fixture.teardown();
		}
	});
});
