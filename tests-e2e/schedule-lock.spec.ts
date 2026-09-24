import { expect, test, type Page } from '@playwright/test';
import { apiURL, createApiFixture } from './fixtures/api';
import { addCity, addPlace } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

/**
 * The schedule lock, from the organizer's side.
 *
 * The server refusal is covered by the API tests. What is worth a browser is
 * the shape of the page after the switch goes on: the board is still readable
 * and still openable, and every way into an edit has gone rather than staying
 * put and failing on save.
 */
test.describe('schedule lock', () => {
	test('freezes the board and thaws it again', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			const day = fixture.tripBody.startDate;
			const created = await request.post(`${apiURL}/trips/${fixture.tripId}/schedule/events`, {
				headers: { cookie: fixture.sessionCookie },
				data: { day, start: 600, end: 660, type: 'activity', title: 'Museum' }
			});
			expect(created.status()).toBe(201);

			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);
			const add = page.getByRole('button', { name: copy.schedule.add, exact: true });
			await expect(add).toBeVisible();

			await lock(page, true);
			await expect(page.getByText(copy.schedule.lock.tag)).toBeVisible();
			await expect(add).toHaveCount(0);
			await expect(page.locator('.bedit')).toHaveCount(0);
			await expect(page.locator('.bresize')).toHaveCount(0);
			// The plan is still there to be read. That is the point of locking it.
			await expect(page.getByText('Museum')).toBeVisible();

			// And still there to be opened: with the pencil gone, the block itself is
			// the way into its own details, and what opens cannot be written to.
			// Named, not `.block.first()`: a journey is a `.block` too, and on a day
			// with one it is drawn before the event it arrives at.
			await page.getByRole('button', { name: /^Museum, / }).click();
			const frozen = page.getByRole('dialog');
			await expect(frozen).toBeVisible();
			await expect(frozen.getByRole('button', { name: copy.common.save, exact: true })).toHaveCount(
				0
			);
			await expect(frozen.getByText(copy.schedule.lock.tag)).toBeVisible();
			await frozen
				.locator('.mfoot')
				.getByRole('button', { name: copy.ui.modal.closeLabel, exact: true })
				.click();
			await expect(page.getByRole('dialog')).toHaveCount(0);

			await lock(page, false);
			await expect(page.getByText(copy.schedule.lock.tag)).toHaveCount(0);
			await expect(add).toBeVisible();
			await expect(page.locator('.bedit')).toHaveCount(1);
		} finally {
			fixture.teardown();
		}
	});

	test('a block dragged before the lock still opens on a click after it', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			const day = fixture.tripBody.startDate;
			const created = await request.post(`${apiURL}/trips/${fixture.tripId}/schedule/events`, {
				headers: { cookie: fixture.sessionCookie },
				data: { day, start: 600, duration: 60, type: 'activity', title: 'Museum' }
			});
			expect(created.status()).toBe(201);

			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);
			const block = page.getByRole('button', { name: /^Museum, / });
			await expect(block).toHaveAttribute('aria-label', /10:00 AM/);
			await settled(page);

			// A real drag, an hour down the board, which leaves the board's "that was
			// a drag" flag raised behind it.
			const box = await block.evaluate((el) => {
				const r = el.getBoundingClientRect();
				return { x: r.x + r.width / 2, y: r.y + 12 };
			});
			await page.mouse.move(box.x, box.y);
			await page.mouse.down();
			await page.mouse.move(box.x, box.y + 60, { steps: 8 });
			await page.mouse.up();
			await expect(block).toHaveAttribute('aria-label', /11:00 AM/);

			await lock(page, true);
			// The first click after the lock is the one the stale flag used to eat.
			await block.click();
			const frozen = page.getByRole('dialog');
			await expect(frozen).toBeVisible();
			await expect(frozen.getByText(copy.schedule.lock.tag)).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('the read-only dialog still scrolls on a phone', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			const day = fixture.tripBody.startDate;
			// A block with a journey arriving at it, so the dialog holds the whole
			// form and a "Getting here" card under it: more than a phone shows.
			const cityId = await addCity(request, fixture, {
				name: 'Lisbon',
				country: 'Portugal',
				tz: 'Europe/Lisbon',
				lat: 38.7223,
				lng: -9.1393
			});
			const cafe = await addPlace(request, fixture, {
				cityId,
				name: 'Cafe',
				lat: 38.7075,
				lng: -9.1364
			});
			const museum = await addPlace(request, fixture, {
				cityId,
				name: 'Museum',
				lat: 38.7139,
				lng: -9.1334
			});
			for (const [poiId, start] of [
				[cafe, 480],
				[museum, 600]
			] as const) {
				const created = await request.post(`${apiURL}/trips/${fixture.tripId}/schedule/events`, {
					headers: { cookie: fixture.sessionCookie },
					data: { day, cityId, start, duration: 60, type: 'activity', poiId, notes: 'Tickets' }
				});
				expect(created.status()).toBe(201);
			}

			await page.setViewportSize({ width: 390, height: 640 });
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);
			await lock(page, true);

			await page.getByRole('button', { name: /^Museum, / }).click();
			const frozen = page.getByRole('dialog');
			await expect(frozen).toBeVisible();
			const body = frozen.locator('.mbody');
			await expect(frozen.locator('.jrow')).toHaveCount(1);
			// The body is the scroll box, so it must not be the thing made inert.
			expect(await body.evaluate((el) => (el as HTMLElement).inert)).toBe(false);
			const room = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
			expect(room).toBeGreaterThan(0);

			const at = await body.evaluate((el) => {
				const r = el.getBoundingClientRect();
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
			});
			await page.mouse.move(at.x, at.y);
			await page.mouse.wheel(0, 400);
			await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

			// Nothing in it takes input, which is what the lock promises.
			await expect(frozen.locator('.mbody [inert]').first()).toBeAttached();
			// And no horizontal overflow on the phone.
			const wide = await body.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
			expect(wide).toBe(false);

			// The footer is the Locked tag and nothing else: on a phone the Close
			// would repeat the header's X, which is the way out.
			const foot = frozen.locator('.mfoot');
			await expect(foot.getByText(copy.schedule.lock.tag)).toBeVisible();
			await expect(
				foot.getByRole('button', { name: copy.ui.modal.closeLabel, exact: true })
			).toBeHidden();
			await expect(foot.getByRole('button')).toHaveCount(0);
			await frozen
				.locator('.mhead')
				.getByRole('button', { name: copy.ui.modal.closeLabel, exact: true })
				.click();
			await expect(page.getByRole('dialog')).toHaveCount(0);
		} finally {
			fixture.teardown();
		}
	});
});

async function settled(page: Page): Promise<void> {
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

async function lock(page: Page, on: boolean): Promise<void> {
	await page.getByRole('button', { name: copy.tripShell.editTrip }).click();
	const box = page.getByLabel(copy.tripShell.editDialog.lockLabel);
	if (on) await box.check();
	else await box.uncheck();
	await page.getByRole('button', { name: copy.common.save, exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
}
