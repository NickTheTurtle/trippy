import { expect, test, type APIRequestContext } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { addCity, addPlace, addStay, apiSend, seedMembers } from './fixtures/seed';
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

			// A day typed past the end is refused now rather than swapped for the
			// last day the trip has. The swap was a 200 carrying a different day
			// than the url named, which is how the url and the board got out of
			// step; the refusal names the range instead, and the payload carries
			// `firstDay` / `lastDay` so the board can send the reader to a real day
			// once that half is built.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=2030-01-01&view=day`);
			await expect(page.getByText('That day is outside this trip')).toBeVisible();

			await page.goto(`/trips/${fixture.tripId}/schedule?day=1999-01-01&view=day`);
			await expect(page.getByText('That day is outside this trip')).toBeVisible();

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

			// The morning, which the afternoon is then approached from. There is no
			// name field: a block is named after the place it is at, so these two
			// are the Acropolis and Plaka rather than "Morning" and "Afternoon".
			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			await pickAda();
			// Exactly "Activity", which is the place picker: a combobox now, since a
			// location can be typed as well as picked. An unnamed block is still
			// previewed under its type's own noun.
			await page.getByRole('combobox', { name: 'Activity' }).click();
			await page.getByRole('option', { name: 'Acropolis' }).click();
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();
			// The block on the board, not the pin the map drops for the same place:
			// the block's name carries the time it is at.
			await expect(page.getByRole('button', { name: /^Acropolis, / })).toBeVisible();

			// The afternoon. Its journey exists before it does, so the section is
			// there to be edited while the block is still being described.
			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			/* The clock is three spinbuttons, not a text box, and it reads in twelve
			   hours: "2" is the hour and "p" is the afternoon, which is how the time
			   is said. The letter is taken from whichever segment has focus, so this
			   is the whole of 2 PM in two keys. */
			await page.getByLabel('Start hour').click();
			await page.keyboard.type('2');
			await page.getByLabel('Start meridiem').click();
			await page.keyboard.type('p');
			await expect(page.getByLabel('Start hour')).toHaveAttribute('aria-valuetext', '2');
			await expect(page.getByLabel('Start meridiem')).toHaveAttribute('aria-valuetext', 'PM');
			await pickAda();
			await page.getByRole('combobox', { name: 'Activity' }).click();
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
			await page.getByRole('button', { name: 'Edit Plaka' }).click();
			const saved = page.locator('dialog[open] .jrow');
			// And it reopens on the clock it was typed on: 2 PM, not 14:45.
			await expect(page.getByLabel('Start hour')).toHaveAttribute('aria-valuetext', '2');
			await expect(page.getByLabel('Start meridiem')).toHaveAttribute('aria-valuetext', 'PM');
			await expect(saved.getByLabel(/^Journey name/)).toHaveValue('Taxi up the hill');
			await expect(saved.getByLabel(/^Minutes/)).toHaveValue('42');
		} finally {
			fixture.teardown();
		}
	});

	/*
	 * Everyone is stored as nobody, so the field has to keep an emptied pick and
	 * "everyone" apart all the way to the save. Emptying it is allowed, because
	 * it is a normal step on the way to picking somebody else; saving it is what
	 * is refused, and the refusal is the same corner toast every other refused
	 * save uses.
	 */
	test('Participants can be emptied, and saving an empty one is refused', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		try {
			await seedMembers(request, fixture, ['Ada']);
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			const participants = page.getByLabel('Participants');
			await expect(participants).toHaveText(/Everyone/);
			await participants.click();

			const everyone = page.getByRole('option', { name: 'Everyone', exact: true });
			const ada = page.getByRole('option', { name: 'Ada', exact: true });
			await expect(everyone).toHaveAttribute('aria-selected', 'true');
			await expect(ada).toHaveAttribute('aria-selected', 'true');

			// The crew that covers the trip empties the field rather than bouncing.
			await everyone.click();
			await expect(ada).toHaveAttribute('aria-selected', 'false');
			await expect(participants).toHaveText(/Nobody/);

			// Nothing is said until the save is asked for, and then it is said in
			// the corner like any other refusal.
			await page.keyboard.press('Escape');
			await page.getByRole('button', { name: 'Add', exact: true }).click();
			await expect(page.locator('.toast.bad')).toHaveText(/at least one person/);
			await expect(page.getByRole('dialog')).toBeVisible();

			// Naming somebody clears it, and the block saves.
			await participants.click();
			await ada.click();
			await expect(participants).toHaveText(/Ada/);
			await page.keyboard.press('Escape');
			await page.getByRole('button', { name: 'Add', exact: true }).click();
			await expect(page.getByRole('dialog')).toHaveCount(0);

			// Reopened, the one name is still the one name: an emptied field never
			// reached the store to come back as everyone.
			await page.getByRole('button', { name: 'Edit Activity' }).click();
			const editing = page.getByLabel('Participants');
			await expect(editing).toHaveText(/Ada/);

			// The edit dialog refuses it the same way, rather than writing an empty
			// list the server would read back as the whole group.
			await editing.click();
			await page.getByRole('option', { name: 'Ada', exact: true }).click();
			await expect(editing).toHaveText(/Nobody/);
			await page.keyboard.press('Escape');
			await page.getByRole('button', { name: 'Save', exact: true }).click();
			await expect(page.locator('.toast.bad')).toHaveText(/at least one person/);
			await expect(page.getByRole('dialog')).toBeVisible();
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
			// Blocks are named by the server now, and the first line of the notes is
			// where it looks when no place has been picked.
			await page.getByLabel('Notes').fill('Ordinary morning');
			await page.getByLabel('Start hour').click();
			await page.keyboard.type('9');
			await expect(page.getByLabel('Start meridiem')).toHaveAttribute('aria-valuetext', 'AM');
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();
			await expect(firstHour()).toHaveText('6 AM');

			// 4:40 AM, which the old fixed window drew at 6 AM.
			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			await page.getByLabel('Notes').fill('Airport run');
			await page.getByLabel('Start hour').click();
			await page.keyboard.type('4');
			await page.getByLabel('Start minute').click();
			await page.keyboard.type('40');
			await expect(page.getByLabel('Start meridiem')).toHaveAttribute('aria-valuetext', 'AM');
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

	test('the hours scroll inside the board while its title bar stays', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		const box = page.locator('.sched .boardscroll');
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			// A block late enough to be off the bottom of any box the day is drawn
			// in, which is the whole point: it has to be reachable.
			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			await page.getByLabel('Notes').fill('Last orders');
			// 10 PM: "1" waits to see whether it is one, ten, eleven or twelve.
			await page.getByLabel('Start hour').click();
			await page.keyboard.type('10');
			await page.getByLabel('Start meridiem').click();
			await page.keyboard.type('p');
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
			await page.getByLabel('Notes').fill('Sunrise swim');
			await page.getByLabel('Start hour').click();
			await page.keyboard.type('9');
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
			await page.getByLabel('Notes').fill('Long lunch');
			// Wait for the day that comes back after the save, not just the block:
			// the block is drawn at once from the draft, and a flick that lands on
			// the draft is racing the saved copy that replaces it.
			let posted = false;
			const saved = page.waitForResponse((r) => {
				const path = new URL(r.url()).pathname;
				if (r.request().method() === 'POST' && path.endsWith('/schedule/events')) posted = true;
				return posted && r.request().method() === 'GET' && path.endsWith('/schedule');
			});
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();
			await saved;

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
			await page.getByLabel('Notes').fill('Harbour rooms');
			await page.getByLabel('Check out').fill(day3);
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();

			const chip = page.getByRole('button', { name: /Harbour rooms\. Show on the map/ });
			const chipEdit = page.getByRole('button', { name: 'Edit Harbour rooms' });
			await expect(chip).toBeVisible();

			// The second night it covers, where it is a band just the same.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day2}&view=day`);
			await expect(chip).toBeVisible();

			// The morning of checkout is still spent in the room.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day3}&view=day`);
			await expect(chip).toBeVisible();

			// Shortened from the second day, which then becomes its checkout morning.
			// The band's own click aims the map, so the edit comes off the pencil.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day2}&view=day`);
			await chipEdit.click();
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

/**
 * The add dialog, which is where a block gets the two things it could only be
 * given after the fact.
 *
 * A journey's mode used to be settable only by saving the block and reopening
 * it, and an unnamed block used to be previewed as "New event" and then renamed
 * by the server the moment it was saved. Both are about the dialog agreeing
 * with what is stored, so both are checked against the board after the save
 * rather than against the form.
 */
test.describe('add event', () => {
	test('a journey keeps the mode it was added with, and an unnamed block is called what it is', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			const dialog = page.getByRole('dialog');

			// The mode field belongs to journeys and to nothing else.
			await expect(dialog.getByRole('button', { name: 'Mode' })).toHaveCount(0);
			await dialog.getByRole('button', { name: 'Type' }).click();
			await page.getByRole('option', { name: 'Travel' }).click();
			await dialog.getByRole('button', { name: 'Mode' }).click();
			await page.getByRole('option', { name: 'Ferry' }).click();

			// No place and no notes, so the name is the type's own noun. The preview
			// says so before the save, which is the half that used to be wrong.
			await expect(page.getByRole('button', { name: /^Travel, / })).toBeVisible();

			await page.getByRole('button', { name: copy.common.add, exact: true }).click();
			await expect(dialog).toHaveCount(0);

			// And still says so after it, rather than the block renaming itself.
			const block = page.getByRole('button', { name: /^Travel, 9:00 AM to 10:00 AM/ });
			await expect(block).toBeVisible();

			// The mode reached the server on the create, so reopening the block finds
			// it already set rather than empty.
			await page.getByRole('button', { name: 'Edit Travel' }).click();
			await expect(page.getByRole('button', { name: 'Mode' })).toContainText('Ferry');
		} finally {
			fixture.teardown();
		}
	});

	test('puts the block on the day its date field names', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		const next = new Date(`${startDate}T00:00:00Z`);
		next.setUTCDate(next.getUTCDate() + 1);
		const tomorrow = next.toISOString().slice(0, 10);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			// Adding and editing are one dialog, so adding can say which day the
			// block is for. While they were two, the add form had no date at all and
			// a block could only reach another day by being dragged there.
			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			const dialog = page.getByRole('dialog');
			await dialog.getByLabel(copy.schedule.fields.date).fill(tomorrow);
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();
			await expect(dialog).toHaveCount(0);

			await expect(page.locator(`.daypanel[data-day="${startDate}"] .block`)).toHaveCount(0);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${tomorrow}&view=day`);
			await expect(page.getByRole('button', { name: /^Activity, / })).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});
});

/**
 * The agenda reads down a column of times, so the times have to make one.
 */
test.describe('the agenda', () => {
	test('every title starts at the same edge whatever width its time is', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		try {
			// Hours either side of the one-digit to two-digit boundary, and both
			// meridiems, which between them are every width the clock prints.
			for (const [start, title] of [
				[9 * 60, 'Nine'],
				[10 * 60, 'Ten'],
				[11 * 60 + 30, 'Eleven thirty'],
				[12 * 60, 'Noon'],
				[19 * 60, 'Seven']
			] as const) {
				const res = await apiSend(
					request,
					fixture,
					'POST',
					`/trips/${fixture.tripId}/schedule/events`,
					{ day, type: 'activity', start, duration: 45, title }
				);
				expect(res.status(), await res.text()).toBeLessThan(300);
			}

			await signIn(page, fixture.sessionCookie);

			for (const width of [1440, 390]) {
				await page.setViewportSize({ width, height: 900 });
				await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=agenda`);
				await expect(page.locator('.agendarow')).toHaveCount(5);

				const edges = await page
					.locator('.agendarow .agendawhat')
					.evaluateAll((els) => [
						...new Set(els.map((el) => el.getBoundingClientRect().left.toFixed(2)))
					]);

				// One edge, not one per hour width. Tabular figures alone left four.
				expect(edges, `titles are ragged at ${width}px`).toHaveLength(1);

				// And the time is never cut off to buy that alignment.
				const clipped = await page
					.locator('.agendarow .agendawhen')
					.evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).length);
				expect(clipped, `a time is clipped at ${width}px`).toBe(0);
			}
		} finally {
			fixture.teardown();
		}
	});
});

