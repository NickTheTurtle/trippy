import { expect, test } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { addCity } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

/* The two date fields are named by their row's caption and their own word. */
const cf = copy.schedule.fields;
const startDateName = `${cf.start} ${cf.date}`;
const endDateName = `${cf.end} ${cf.date}`;

/**
 * A block that runs past its own day: an overnight train, a red-eye, a two-day
 * hike. It is drawn on each day it covers the way a phone calendar draws one,
 * from its start to midnight, then from midnight to its end, and the editor
 * asks for a start and an end as a date and a clock each.
 */
test.describe('a block that runs past its day', () => {
	test('is drawn on the day it starts and on the day it ends', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		const nextDay = '2027-02-11';
		try {
			await addCity(request, fixture, {
				name: 'Lisbon',
				country: 'Portugal',
				tz: 'Europe/Lisbon'
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			// 10 PM tonight to 7 AM tomorrow.
			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			const dialog = page.getByRole('dialog').first();
			await dialog.getByLabel('Notes').fill('Night train');
			await dialog.getByLabel('Start hour').click();
			await page.keyboard.type('10');
			await dialog.getByLabel('Start meridiem').click();
			await page.keyboard.type('p');
			await dialog.getByRole('textbox', { name: endDateName, exact: true }).fill(nextDay);
			await dialog.getByLabel('End hour').click();
			await page.keyboard.type('7');
			await dialog.getByLabel('End meridiem').click();
			await page.keyboard.type('a');
			await expect(dialog.getByLabel('End meridiem')).toHaveAttribute('aria-valuetext', 'AM');
			await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();
			await expect(dialog).toBeHidden();

			// Tonight, from its start: it carries on, so it says where it begins
			// and its bottom edge is the cut one.
			const tonight = page
				.locator(`.daypanel[data-day="${startDate}"]`)
				.getByRole('button', { name: /^Night train, / });
			await expect(tonight).toHaveAttribute(
				'aria-label',
				new RegExp(`^Night train, ${copy.schedule.span.from('10:00 PM')}`)
			);
			await expect(page.locator('.daypanel[data-day="2027-02-10"] .block.cutbottom')).toHaveCount(
				1
			);

			// Tomorrow, until its end, from the top of the day.
			await page.getByRole('link', { name: 'Next day' }).click();
			await expect(page).toHaveURL(/day=2027-02-11/);
			const morning = page
				.locator(`.daypanel[data-day="${nextDay}"]`)
				.getByRole('button', { name: /^Night train, / });
			await expect(morning).toHaveAttribute(
				'aria-label',
				new RegExp(`^Night train, ${copy.schedule.span.until('7:00 AM')}`)
			);
			await expect(page.locator('.daypanel[data-day="2027-02-11"] .block.cuttop')).toHaveCount(1);

			// The agenda lists it on both days: the whole range where it starts,
			// and the part of it on the day after.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=agenda`);
			await expect(page.locator('.agendarow', { hasText: 'Night train' })).toContainText(
				copy.schedule.span.range('10:00 PM Wed', '7:00 AM Thu')
			);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${nextDay}&view=agenda`);
			await expect(page.locator('.agendarow', { hasText: 'Night train' })).toContainText(
				copy.schedule.span.until('7:00 AM')
			);
		} finally {
			fixture.teardown();
		}
	});

	test('the editor says why an end before the start cannot be saved', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			const dialog = page.getByRole('dialog').first();
			const start = dialog.getByRole('textbox', { name: startDateName, exact: true });
			const end = dialog.getByRole('textbox', { name: endDateName, exact: true });
			// The end day starts out as the start day, and moves with it.
			await expect(end).toHaveValue(startDate);
			await start.fill('2027-02-11');
			await expect(end).toHaveValue('2027-02-11');

			// An end the day before the start is said under the end, in the
			// server's own words, and the Add goes nowhere.
			await end.fill(startDate);
			await end.blur();
			await expect(dialog.getByRole('alert')).toHaveText(copy.schedule.span.endBeforeStart);
			await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();
			await expect(dialog).toBeVisible();
			await expect(end).toHaveValue(startDate);
		} finally {
			fixture.teardown();
		}
	});

	test('a date can be typed into, digit by digit, and is held to the trip once left', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			const dialog = page.getByRole('dialog').first();
			const end = dialog.getByRole('textbox', { name: endDateName, exact: true });
			const [y, m, d] = startDate.split('-');
			const next = new Date(Date.UTC(+y, +m - 1, +d + 1)).toISOString().slice(0, 10);
			const [ny, nm, nd] = next.split('-');

			// Typed the way a person does: month, day, then the year a digit at a
			// time. Each digit of the year is a real date on its way through
			// (0002, 0020, 0202), which used to be snapped to the trip at once.
			await end.click({ position: { x: 14, y: 12 } });
			await page.keyboard.type(`${nm}${nd}${ny}`, { delay: 40 });
			await expect(end).toHaveValue(next);

			// A day far past the trip is kept while typing and held to it on leaving.
			await end.click({ position: { x: 14, y: 12 } });
			await page.keyboard.type(`12${nd}${+ny + 1}`, { delay: 40 });
			await dialog.getByRole('heading').first().click();
			await expect(end).not.toHaveValue(`${+ny + 1}-12-${nd}`);
		} finally {
			fixture.teardown();
		}
	});
});
