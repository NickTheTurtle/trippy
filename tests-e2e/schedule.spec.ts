import { expect, test } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { addCity, addPlace, seedMembers } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

/**
 * Wait for the board to stop scrolling.
 *
 * The schedule scrolls a previewed block into sight with `behavior: 'smooth'`,
 * which keeps running after whatever started it has gone. Anything aimed at a
 * coordinate has to wait for it, or it is aimed at where the board was. The day
 * scrolls inside its own box, so both that and the page are watched: either one
 * moving means the coordinates are still changing.
 */
async function settled(page: import('@playwright/test').Page): Promise<void> {
	await page.waitForFunction(
		() =>
			new Promise<boolean>((done) => {
				const box = document.querySelector('.sched .boardscroll');
				const was = [window.scrollY, box?.scrollTop ?? 0];
				requestAnimationFrame(() =>
					requestAnimationFrame(() =>
						done(window.scrollY === was[0] && (box?.scrollTop ?? 0) === was[1])
					)
				);
			}),
		undefined,
		{ timeout: 5000 }
	);
}

/**
 * The schedule toolbar: the two controls that decide which board you are
 * looking at. Both are bounded, and the bounds are the point of the tests.
 */

test.describe('schedule toolbar', () => {
	test('day navigation stops at the ends of the trip', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const { startDate, endDate } = fixture.tripBody;
		try {
			await signIn(page, fixture.sessionCookie);

			const prev = page.getByRole('button', { name: 'Previous day' });
			const next = page.getByRole('button', { name: 'Next day' });
			const prevLink = page.getByRole('link', { name: 'Previous day' });
			const nextLink = page.getByRole('link', { name: 'Next day' });

			// First day: there is nothing before it, and the arrow says so rather
			// than walking into days the trip does not have.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);
			await expect(prev).toBeDisabled();
			await expect(nextLink).toBeVisible();

			// Middle day: both ways are open.
			await nextLink.click();
			await expect(prevLink).toBeVisible();
			await expect(nextLink).toBeVisible();

			// Last day.
			await nextLink.click();
			await expect(prevLink).toBeVisible();
			await expect(next).toBeDisabled();

			// A day typed past the end lands on the last day the trip offers, not on
			// an empty board with no way back.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=2030-01-01&view=day`);
			await expect(next).toBeDisabled();
			await expect(prevLink).toBeVisible();

			await page.goto(`/trips/${fixture.tripId}/schedule?day=1999-01-01&view=day`);
			await expect(prev).toBeDisabled();

			// A view the app no longer has falls back to the day board rather than
			// an empty one, since the view is a url and urls outlive a view. The
			// board is asserted through the day/people toggle rather than through
			// the grid, because a day with nothing on it draws an empty state.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${endDate}&view=3day`);
			await expect(page.getByRole('link', { name: 'Day', exact: true })).toHaveAttribute(
				'aria-current',
				'true'
			);
			await expect(next).toBeDisabled();
		} finally {
			fixture.teardown();
		}
	});

	test('"view as" offers the whole trip or one person, and nothing in between', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await seedMembers(request, fixture, ['Ada', 'Bo']);
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule`);

			const control = page.getByRole('button', { name: 'View the schedule as' });
			await expect(control).toHaveText(copy.viewAs.everyone);

			await control.click();
			const options = page.getByRole('option');
			// Everyone plus the three members, and no way to tick several at once:
			// picking closes the menu on one value.
			await expect(options).toHaveCount(4);
			await expect(options.first()).toHaveText(copy.viewAs.everyone);

			await page.getByRole('option', { name: 'Ada', exact: true }).click();
			await expect(options).toHaveCount(0);
			await expect(control).toHaveText('Ada');

			// The agenda is one person's day, so "Everyone" is not among its
			// choices and arriving with nobody chosen reads as you.
			await page.goto(`/trips/${fixture.tripId}/schedule?view=agenda`);
			await expect(control).toHaveText(`E2E User${copy.preparation.youSuffix}`);
			await control.click();
			await expect(options).toHaveCount(3);
			await expect(page.getByRole('option', { name: copy.viewAs.everyone })).toHaveCount(0);
		} finally {
			fixture.teardown();
		}
	});
});

/**
 * Journeys in the add dialog.
 *
 * Naming who is going is what makes a journey exist, so the ones arriving at a
 * block are planned while it is still being described. The point of the test is
 * that they are shown there and that what the reader says about them survives
 * the save: they are planned under a draft id and written under the real one.
 */
test.describe('adding an event', () => {
	test('shows the journeys arriving at it, and keeps what was said about them', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		try {
			const cityId = await addCity(request, fixture, {
				name: 'Athens',
				country: 'Greece',
				tz: 'Europe/Athens',
				lat: 37.9838,
				lng: 23.7275
			});
			// Two places far enough apart to be a journey rather than the same spot.
			await addPlace(request, fixture, {
				cityId,
				name: 'Acropolis',
				lat: 37.9715,
				lng: 23.7257
			});
			await addPlace(request, fixture, {
				cityId,
				name: 'Plaka',
				lat: 37.9725,
				lng: 23.73
			});
			// A journey belongs to the people making it, so the blocks name one.
			// The picker reads a full house as "Everyone", which is nobody in
			// particular, so a second member is what makes a named group possible.
			await seedMembers(request, fixture, ['Ada']);
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			const pickAda = async () => {
				await page.getByLabel('Participants').click();
				await page.getByRole('option', { name: 'Ada', exact: true }).click();
				await page.keyboard.press('Escape');
			};

			// The morning, which the afternoon is then approached from.
			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			await page.getByLabel('Name').fill('Morning');
			await pickAda();
			await page.getByLabel('Activity').click();
			await page.getByRole('option', { name: 'Acropolis' }).click();
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();
			await expect(page.getByRole('button', { name: /Morning/ })).toBeVisible();

			// The afternoon. Its journey exists before it does, so the section is
			// there to be edited while the block is still being described.
			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			await page.getByLabel('Name').fill('Afternoon');
			// The clock is a spinbutton, not a text box: its segments are typed into.
			await page.getByLabel('Start hour').click();
			await page.keyboard.type('14');
			await pickAda();
			await page.getByLabel('Activity').click();
			await page.getByRole('option', { name: 'Plaka' }).click();

			const journey = page.locator('dialog[open] .jrow');
			await expect(journey).toHaveCount(1);
			await journey.getByLabel(/^Journey name/).fill('Taxi up the hill');
			await journey.getByLabel(/^Minutes/).fill('42');
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();

			// Reopened, the journey is still the one the reader described, which is
			// only true if it was written against the id the block ended up with.
			// The dialog scrolls the block it is previewing into sight smoothly, and
			// that outlives the dialog, so wait for the page to stand still: a click
			// aimed at a block mid-scroll lands on the track beside it.
			await settled(page);
			await page.getByRole('button', { name: /Afternoon/ }).click();
			const saved = page.locator('dialog[open] .jrow');
			await expect(saved.getByLabel(/^Journey name/)).toHaveValue('Taxi up the hill');
			await expect(saved.getByLabel(/^Minutes/)).toHaveValue('42');
		} finally {
			fixture.teardown();
		}
	});
});

/**
 * The window the board draws.
 *
 * Six to midnight on an ordinary day, because that is where a day is read from,
 * but a floor rather than a wall: a block earlier than six has to be drawn at
 * the hour it is at, not clamped onto the top edge where it would read as a
 * different time.
 */
test.describe('the day window', () => {
	test('opens back to an early block instead of clamping it onto the top edge', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		const firstHour = () => page.locator('.hourline span').first();
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			await page.getByLabel('Name').fill('Ordinary morning');
			await page.getByLabel('Start hour').click();
			await page.keyboard.type('09');
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();
			await expect(firstHour()).toHaveText('6 AM');

			// 4:40, which the old fixed window drew at 6 AM.
			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			await page.getByLabel('Name').fill('Airport run');
			await page.getByLabel('Start hour').click();
			await page.keyboard.type('04');
			await page.getByLabel('Start minute').click();
			await page.keyboard.type('40');
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();

			// Back to the hour that holds it, and no further: the window is fitted
			// to the day rather than opened to a full twenty-four on every day.
			await expect(firstHour()).toHaveText('4 AM');
			const block = page.locator('.block', { hasText: 'Airport run' }).first();
			// 4:40 measured from the window's own 4 AM, at one pixel a minute. The
			// clamped board drew it at 0, on top of the six o'clock line.
			await expect(block).toHaveCSS('top', '40px');
		} finally {
			fixture.teardown();
		}
	});

	test('the hours scroll inside the board while its title bar stays', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		const box = page.locator('.sched .boardscroll');
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			// A block late enough to be off the bottom of any box the day is drawn
			// in, which is the whole point: it has to be reachable.
			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			await page.getByLabel('Name').fill('Last orders');
			await page.getByLabel('Start hour').click();
			await page.keyboard.type('22');
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();
			const block = page.locator('.block', { hasText: 'Last orders' }).first();
			await expect(block).toBeVisible();
			await settled(page);

			// The day is taller than the box, so the box is what scrolls.
			const room = await box.evaluate((el) => el.scrollHeight - el.clientHeight);
			expect(room).toBeGreaterThan(0);

			const head = page.locator('.sched .boardhead');
			const headTop = () => head.evaluate((el) => el.getBoundingClientRect().top);
			const before = await headTop();
			const pageBefore = await page.evaluate(() => window.scrollY);

			await box.evaluate((el) => el.scrollTo(0, el.scrollHeight));
			await settled(page);

			// The day it is drawing, and the way to the next one, are still there.
			expect(Math.abs((await headTop()) - before)).toBeLessThanOrEqual(1);
			expect(await page.evaluate(() => window.scrollY)).toBe(pageBefore);
			// And the last hour of the day arrived, inside the box rather than past
			// the bottom of it.
			const seen = await block.evaluate((el) => {
				const r = el.getBoundingClientRect();
				const b = el.closest('.boardscroll')!.getBoundingClientRect();
				return r.top < b.bottom && r.bottom > b.top;
			});
			expect(seen).toBe(true);
		} finally {
			fixture.teardown();
		}
	});

	test('a drag opens it past six, and the block stays under the pointer', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		const firstHour = () => page.locator('.hourline span').first();
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			await page.getByLabel('Name').fill('Sunrise swim');
			await page.getByLabel('Start hour').click();
			await page.keyboard.type('09');
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();
			await expect(firstHour()).toHaveText('6 AM');

			const block = page.locator('.block', { hasText: 'Sunrise swim' }).first();
			// 9:00 measured from the window's 6 AM. Asserting it before taking hold
			// means the board has finished settling after the add, so the grab is
			// not aimed at where the block was a moment ago.
			await expect(block).toHaveCSS('top', '180px');
			// The add scrolls the new block into sight smoothly, and that outlives
			// the dialog, so the grab has to wait for the board to stand still.
			await settled(page);
			// Measured through the element: `boundingBox` reports null for these,
			// even once they are visible.
			const screenY = () => block.evaluate((el) => el.getBoundingClientRect().top);
			const boxTop = await page
				.locator('.sched .boardscroll')
				.evaluate((el) => el.getBoundingClientRect().top);
			const grabX = 200;
			const grabY = (await screenY()) + 10;

			// An hour up the board, well inside the box it is drawn in: the block is
			// glued to the pointer, so a drop lands where it looks like it will.
			await page.mouse.move(grabX, grabY);
			await page.mouse.down();
			await page.mouse.move(grabX, grabY - 60, { steps: 8 });
			// The block eases into each five-minute step, so wait for the step to
			// be the hour it was dragged to before measuring where it sits.
			await expect(block).toHaveCSS('top', '120px');
			expect(Math.abs((await screenY()) + 10 - (grabY - 60))).toBeLessThanOrEqual(2);

			// Carried up to the top edge of the box, the day opens past six under a
			// block that stays visible: the hours run past it rather than it running
			// off the top of the box, which is the one place the glue gives way.
			// The edge keeps opening the day for as long as the pointer is held
			// there, so what is asserted is that it went past six, not the minute it
			// happened to reach.
			await page.mouse.move(grabX, boxTop + 6, { steps: 8 });
			await expect(firstHour()).toHaveText(/^([1-5]|12) AM$/);
			expect(await screenY()).toBeGreaterThanOrEqual(boxTop - 1);

			await page.mouse.up();
			// Settled on an hour that holds it, which is where a saved day starts,
			// and the block is still the one being read: it kept its own time.
			await expect(firstHour()).toHaveText(/^([1-5]|12) AM$/);
			await expect(block).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});
	test('a quick drag of the bottom edge lands, and the new end sticks', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			await page.getByLabel('Name').fill('Long lunch');
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();

			const block = page.locator('.block', { hasText: 'Long lunch' }).first();
			await expect(block).toHaveCSS('top', '180px');
			await settled(page);

			// One move between down and up, which is what a flick of the grip is:
			// the handler has to see the gesture it was just handed rather than the
			// render that has not committed yet.
			const grip = block.locator('.bresize');
			const box = await grip.evaluate((el) => {
				const r = el.getBoundingClientRect();
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
			});
			await page.mouse.move(box.x, box.y);
			await page.mouse.down();
			await page.mouse.move(box.x, box.y + 60);
			await page.mouse.up();

			// An hour longer, kept once the write comes back.
			await expect(
				page.getByRole('button', { name: /Long lunch, 9:00 AM to 11:00 AM/ })
			).toBeVisible();
			await page.reload();
			await expect(
				page.getByRole('button', { name: /Long lunch, 9:00 AM to 11:00 AM/ })
			).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});
});

/**
 * Stays, which are the one thing on the board that is not on the clock.
 *
 * A stay is a range of nights, so it is a band above every day it covers and it
 * is edited from any of them. The point of the test is the range: that adding
 * one on the first night puts it on the following days as well, that the band
 * runs through the morning of checkout, and that shortening it from a later day
 * takes it off the days it no longer reaches.
 */
test.describe('stays', () => {
	test('a stay bands every day it covers, and is edited from any of them', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		const second = new Date(`${startDate}T00:00:00Z`);
		second.setUTCDate(second.getUTCDate() + 1);
		const day2 = second.toISOString().slice(0, 10);
		const third = new Date(`${startDate}T00:00:00Z`);
		third.setUTCDate(third.getUTCDate() + 2);
		const day3 = third.toISOString().slice(0, 10);

		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			await page.getByRole('button', { name: '+ Add stay' }).click();
			await page.getByLabel('Name').fill('Harbour rooms');
			await page.getByLabel('Check out').fill(day3);
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();

			const chip = page.getByRole('button', { name: /Harbour rooms/ });
			await expect(chip).toBeVisible();

			// The second night it covers, where it is a band just the same.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day2}&view=day`);
			await expect(chip).toBeVisible();

			// The morning of checkout is still spent in the room.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day3}&view=day`);
			await expect(chip).toBeVisible();

			// Shortened from the second day, which then becomes its checkout morning.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day2}&view=day`);
			await chip.click();
			await expect(page.getByLabel('Check in')).toHaveValue(startDate);
			await page.getByLabel('Check out').fill(day2);
			await page.getByRole('button', { name: copy.common.save, exact: true }).click();
			await expect(chip).toBeVisible();

			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day3}&view=day`);
			await expect(chip).toHaveCount(0);

			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);
			await expect(chip).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});
});