/**
 * The editor stands beside the board rather than over it, so its width is a
 * fraction of the viewport. That fraction has to stay wide enough for what it
 * holds: at 40vw with no floor, the start and end times fell onto two lines
 * through the first eighty pixels of the range where the panel peeks at all.
 */
test.describe('the peeking editor', () => {
	test('keeps the start and end times on one line at every peeking width', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		try {
			const res = await apiSend(
				request,
				fixture,
				'POST',
				`/trips/${fixture.tripId}/schedule/events`,
				{ day, type: 'activity', start: 9 * 60, duration: 60, title: 'Museum' }
			);
			expect(res.status(), await res.text()).toBeLessThan(300);

			await signIn(page, fixture.sessionCookie);

			// 1100 is where peeking starts, and the widths just above it are the
			// ones that used to wrap.
			for (const width of [1100, 1140, 1180, 1280, 1440]) {
				await page.setViewportSize({ width, height: 900 });
				await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);
				await page.getByRole('button', { name: 'Edit Museum' }).click();

				const pair = page.locator('.tfpair');
				await expect(pair).toBeVisible();
				await expect(page.locator('.modal.peek')).toBeVisible();

				const rows = await pair
					.locator('.tfield')
					.evaluateAll((els) => [
						...new Set(els.map((el) => Math.round(el.getBoundingClientRect().top)))
					]);
				expect(rows, `the end time wrapped at ${width}px`).toHaveLength(1);
			}
		} finally {
			fixture.teardown();
		}
	});
});

/**
 * A block is named by what it is about: the place, the first line of the notes,
 * or the type's own noun. The Label field is the override for when none of
 * those reads well, so what it has to get right is both directions: a typed
 * label wins over the derived name, and clearing it hands the name back rather
 * than leaving the block called whatever it was called at the time.
 */
test.describe('the label', () => {
	test('names the block, and clearing it hands the name back to the place', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		try {
			const cityId = await addCity(request, fixture, {
				name: 'Lisbon',
				country: 'Portugal',
				tz: 'Europe/Lisbon'
			});
			await addPlace(request, fixture, { cityId, name: 'Museum' });
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			const dialog = page.getByRole('dialog');
			// The place field is named after the type, so on a fresh Activity block
			// the picker is called "Activity".
			await dialog.getByRole('combobox', { name: 'Activity' }).click();
			await page.getByRole('option', { name: 'Museum' }).click();

			// Empty, and showing the name the block would get, rather than that name
			// typed in as if somebody had chosen it.
			const label = dialog.getByLabel(/^Label/);
			await expect(label).toHaveValue('');
			await expect(label).toHaveAttribute('placeholder', 'Museum');

			await label.fill('Tile museum');
			// The preview is the block as it will be saved, label included.
			await expect(page.getByRole('button', { name: /^Tile museum, / })).toBeVisible();

			await page.getByRole('button', { name: copy.common.add, exact: true }).click();
			await expect(dialog).toHaveCount(0);

			const block = page.getByRole('button', { name: /^Tile museum, 9:00 AM/ });
			await expect(block).toBeVisible();

			// Reopening finds the label as typed, because it is the block's name and
			// not a derived one.
			await page.getByRole('button', { name: 'Edit Tile museum' }).click();
			const editing = page.getByRole('dialog');
			await expect(editing.getByLabel(/^Label/)).toHaveValue('Tile museum');

			// Cleared, the name goes back to the place the block is still at. The
			// save sends no place, so this is the server deriving from what the
			// event already links to rather than from this body alone.
			await editing.getByLabel(/^Label/).fill('');
			await page.getByRole('button', { name: copy.common.save, exact: true }).click();
			await expect(editing).toHaveCount(0);
			await expect(page.getByRole('button', { name: /^Museum, 9:00 AM/ })).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});
});

/**
 * Discover files a place as an attraction or as food, and the schedule's place
 * picker used to ignore that: every saved place was offered whatever was being
 * scheduled, so booking dinner meant reading past the museums.
 */
test.describe('the place picker', () => {
	test('offers the kind of place the block is, and drops a pick the new type cannot hold', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		try {
			const cityId = await addCity(request, fixture, {
				name: 'Lisbon',
				country: 'Portugal',
				tz: 'Europe/Lisbon'
			});
			await addPlace(request, fixture, { cityId, name: 'Museum', kind: 'attraction' });
			await addPlace(request, fixture, { cityId, name: 'Taberna', kind: 'food' });
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			const dialog = page.getByRole('dialog');

			// An activity offers the attractions and nothing else.
			await dialog.getByRole('combobox', { name: 'Activity' }).click();
			await expect(page.getByRole('option', { name: 'Museum' })).toBeVisible();
			await expect(page.getByRole('option', { name: 'Taberna' })).toHaveCount(0);
			await page.getByRole('option', { name: 'Museum' }).click();

			// Made food, it offers the food, and the museum it was holding goes:
			// a pick the list no longer offers would read blank and still save.
			await dialog.getByRole('button', { name: 'Type' }).click();
			await page.getByRole('option', { name: 'Food & Drinks' }).click();
			const picker = dialog.getByRole('combobox', { name: 'Food & Drinks' });
			await expect(picker).toHaveValue('');
			await picker.click();
			await expect(page.getByRole('option', { name: 'Taberna' })).toBeVisible();
			await expect(page.getByRole('option', { name: 'Museum' })).toHaveCount(0);
			await page.getByRole('option', { name: 'Taberna' }).click();

			// A journey ends wherever it ends, so it offers both.
			await dialog.getByRole('button', { name: 'Type' }).click();
			await page.getByRole('option', { name: 'Travel' }).click();
			await dialog.getByRole('combobox', { name: 'Ends at' }).click();
			await expect(page.getByRole('option', { name: 'Museum' })).toBeVisible();
			await expect(page.getByRole('option', { name: 'Taberna' })).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	/*
	 * The reason the field is typable at all: the restaurant chosen on the
	 * pavement is not in Discover and is not worth adding to it for one meal. A
	 * typed name names the block and nothing more, so it stays off the map, which
	 * is the honest record of a place nobody has geocoded.
	 */
	test('keeps a location that was typed rather than picked', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		try {
			const cityId = await addCity(request, fixture, {
				name: 'Lisbon',
				country: 'Portugal',
				tz: 'Europe/Lisbon'
			});
			await addPlace(request, fixture, { cityId, name: 'Castelo', kind: 'attraction' });
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			const dialog = page.getByRole('dialog');
			const picker = dialog.getByRole('combobox', { name: 'Activity' });
			await picker.fill('Bar da Esquina');
			// Nothing saved matches, and the box says so rather than looking broken.
			await expect(page.locator('.sdropnote')).toBeVisible();
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();

			// Named after what was typed, exactly as a picked place would name it.
			const block = page.getByRole('button', { name: /^Bar da Esquina, / });
			await expect(block).toBeVisible();

			// And it comes back when the block is reopened, which is only true if it
			// was stored rather than spent on the title.
			await settled(page);
			await page.getByRole('button', { name: 'Edit Bar da Esquina' }).click();
			await expect(dialog.getByRole('combobox', { name: 'Activity' })).toHaveValue(
				'Bar da Esquina'
			);

			// Picking a saved place over it replaces it: the two are one field.
			await dialog.getByRole('combobox', { name: 'Activity' }).click();
			await page.getByRole('option', { name: 'Castelo' }).click();
			await page.getByRole('button', { name: copy.common.save, exact: true }).click();
			await expect(page.getByRole('button', { name: /^Castelo, / })).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	/*
	 * Search is the way out of the typed-name compromise: a place nobody
	 * shortlisted can be found on the provider from the calendar itself, in the
	 * same list and the same gesture as picking somewhere already saved, and
	 * what comes back is a real saved place with coordinates rather than a name
	 * on a block. The provider itself is stubbed, because a live lookup here is
	 * billed, slow and moves under the test's feet.
	 */
	test('searches the provider and links what it adds', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		try {
			const cityId = await addCity(request, fixture, {
				name: 'Lisbon',
				country: 'Portugal',
				tz: 'Europe/Lisbon'
			});
			expect(cityId).toBeTruthy();
			await page.route('**/discover/search?**', (route) =>
				route.fulfill({
					json: {
						results: [
							{
								id: 'zz-provider-1',
								name: 'ZZ Cervejaria Ramiro',
								address: 'Av. Almirante Reis 1, Lisbon',
								category: 'restaurant',
								lat: 38.7255,
								lng: -9.1355,
								url: null,
								rating: null,
								ratingCount: null,
								priceLevel: null,
								photo: null,
								hours: null
							}
						]
					}
				})
			);
			await page.route('**/discover/details?**', (route) => route.fulfill({ json: {} }));

			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			await page.getByRole('button', { name: '+ Add', exact: true }).click();
			const dialog = page.getByRole('dialog').first();
			await dialog.getByRole('combobox', { name: 'Activity' }).fill('Ramiro');

			// No second dialog: what the provider knows arrives in the field's own
			// list, under whatever the trip has already saved, with each group
			// named so the two cannot be mistaken for one another.
			const hit = page.getByRole('option', { name: /ZZ Cervejaria Ramiro/ });
			await expect(hit).toBeVisible();
			await expect(page.locator('dialog[open]')).toHaveCount(1);
			await expect(page.locator('.sdrophead')).toHaveText(['Results']);
			// A heading is not something to pick.
			await expect(page.getByRole('option', { name: /^Results$/ })).toHaveCount(0);

			await hit.click();

			// Back in the block, pointing at the place that now exists.
			await expect(dialog.getByRole('combobox', { name: /Activity|Food & Drinks/ })).toHaveValue(
				'ZZ Cervejaria Ramiro'
			);
			await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();
			await expect(page.getByRole('button', { name: /^ZZ Cervejaria Ramiro, / })).toBeVisible();

			// A real saved place, not a name on a block: Discover lists it.
			await page.goto(`/trips/${fixture.tripId}/discover`);
			await expect(page.getByText('ZZ Cervejaria Ramiro').first()).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});
});

/*
 * The board and its map share one colour scheme, and a block carries an edit
 * affordance on hover on top of the whole-block click. These are the parts of
 * that work that can be asserted without eyeballing a screenshot: the pencil
 * exists, stays hidden until the block is hovered and opens the editor; a leg
 * borrows the colour of the event it feeds so the pair reads as one unit; and
 * a stay is plotted among the map pins rather than left off the map.
 */
test.describe('schedule board colour and edit affordance', () => {
	test('a block click focuses the map and the editor opens only from the edit icon', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		try {
			const cityId = await addCity(request, fixture, {
				name: 'Lisbon',
				country: 'Portugal',
				tz: 'Europe/Lisbon'
			});
			const museum = await addPlace(request, fixture, {
				cityId,
				name: 'Museum',
				kind: 'attraction',
				lat: 38.7139,
				lng: -9.1334
			});
			await apiSend(request, fixture, 'POST', `/trips/${fixture.tripId}/schedule/events`, {
				day: startDate,
				cityId,
				type: 'activity',
				start: 540,
				duration: 60,
				poiId: museum
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			// A plain click no longer opens the editor: it selects the block and
			// aims the map at it. The accessible name promises that rather than
			// "Open". The name is on the block's face, the button that fills it;
			// the pencil is a sibling of the face rather than a button inside it.
			const block = page.locator('.sched .block.activity').first();
			const face = block.locator('.bface');
			await expect(block).toBeVisible();
			await expect(face).toHaveAccessibleName(/Show on the map/);
			await expect(face).not.toHaveAccessibleName(/Open/);
			await expect(face.getByRole('button')).toHaveCount(0);

			// The pencil is present but invisible until the block is hovered, which
			// is the board's reveal-on-hover idiom rather than a permanent control.
			// Checked before any click, since clicking focuses the block and reveals
			// the pencil through `:focus-within` (the keyboard path, tested below).
			const edit = block.getByRole('button', { name: 'Edit Museum' });
			await expect
				.poll(async () => await edit.evaluate((el) => getComputedStyle(el).opacity))
				.toBe('0');
			await block.hover();
			await expect
				.poll(async () => Number(await edit.evaluate((el) => getComputedStyle(el).opacity)))
				.toBeGreaterThan(0);

			// The click itself focuses the map and does not open the editor.
			await block.click();
			await expect(page.getByRole('dialog')).toHaveCount(0);

			// Editing is the pencil's job now. By mouse: clicking it opens the
			// editor, Delete button and all.
			await edit.click();
			const dialog = page.getByRole('dialog');
			await expect(dialog).toBeVisible();
			await expect(dialog.getByRole('button', { name: copy.common.delete })).toBeVisible();

			// And by keyboard: on a fresh load, focusing the pencil and pressing
			// Enter opens the same editor, so the icon is not a mouse-only control.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);
			const edit2 = page
				.locator('.sched .block.activity')
				.first()
				.getByRole('button', { name: 'Edit Museum' });
			await edit2.focus();
			await page.keyboard.press('Enter');
			await expect(page.getByRole('dialog')).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('a leg carries the colour of the event it feeds', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		try {
			const cityId = await addCity(request, fixture, {
				name: 'Lisbon',
				country: 'Portugal',
				tz: 'Europe/Lisbon',
				lat: 38.7223,
				lng: -9.1393
			});
			const museum = await addPlace(request, fixture, {
				cityId,
				name: 'Museum',
				kind: 'attraction',
				lat: 38.7139,
				lng: -9.1334
			});
			const taberna = await addPlace(request, fixture, {
				cityId,
				name: 'Taberna',
				kind: 'food',
				lat: 38.7075,
				lng: -9.1364
			});
			const ev = (data: Record<string, unknown>) =>
				apiSend(request, fixture, 'POST', `/trips/${fixture.tripId}/schedule/events`, {
					day: startDate,
					cityId,
					...data
				});
			await ev({ type: 'activity', start: 540, duration: 60, poiId: museum });
			// A second located stop far enough away that a walking leg is planned
			// into it; the leg arrives at a food event.
			await ev({ type: 'food', start: 780, duration: 90, poiId: taberna });
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			const leg = page.locator('.sched .block.leg').first();
			await expect(leg).toBeVisible();

			// The leg takes the arrival event's type class, so its left border is
			// the food colour rather than the old fixed travel blue.
			await expect(leg).toHaveClass(/\bfood\b/);
			const legBorder = await leg.evaluate((el) => getComputedStyle(el).borderLeftColor);
			const foodBorder = await page
				.locator('.sched .block.food:not(.leg)')
				.first()
				.evaluate((el) => getComputedStyle(el).borderLeftColor);
			expect(legBorder).toBe(foodBorder);
		} finally {
			fixture.teardown();
		}
	});

	test('a stay is plotted among the map pins', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		try {
			const cityId = await addCity(request, fixture, {
				name: 'Lisbon',
				country: 'Portugal',
				tz: 'Europe/Lisbon',
				lat: 38.7223,
				lng: -9.1393
			});
			const lodging = await addStay(request, fixture, {
				cityId,
				name: 'Hotel Central',
				lat: 38.72,
				lng: -9.14
			});
			await apiSend(request, fixture, 'POST', `/trips/${fixture.tripId}/schedule/events`, {
				day: startDate,
				cityId,
				type: 'stay',
				poiId: lodging,
				endDay: null
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			// Offline test runs have no maps key, so the Leaflet fallback renders and
			// the stay is a `.wp-pin` carrying its title. Its presence is the point:
			// stays used to be left off the map entirely.
			await expect(page.locator('.wp-pin[title="Hotel Central"]')).toHaveCount(1);
		} finally {
			fixture.teardown();
		}
	});

	test('an unplanned place is a grey pin whose card schedules it', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		try {
			const cityId = await addCity(request, fixture, {
				name: 'Lisbon',
				country: 'Portugal',
				tz: 'Europe/Lisbon',
				lat: 38.7223,
				lng: -9.1393
			});
			const museum = await addPlace(request, fixture, {
				cityId,
				name: 'Museum',
				kind: 'attraction',
				lat: 38.7139,
				lng: -9.1334
			});
			const cafe = await addPlace(request, fixture, {
				cityId,
				name: 'Cafe',
				kind: 'food',
				lat: 38.715,
				lng: -9.135
			});
			await addPlace(request, fixture, {
				cityId,
				name: 'Tram stop',
				kind: 'attraction',
				lat: 38.71,
				lng: -9.13
			});
			for (const [poiId, type, start] of [
				[museum, 'activity', 540],
				[cafe, 'food', 720]
			] as const) {
				await apiSend(request, fixture, 'POST', `/trips/${fixture.tripId}/schedule/events`, {
					day: startDate,
					cityId,
					type,
					start,
					duration: 60,
					poiId
				});
			}
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);

			// A scheduled place wears its block's own colour; an unscheduled one is
			// grey, which is not a type but the absence of one.
			const pinColor = (title: string) =>
				page
					.locator(`.wp-pin[title="${title}"] .wp-pin-body`)
					.evaluate((el) => getComputedStyle(el).getPropertyValue('--pin').trim());
			await expect.poll(() => pinColor('Museum')).toBe('#2f7a4f');
			await expect.poll(() => pinColor('Cafe')).toBe('#c15a25');
			await expect.poll(() => pinColor('Tram stop')).toBe('#9aa39c');

			// A grey pin's card offers the one thing there is to do to it, and the
			// button survives the crossing from the pin: a hovered card waits out a
			// grace period, so the pointer can reach it over the map.
			await page.locator('.wp-pin[title="Tram stop"]').hover();
			const add = page.locator('.mapcard-add');
			await expect(add).toBeVisible();
			await add.hover();
			await expect(add).toBeVisible();
			await add.click();

			// The dialog opens on the shown day with the place already picked, so
			// the whole act is: see it on the map, put it on the day.
			const dialog = page.getByRole('dialog');
			await expect(dialog.getByLabel('Activity')).toHaveValue('Tram stop');
			await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();
			await expect(dialog).toBeHidden();

			// On the board, and no longer grey now that it is planned. The leg that
			// now feeds it wears the same type class, so it is excluded by name:
			// `.leg` is a journey, not the thing arrived at.
			await expect(
				page.locator('.sched .block.activity:not(.leg)').filter({ hasText: 'Tram stop' })
			).toHaveCount(1);
			await expect.poll(() => pinColor('Tram stop')).toBe('#2f7a4f');
		} finally {
			fixture.teardown();
		}
	});
});

/**
 * A block added without pointing at a time is a suggestion, not a decision.
 *
 * Two halves, and both matter: the dialog has to open at the end of the day so
 * far rather than back at nine in the morning, and the block it adds has to
 * keep following whatever ends up in front of it until somebody moves it
 * themselves.
 */
test.describe('a suggested time', () => {
	test('opens at the end of the day and then follows the block before it', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const startDate = fixture.tripBody.startDate;
		const cityId = await addCity(request, fixture, {
			name: 'Athens',
			country: 'Greece',
			arrive: startDate,
			depart: fixture.tripBody.endDate,
			lat: 37.9838,
			lng: 23.7275,
			tz: 'Europe/Athens'
		});
		const museum = await addPlace(request, fixture, {
			cityId,
			name: 'Museum',
			lat: 37.9689,
			lng: 23.7286
		});
		await addPlace(request, fixture, { cityId, name: 'Taverna', lat: 37.9755, lng: 23.7348 });

		const made = await apiSend(
			request,
			fixture,
			'POST',
			`/trips/${fixture.tripId}/schedule/events`,
			{ day: startDate, cityId, type: 'activity', start: 600, duration: 60, poiId: museum }
		);
		expect(made.status(), await made.text()).toBe(201);
		const museumEvent = (await made.json()).id as string;

		await signIn(page, fixture.sessionCookie);
		await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);
		await expect(page.getByRole('button', { name: /^Museum, / })).toBeVisible();

		// The museum runs to 11:00, so that is where the next thing goes.
		await page.getByRole('button', { name: '+ Add', exact: true }).click();
		const dialog = page.getByRole('dialog').first();
		await expect(dialog.getByLabel('Start').first()).toHaveText('11');

		await dialog.getByRole('combobox', { name: 'Activity' }).fill('Taverna');
		await page.getByRole('option', { name: /Taverna/ }).click();
		await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();

		const lunch = page.getByRole('button', { name: /^Taverna, / });
		await expect(lunch).toBeVisible();
		// Not 11:00: the walk between the two is added to the end of the museum.
		await expect(lunch).toHaveAttribute('aria-label', /11:10 AM/);

		// Lengthening the museum carries the suggested block with it, walk and all.
		const res = await apiSend(
			request,
			fixture,
			'POST',
			`/trips/${fixture.tripId}/schedule/events/${museumEvent}/op`,
			{ op: 'resize', endMin: 900 }
		);
		expect(res.status(), await res.text()).toBeLessThan(300);
		await page.reload();
		await expect(page.getByRole('button', { name: /^Taverna, / })).toHaveAttribute(
			'aria-label',
			/3:10 PM/
		);
	});

	test('leaves a block alone once somebody has dragged it', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const startDate = fixture.tripBody.startDate;
		const cityId = await addCity(request, fixture, {
			name: 'Athens',
			country: 'Greece',
			arrive: startDate,
			depart: fixture.tripBody.endDate,
			lat: 37.9838,
			lng: 23.7275,
			tz: 'Europe/Athens'
		});
		const museum = await addPlace(request, fixture, {
			cityId,
			name: 'Museum',
			lat: 37.9689,
			lng: 23.7286
		});
		const taverna = await addPlace(request, fixture, {
			cityId,
			name: 'Taverna',
			lat: 37.9755,
			lng: 23.7348
		});
		const ev = async (data: Record<string, unknown>) => {
			const res = await apiSend(
				request,
				fixture,
				'POST',
				`/trips/${fixture.tripId}/schedule/events`,
				{ day: startDate, cityId, ...data }
			);
			expect(res.status(), await res.text()).toBe(201);
			return (await res.json()).id as string;
		};
		const museumEvent = await ev({ type: 'activity', start: 600, duration: 60, poiId: museum });
		const lunchEvent = await ev({
			type: 'activity',
			start: 660,
			duration: 60,
			poiId: taverna,
			timeAuto: true
		});

		// A drag is somebody choosing a time, so the block stops following.
		await apiSend(
			request,
			fixture,
			'POST',
			`/trips/${fixture.tripId}/schedule/events/${lunchEvent}/op`,
			{ op: 'move', startMin: 1020 }
		);
		await apiSend(
			request,
			fixture,
			'POST',
			`/trips/${fixture.tripId}/schedule/events/${museumEvent}/op`,
			{ op: 'resize', endMin: 900 }
		);

		await signIn(page, fixture.sessionCookie);
		await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);
		await expect(page.getByRole('button', { name: /^Taverna, / })).toHaveAttribute(
			'aria-label',
			/5:00 PM/
		);
	});
});

/**
 * The board is a strip of days that scrolls sideways.
 *
 * Which is three things at once and is tested as three: the day is still the
 * url's, the strip can be travelled with a hand and the url follows where it
 * comes to rest, and a block can be carried onto another date. The date field
 * in the editor is the same move made by typing, so it sits here too.
 */
test.describe('the day strip', () => {
	/** A trip with one placed block, and the ids needed to reach it again. */
	async function seedDay(page: import('@playwright/test').Page, request: APIRequestContext) {
		const fixture = await createApiFixture(request);
		const { startDate, endDate } = fixture.tripBody;
		const cityId = await addCity(request, fixture, {
			name: 'Athens',
			country: 'Greece',
			arrive: startDate,
			depart: endDate,
			lat: 37.9838,
			lng: 23.7275,
			tz: 'Europe/Athens'
		});
		const poiId = await addPlace(request, fixture, {
			cityId,
			name: 'Museum',
			lat: 37.9689,
			lng: 23.7286
		});
		const made = await apiSend(
			request,
			fixture,
			'POST',
			`/trips/${fixture.tripId}/schedule/events`,
			{ day: startDate, cityId, type: 'activity', start: 600, duration: 60, poiId }
		);
		expect(made.status(), await made.text()).toBe(201);
		await signIn(page, fixture.sessionCookie);
		return fixture;
	}

	/** The days the strip currently holds, in order. */
	const panelDays = (page: import('@playwright/test').Page) =>
		page
			.locator('.sched .daypanel')
			.evaluateAll((els) => els.map((el) => el.getAttribute('data-day')));

	test('holds a day either side and opens on the one the url names', async ({ page, request }) => {
		const fixture = await seedDay(page, request);
		const { startDate, endDate } = fixture.tripBody;
		try {
			// A middle day has a neighbour both ways, so the strip is three panels
			// and the url's day is the one in the middle of them.
			const middle = '2027-02-11';
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${middle}&view=day`);
			await expect(page.locator('.sched .daypanel')).toHaveCount(3);
			expect(await panelDays(page)).toEqual([startDate, middle, endDate]);
			await settled(page);
			// Seated on the middle panel, not on the first one the strip drew.
			const seat = await page
				.locator('.sched .boardscroll')
				.evaluate((el) => Math.round(el.scrollLeft / el.clientWidth));
			expect(seat).toBe(1);

			// The first day has nothing before it, so the strip is two panels and
			// starts at the left. The board never shows half of two days.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);
			await expect(page.locator('.sched .daypanel')).toHaveCount(2);
			expect(await panelDays(page)).toEqual([startDate, middle]);
			await settled(page);
			await expect(page.locator('.sched .boardscroll')).toHaveJSProperty('scrollLeft', 0);
		} finally {
			fixture.teardown();
		}
	});

	test('scrolling it renames the day and settles into the url', async ({ page, request }) => {
		const fixture = await seedDay(page, request);
		const { startDate } = fixture.tripBody;
		try {
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);
			await settled(page);
			await expect(page.getByRole('button', { name: /^Museum, / })).toBeVisible();

			// A hand carrying the strip to tomorrow.
			await page.locator('.sched .boardscroll').evaluate((el) => {
				el.scrollLeft = el.clientWidth;
				el.dispatchEvent(new Event('scroll'));
			});

			// The url follows, which is what makes the day shareable and the back
			// button able to walk back out of the trip.
			await expect(page).toHaveURL(/day=2027-02-11/, { timeout: 5000 });
			// And the stepper names the day the reader is on, not the one they left.
			await expect(page.locator('.sched .boardhead')).toContainText('11');
		} finally {
			fixture.teardown();
		}
	});

	test('the editor moves a block to another date', async ({ page, request }) => {
		const fixture = await seedDay(page, request);
		const { startDate } = fixture.tripBody;
		try {
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);
			await page.getByRole('button', { name: 'Edit Museum' }).click();

			const dialog = page.getByRole('dialog').first();
			const date = dialog.getByLabel('Date');
			await expect(date).toHaveValue(startDate);
			// Bounded by the trip, the same way the day arrows are.
			await expect(date).toHaveAttribute('min', startDate);
			await expect(date).toHaveAttribute('max', fixture.tripBody.endDate);

			await date.fill('2027-02-12');
			await dialog.getByRole('button', { name: copy.common.save, exact: true }).click();
			await expect(dialog).toBeHidden();

			// Gone from the day it was on.
			await expect(page.getByRole('button', { name: /^Museum, / })).toHaveCount(0);
			// And on the day it was sent to.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=2027-02-12&view=day`);
			await expect(page.getByRole('button', { name: /^Museum, / })).toBeVisible();
			// The time it was given is the time it keeps: choosing a date is not
			// choosing an hour, so the block lands where it stood.
			await expect(page.getByRole('button', { name: /^Museum, / })).toHaveAttribute(
				'aria-label',
				/10:00 AM/
			);
		} finally {
			fixture.teardown();
		}
	});

	test('a block carried to the right edge lands on the next day', async ({ page, request }) => {
		const fixture = await seedDay(page, request);
		const { startDate } = fixture.tripBody;
		const middle = '2027-02-11';
		try {
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);
			const block = page.getByRole('button', { name: /^Museum, / });
			await expect(block).toBeVisible();
			await block.scrollIntoViewIfNeeded();
			await settled(page);

			const from = (await block.boundingBox())!;
			const box = (await page.locator('.sched .boardscroll').boundingBox())!;
			await page.mouse.move(from.x + from.width / 2, from.y + 20);
			await page.mouse.down();
			// Held against the right edge, which runs the strip through the days
			// while the block stays under the hand.
			await page.mouse.move(box.x + box.width - 8, from.y + 20, { steps: 8 });
			await expect(page.locator('.sched .boardhead')).toContainText('11', { timeout: 5000 });
			await page.mouse.up();

			// The drop sends the block to the day that arrived under it, and takes
			// the reader with it: they are looking at the day they aimed for.
			await expect(page).toHaveURL(new RegExp(`day=${middle}`), { timeout: 5000 });
			await expect(page.getByRole('button', { name: /^Museum, / })).toBeVisible();

			// And it really left the day it started on.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);
			await expect(page.getByRole('button', { name: /^Museum, / })).toHaveCount(0);
		} finally {
			fixture.teardown();
		}
	});

	test('draws hours on a day with nothing on it, and panels of one height', async ({
		page,
		request
	}) => {
		const fixture = await seedDay(page, request);
		const { startDate } = fixture.tripBody;
		try {
			// Only startDate was seeded, so the day after it is free.
			const free = '2027-02-11';
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${free}&view=day`);
			await settled(page);

			// Hours, not a graphic: the grid is the thing you double-click to put
			// something at four o'clock, and a drawing offers nothing to aim at.
			const grid = page.locator(`.sched .daypanel[data-day="${free}"] .daygrid`);
			await expect(grid).toBeVisible();
			await expect(grid.locator('.block')).toHaveCount(0);
			await expect(page.getByText(copy.common.nothingAdded, { exact: true })).toHaveCount(0);

			// And it is the same height as the day beside it, so scrolling the strip
			// does not make the page grow and shrink under the reader.
			const heights = await page
				.locator('.sched .daypanel')
				.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
			expect(new Set(heights).size).toBe(1);
		} finally {
			fixture.teardown();
		}
	});

	test('offers only the day being read to a screen reader', async ({ page, request }) => {
		const fixture = await seedDay(page, request);
		const { startDate, endDate } = fixture.tripBody;
		try {
			// A tester driving the app by the accessibility tree reported that the
			// 11th was showing the 10th's events. It was not: all three panels are
			// in the DOM at once so the strip can scroll, and yesterday's blocks
			// were being announced with today's as one unbroken list. Sighted, you
			// see one day. Unsighted, you were handed three.
			const middle = '2027-02-11';
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${middle}&view=day`);
			await expect(page.locator('.sched .daypanel')).toHaveCount(3);
			await settled(page);

			const inert = await page
				.locator('.sched .daypanel')
				.evaluateAll((els) =>
					els.map((el) => [el.getAttribute('data-day'), (el as HTMLElement).inert])
				);
			expect(inert).toEqual([
				[startDate, true],
				[middle, false],
				[endDate, true]
			]);

			// Which is the same thing as saying a block on a neighbouring day
			// cannot take focus, so the keyboard does not walk off into yesterday.
			const strayed = await page
				.locator(`.sched .daypanel[data-day="${startDate}"] .block`)
				.first()
				.evaluate((el) => {
					const target = el.querySelector('button') ?? (el as HTMLElement);
					(target as HTMLElement).focus();
					return el.contains(document.activeElement);
				});
			expect(strayed).toBe(false);
		} finally {
			fixture.teardown();
		}
	});
});
