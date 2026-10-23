import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createApiFixture, type ApiFixture } from './fixtures/api';
import { addCity, addPlace, addStay, apiSend, seedMembers } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

/**
 * Three things the board drew wrong while it looked right: a journey that did
 * not follow its card while the dialog was open, text on a short block cut off
 * through the middle of a line, and a day's route that began at the first stop
 * instead of the room the day starts in.
 */

/** Wait for the board to stop scrolling; see the twin in `schedule.spec.ts`. */
async function settled(page: Page): Promise<void> {
	await page.waitForFunction(
		() =>
			new Promise<boolean>((done) => {
				const box = document.querySelector('.sched .boardscroll');
				const was = [window.scrollY, box?.scrollTop ?? 0, box?.scrollLeft ?? 0];
				requestAnimationFrame(() =>
					requestAnimationFrame(() =>
						done(
							window.scrollY === was[0] &&
								(box?.scrollTop ?? 0) === was[1] &&
								(box?.scrollLeft ?? 0) === was[2]
						)
					)
				);
			}),
		undefined,
		{ timeout: 5000 }
	);
}

/**
 * Scroll the page so the board's card sits under the site bar, which is where
 * the page settles once a phone has scrolled its chrome away; see `DOCK_QUERY`
 * in `Schedule.tsx`.
 */
async function dock(page: Page): Promise<void> {
	await page.evaluate(() => {
		const card = document.querySelector('.sched .board')!;
		const bar = document.querySelector('header')!.getBoundingClientRect().bottom;
		window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - bar);
	});
	await expect(page.locator('.sched .boardscroll')).not.toHaveAttribute('data-parked');
	await settled(page);
}

async function addEvent(
	request: APIRequestContext,
	fixture: ApiFixture,
	data: Record<string, unknown>
): Promise<string> {
	const res = await apiSend(
		request,
		fixture,
		'POST',
		`/trips/${fixture.tripId}/schedule/events`,
		data
	);
	expect(res.status(), await res.text()).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

/** A city with a cafe, a museum a walk from it, and Belem a drive away. */
async function seedLisbon(request: APIRequestContext, fixture: ApiFixture) {
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
		kind: 'food',
		lat: 38.7075,
		lng: -9.1364
	});
	const museum = await addPlace(request, fixture, {
		cityId,
		name: 'Museum',
		lat: 38.7139,
		lng: -9.1334
	});
	const belem = await addPlace(request, fixture, {
		cityId,
		name: 'Belem',
		lat: 38.6916,
		lng: -9.216
	});
	return { cityId, cafe, museum, belem };
}

type Bar = { text: string; top: number; h: number; tight: boolean };

/** A journey bar as drawn: its words, where it sits and whether it is marked. */
const readBar = (bar: Locator): Promise<Bar> =>
	bar.evaluate((el: HTMLElement) => ({
		text: el.textContent ?? '',
		top: parseFloat(el.style.top),
		h: parseFloat(el.style.height),
		tight: el.classList.contains('tight')
	}));

const blockTop = (page: Page, title: string): Promise<number> =>
	page
		.locator('.daypanel:not([inert]) .block:not(.leg)', { hasText: title })
		.first()
		.evaluate((el: HTMLElement) => parseFloat(el.style.top));

test.describe('a journey follows its card while the dialog is open', () => {
	test('mode, minutes and place move the bar and its warnings, and a cancel puts them back', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		try {
			// A second person, so the board has a "View as" to carry the warning.
			await seedMembers(request, fixture, ['Ana']);
			const { cityId, cafe, museum, belem } = await seedLisbon(request, fixture);
			await addEvent(request, fixture, {
				day,
				cityId,
				type: 'food',
				start: 540,
				duration: 60,
				poiId: cafe
			});
			// Thirty minutes to get from the cafe to the museum.
			await addEvent(request, fixture, {
				day,
				cityId,
				type: 'activity',
				start: 630,
				duration: 60,
				poiId: museum
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);

			const bar = page.locator('.daypanel:not([inert]) .block.leg');
			await expect(bar).toHaveCount(1);
			await settled(page);
			const before = await readBar(bar);
			const arrives = await blockTop(page, 'Museum');
			expect(before.tight).toBe(false);
			const viewAsWarn = page
				.getByRole('button', { name: copy.schedule.viewAsAriaLabel })
				.locator('.warnmark');
			await expect(viewAsWarn).toHaveCount(0);

			const dialog = page.getByRole('dialog');
			const open = async () => {
				await page.getByRole('button', { name: copy.common.editLabel('Museum') }).click();
				await expect(dialog).toBeVisible();
			};
			const card = dialog.locator('.jsec .jrow').first();
			const pickMode = async (mode: string) => {
				await card.locator('.seltrigger').click();
				await dialog.getByRole('option', { name: new RegExp(`^${mode}`) }).click();
			};
			const minutes = card.locator('.jmins');
			const cancel = async () => {
				await dialog.getByRole('button', { name: copy.common.cancel, exact: true }).click();
				await expect(dialog).toHaveCount(0);
			};

			await open();
			// A drive is a different answer from a walk over the same ground.
			await pickMode('Drive');
			await expect.poll(async () => (await readBar(bar)).text).toMatch(/^Drive\b.*\b10m$/);

			// Longer than the gap: the bar fills the gap, and both warnings say so.
			await minutes.fill('45');
			await expect
				.poll(() => readBar(bar))
				.toEqual({
					text: expect.stringMatching(/45m$/),
					top: arrives - 30,
					h: 30,
					tight: true
				});
			await expect(card.locator('.jwarn')).toBeVisible();
			await expect(viewAsWarn).toHaveCount(1);

			// Back inside the gap: anchored to the arrival, and nothing to warn about.
			await minutes.fill('20');
			await expect
				.poll(() => readBar(bar))
				.toEqual({
					text: expect.stringMatching(/20m$/),
					top: arrives - 20,
					h: 20,
					tight: false
				});
			await expect(card.locator('.jwarn')).toHaveCount(0);
			await expect(viewAsWarn).toHaveCount(0);

			await cancel();
			await expect.poll(() => readBar(bar)).toEqual(before);

			// Moving the museum to Belem is a different journey, whatever was routed
			// for the old one: it is re-estimated for the new distance, as a drive.
			await open();
			await dialog.getByRole('combobox').first().dispatchEvent('mousedown');
			await dialog.getByRole('option', { name: /^Belem/ }).click();
			await expect.poll(async () => (await readBar(bar)).text).toMatch(/^Drive\b/);
			await cancel();
			await expect.poll(() => readBar(bar)).toEqual(before);

			// And what the card says is still what is saved.
			await open();
			await pickMode('Drive');
			await minutes.fill('20');
			await dialog.getByRole('button', { name: copy.common.save, exact: true }).click();
			await expect(dialog).toHaveCount(0);
			await expect.poll(async () => (await readBar(bar)).text).toMatch(/^Drive\b.*\b20m$/);
			const res = await apiSend(
				request,
				fixture,
				'GET',
				`/trips/${fixture.tripId}/schedule?day=${day}&view=day`
			);
			const body = (await res.json()) as {
				board: { day: string; legs: { mode: string | null; mins: number | null }[] }[];
			};
			const legs = body.board.find((b) => b.day === day)?.legs ?? [];
			expect(legs.map((l) => [l.mode, l.mins])).toEqual([['drive', 20]]);
		} finally {
			fixture.teardown();
		}
	});

	test('a block being added previews its journey card the same way', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		try {
			const { cityId, cafe } = await seedLisbon(request, fixture);
			await addEvent(request, fixture, {
				day,
				cityId,
				type: 'food',
				start: 540,
				duration: 60,
				poiId: cafe
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);
			const cafeBlock = page.locator('.daypanel:not([inert]) .block:not(.leg)', {
				hasText: 'Cafe'
			});
			await expect(cafeBlock).toBeVisible();
			await settled(page);

			// An hour after the cafe ends, in the empty right-hand side of the lane.
			const lane = await page.locator('.daypanel:not([inert]) .lane').boundingBox();
			const at = await cafeBlock.boundingBox();
			await page.mouse.dblclick(lane!.x + lane!.width - 30, at!.y + at!.height + 60);
			const dialog = page.getByRole('dialog');
			await expect(dialog).toBeVisible();
			await dialog.getByRole('combobox').first().dispatchEvent('mousedown');
			await dialog.getByRole('option', { name: /^Museum/ }).click();

			const bar = page.locator('.daypanel:not([inert]) .block.leg');
			await expect(bar).toHaveCount(1);
			const walked = await readBar(bar);
			expect(walked.text).toMatch(/^Walk\b/);
			await dialog.locator('.jsec .seltrigger').click();
			await dialog.getByRole('option', { name: /^Drive/ }).click();
			await expect.poll(async () => (await readBar(bar)).text).toMatch(/^Drive\b/);
			await dialog.locator('.jsec .jmins').fill('25');
			await expect.poll(async () => (await readBar(bar)).h).toBe(25);

			await dialog.getByRole('button', { name: copy.common.cancel, exact: true }).click();
			await expect(dialog).toHaveCount(0);
			await expect(bar).toHaveCount(0);
		} finally {
			fixture.teardown();
		}
	});

	test('naming a journey and then moving the event pins nothing the reader did not type', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		try {
			const { cityId, cafe, museum } = await seedLisbon(request, fixture);
			await addEvent(request, fixture, {
				day,
				cityId,
				type: 'food',
				start: 540,
				duration: 60,
				poiId: cafe
			});
			await addEvent(request, fixture, {
				day,
				cityId,
				type: 'activity',
				start: 630,
				duration: 60,
				poiId: museum
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);
			const bar = page.locator('.daypanel:not([inert]) .block.leg');
			await expect(bar).toHaveCount(1);
			await settled(page);
			const walked = (await readBar(bar)).text;
			expect(walked).toMatch(/^Walk\b/);

			await page.getByRole('button', { name: copy.common.editLabel('Museum') }).click();
			const dialog = page.getByRole('dialog');
			const card = dialog.locator('.jsec .jrow').first();
			await card.getByLabel(new RegExp(`^${copy.schedule.journey.name}`)).fill('Stroll');
			// Moved to Belem after the rename: the journey is a drive now, and the
			// card and the bar both follow, because only the name was said.
			await dialog.getByRole('combobox').first().dispatchEvent('mousedown');
			await dialog.getByRole('option', { name: /^Belem/ }).click();
			await expect(card.locator('.seltrigger')).toContainText('Drive');
			const minutes = await card.locator('.jmins').inputValue();
			await expect.poll(async () => (await readBar(bar)).text).toBe(`Stroll ${minutes}m`);
			expect(walked).not.toContain(`${minutes}m`);

			await dialog.getByRole('button', { name: copy.common.save, exact: true }).click();
			await expect(dialog).toHaveCount(0);
			await expect.poll(async () => (await readBar(bar)).text).toMatch(/^Stroll \d+m$/);
			// Saved as a name and nothing else: no pinned mode or minutes.
			const res = await apiSend(
				request,
				fixture,
				'GET',
				`/trips/${fixture.tripId}/schedule?day=${day}&view=day`
			);
			const body = (await res.json()) as {
				board: {
					day: string;
					legs: { title: string | null; mode: string | null; mins: number | null }[];
				}[];
			};
			const legs = body.board.find((b) => b.day === day)?.legs ?? [];
			expect(legs.map((l) => [l.title, l.mode, l.mins])).toEqual([['Stroll', null, null]]);
		} finally {
			fixture.teardown();
		}
	});

	test('merging cards and then moving the event pins nothing the reader did not type', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		try {
			const ids = await seedMembers(request, fixture, ['Ana']);
			const { cityId, cafe, museum } = await seedLisbon(request, fixture);
			// Two people at the same cafe in two blocks, then both at the museum:
			// two journeys from one place, which the dialog shows as one card.
			for (const who of [fixture.userId, ids.Ana]) {
				await addEvent(request, fixture, {
					day,
					cityId,
					type: 'food',
					start: 540,
					duration: 60,
					poiId: cafe,
					people: [who]
				});
			}
			await addEvent(request, fixture, {
				day,
				cityId,
				type: 'activity',
				start: 630,
				duration: 60,
				poiId: museum
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);
			const bars = page.locator('.daypanel:not([inert]) .block.leg');
			await expect(bars).toHaveCount(2);
			await settled(page);
			for (const t of await bars.allTextContents()) expect(t).toMatch(/^Walk\b/);

			await page.getByRole('button', { name: copy.common.editLabel('Museum') }).click();
			const dialog = page.getByRole('dialog');
			const cards = dialog.locator('.jsec .jrow');
			await expect(cards).toHaveCount(1);
			await cards.getByRole('button', { name: copy.schedule.journey.split }).click();
			await expect(cards).toHaveCount(2);
			await cards.first().getByRole('button', { name: copy.schedule.journey.merge }).click();
			await expect(cards).toHaveCount(1);

			// Moved to Belem after the merge: both journeys are drives now, at the
			// new estimate, because the merge said nothing about how to get there.
			await dialog.getByRole('combobox').first().dispatchEvent('mousedown');
			await dialog.getByRole('option', { name: /^Belem/ }).click();
			await expect(cards.locator('.seltrigger')).toContainText('Drive');
			const minutes = await cards.locator('.jmins').inputValue();
			await expect
				.poll(async () => (await bars.allTextContents()).map((t) => t.replace(/ from .*? /, ' ')))
				.toEqual([`Drive ${minutes}m`, `Drive ${minutes}m`]);

			await dialog.getByRole('button', { name: copy.common.save, exact: true }).click();
			await expect(dialog).toHaveCount(0);
			const res = await apiSend(
				request,
				fixture,
				'GET',
				`/trips/${fixture.tripId}/schedule?day=${day}&view=day`
			);
			const body = (await res.json()) as {
				board: {
					day: string;
					legs: { title: string | null; mode: string | null; mins: number | null }[];
				}[];
			};
			const legs = body.board.find((b) => b.day === day)?.legs ?? [];
			expect(legs.map((l) => [l.title, l.mode, l.mins])).toEqual([
				[null, null, null],
				[null, null, null]
			]);
		} finally {
			fixture.teardown();
		}
	});
});

test.describe('a short block never cuts a line of text', () => {
	test('15 to 45 minute blocks, after a journey and in narrow lanes, at 1280px and 390px', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		try {
			const { cityId, cafe, museum, belem } = await seedLisbon(request, fixture);
			const ev = (start: number, duration: number, extra: Record<string, unknown>) =>
				addEvent(request, fixture, { day, cityId, type: 'activity', start, duration, ...extra });
			// Back to back, so the journey between them trims the first.
			await ev(540, 15, { poiId: museum, title: 'Fifteen minutes at the museum, a long name' });
			await ev(555, 20, { type: 'food', poiId: cafe, title: 'Twenty minutes of coffee' });
			await ev(600, 30, { poiId: belem, title: 'Thirty minutes at Belem' });
			await ev(660, 45, { poiId: museum, title: 'Forty five minutes back at the museum' });
			// Four side by side, so each has a narrow lane.
			for (const [n, mins] of [
				[1, 15],
				[2, 20],
				[3, 30],
				[4, 45]
			]) {
				await ev(840, mins, { title: `Lane ${n} of four, ${mins} minutes` });
			}
			await signIn(page, fixture.sessionCookie);

			for (const size of [
				{ width: 1280, height: 900 },
				{ width: 390, height: 844 }
			]) {
				await page.setViewportSize(size);
				await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);
				await expect(page.locator('.daypanel:not([inert]) .block:not(.leg)')).toHaveCount(8);
				await settled(page);

				// Every line of text, chip and pencil is either wholly inside its block
				// or wholly hidden. Never part of one.
				const cut = await page.evaluate(() => {
					const out: string[] = [];
					for (const b of document.querySelectorAll<HTMLElement>('.daypanel:not([inert]) .block')) {
						const r = b.getBoundingClientRect();
						const parts = b.querySelectorAll<HTMLElement>('.bt, .bmeta, .bedit, .who');
						for (const el of parts) {
							const e = el.getBoundingClientRect();
							const clip = el.closest('.bwho')?.getBoundingClientRect();
							const bottom = Math.min(r.bottom, clip?.bottom ?? Infinity);
							const whole = e.top >= r.top - 0.5 && e.bottom <= bottom + 0.5;
							const gone = e.top >= bottom - 0.5;
							if (!whole && !gone) {
								out.push(`${b.querySelector('.bt')?.textContent}: ${el.className}`);
							}
						}
					}
					return out;
				});
				expect(cut, `${size.width}px`).toEqual([]);

				// The fifteen minute block is one line, its title alone; thirty is one
				// line with its time beside the title.
				const short = page.locator('.daypanel:not([inert]) .block:not(.leg)', {
					hasText: 'Fifteen minutes at the museum'
				});
				await expect(short).toHaveClass(/\boneline\b/);
				await expect(short.locator('.bmeta')).toHaveCount(0);
				if (size.width > 1000) {
					const thirty = page.locator('.daypanel:not([inert]) .block:not(.leg)', {
						hasText: 'Thirty minutes at Belem'
					});
					await expect(thirty).toHaveClass(/\boneline\b/);
					await expect(thirty.locator('.bmeta')).toHaveCount(1);
				}
				expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
					size.width
				);
			}
		} finally {
			fixture.teardown();
		}
	});
});

test.describe("the day's route starts at the stay", () => {
	test("the line runs from last night's room to stop 1, and the room is not a stop", async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		const morning = '2027-02-11';
		try {
			const { cityId, cafe, museum } = await seedLisbon(request, fixture);
			const hotel = await addStay(request, fixture, {
				cityId,
				name: 'Hotel Central',
				lat: 38.72,
				lng: -9.14
			});
			await addEvent(request, fixture, {
				day: startDate,
				cityId,
				type: 'stay',
				poiId: hotel,
				endDay: morning
			});
			for (const d of [startDate, morning]) {
				await addEvent(request, fixture, {
					day: d,
					cityId,
					type: 'activity',
					start: 600,
					duration: 60,
					poiId: museum
				});
				await addEvent(request, fixture, {
					day: d,
					cityId,
					type: 'food',
					start: 720,
					duration: 60,
					poiId: cafe
				});
			}
			await signIn(page, fixture.sessionCookie);

			/** The route's corners in page pixels, and where the stay's pin points. */
			const read = () =>
				page.evaluate(() => {
					const path = document.querySelector<SVGPathElement>('.leaflet-overlay-pane path');
					const ctm = path?.getScreenCTM();
					const nums = (path?.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
					const corners: [number, number][] = [];
					for (let i = 0; ctm && i + 1 < nums.length; i += 2) {
						const [x, y] = [nums[i], nums[i + 1]];
						corners.push([x * ctm.a + y * ctm.c + ctm.e, x * ctm.b + y * ctm.d + ctm.f]);
					}
					const pin = document.querySelector('.wp-pin[title="Hotel Central"]');
					const r = pin?.getBoundingClientRect();
					return {
						corners,
						stay: r ? [r.left + r.width / 2, r.bottom] : null,
						stayNumber: pin?.querySelector('b')?.textContent ?? null,
						numbers: [...document.querySelectorAll('.wp-pin b')]
							.map((b) => b.textContent)
							.filter(Boolean)
					};
				});

			// The morning after a night at the hotel: the route leaves the room.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${morning}&view=day`);
			await expect(page.locator('.wp-pin[title="Hotel Central"]')).toHaveCount(1);
			await expect.poll(async () => (await read()).corners.length).toBe(3);
			const after = await read();
			const [sx, sy] = after.stay!;
			const [lx, ly] = after.corners[0];
			expect(Math.hypot(lx - sx, ly - sy)).toBeLessThan(2);
			expect(after.stayNumber).toBe('');
			expect(after.numbers).toEqual(['1', '2']);

			// The day of check-in has no night behind it, so its route starts at
			// stop 1 and the hotel is not joined in.
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${startDate}&view=day`);
			await expect(page.locator('.wp-pin[title="Hotel Central"]')).toHaveCount(1);
			await expect.poll(async () => (await read()).corners.length).toBe(2);
		} finally {
			fixture.teardown();
		}
	});
});

test.describe('the day strip under a finger', () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

	/**
	 * A touch gesture through the browser's own input pipeline, so the strip's
	 * `touch-action` and the vertical pan the browser keeps are both real. The
	 * timestamps are stated rather than taken from the clock, so a slow machine
	 * does not turn a flick into a drag.
	 */
	async function swipe(
		page: Page,
		g: {
			x: number;
			y: number;
			dx: number;
			dy?: number;
			steps: number;
			stepMs: number;
			holdMs?: number;
		}
	) {
		const cdp = await page.context().newCDPSession(page);
		const t0 = Date.now() / 1000;
		const at = (ms: number) => t0 + ms / 1000;
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchStart',
			touchPoints: [{ x: g.x, y: g.y }],
			timestamp: at(0)
		});
		for (let i = 1; i <= g.steps; i++) {
			await page.waitForTimeout(g.stepMs);
			await cdp.send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [{ x: g.x + (g.dx * i) / g.steps, y: g.y + ((g.dy ?? 0) * i) / g.steps }],
				timestamp: at(i * g.stepMs)
			});
		}
		if (g.holdMs) await page.waitForTimeout(g.holdMs);
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchEnd',
			touchPoints: [],
			timestamp: at(g.steps * g.stepMs + (g.holdMs ?? 0) + 5)
		});
		await cdp.detach();
	}

	test('on a phone the board docks at seven tenths of the screen, and the page brings it there', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const first = fixture.tripBody.startDate;
		try {
			// Two people, so the "View as" row is there: the crowded toolbar.
			await seedMembers(request, fixture, ['Wren']);
			await signIn(page, fixture.sessionCookie);
			const strip = page.locator('.sched .boardscroll');
			for (const size of [
				{ width: 390, height: 844 },
				{ width: 375, height: 667 }
			]) {
				await page.setViewportSize(size);
				await page.goto(`/trips/${fixture.tripId}/schedule?day=${first}&view=day`);
				await expect(page.locator(`.daypanel[data-day="${first}"]`)).toBeVisible();
				await page.evaluate(() => document.fonts.ready);
				await settled(page);
				const at = () =>
					strip.evaluate((el) => {
						const r = el.getBoundingClientRect();
						return {
							top: r.top,
							bottom: r.bottom,
							height: r.height,
							hours: el.scrollTop,
							page: window.scrollY,
							parked: el.hasAttribute('data-parked'),
							wide: document.documentElement.scrollWidth - document.documentElement.clientWidth
						};
					});

				// At rest the chrome is above the board and its bottom is below the
				// fold, so a finger on the hours moves the page rather than the hours.
				let r = await at();
				expect(r.bottom, `${size.width}px`).toBeGreaterThan(size.height);
				expect(r.parked).toBe(true);
				const x = size.width / 2;
				await swipe(page, { x, y: size.height - 60, dx: 0, dy: -120, steps: 12, stepMs: 16 });
				await page.waitForTimeout(600);
				const after = await at();
				expect(after.page).toBeGreaterThan(r.page);
				expect(after.hours).toBe(r.hours);

				// Docked under the site bar, the whole box is on screen and it is at
				// least seven tenths of it.
				await dock(page);
				r = await at();
				const bar = await page.evaluate(
					() => document.querySelector('header')!.getBoundingClientRect().bottom
				);
				expect(r.top).toBeGreaterThanOrEqual(bar);
				expect(r.bottom).toBeLessThanOrEqual(size.height);
				expect(r.height / size.height, `${size.width}x${size.height}`).toBeGreaterThanOrEqual(0.7);
				expect(r.wide).toBe(0);

				// And from there the hours are what a finger moves.
				await swipe(page, { x, y: r.top + r.height * 0.6, dx: 0, dy: -150, steps: 12, stepMs: 16 });
				await page.waitForTimeout(600);
				const read = await at();
				expect(read.hours).toBeGreaterThan(r.hours);
				expect(read.page).toBe(r.page);
			}

			// A desktop keeps the box it had: measured to the screen under the
			// chrome, never parked, and the page does not snap.
			await page.setViewportSize({ width: 1280, height: 900 });
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${first}&view=day`);
			await expect(page.locator(`.daypanel[data-day="${first}"]`)).toBeVisible();
			await settled(page);
			await expect(strip).not.toHaveAttribute('data-parked');
			expect(
				await page.evaluate(() => document.documentElement.classList.contains('boarddock'))
			).toBe(false);
		} finally {
			fixture.teardown();
		}
	});

	test('only a deliberate sideways swipe changes the day, and by one', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const first = fixture.tripBody.startDate;
		const next = '2027-02-11';
		try {
			await signIn(page, fixture.sessionCookie);
			const strip = page.locator('.sched .boardscroll');
			/** Opens the first day fresh and says where a finger goes and how wide a day is. */
			const open = async () => {
				await page.goto(`/trips/${fixture.tripId}/schedule?day=${first}&view=day`);
				await expect(page.locator(`.daypanel[data-day="${first}"]`)).toBeVisible();
				await settled(page);
				// Read docked, which is where a phone reads the hours: until then a
				// vertical finger on the board scrolls the page instead.
				await dock(page);
				const box = (await strip.boundingBox())!;
				const w = await page
					.locator('.daypanel')
					.first()
					.evaluate((el) => el.getBoundingClientRect().width);
				// Watch the strip's sideways travel for the whole gesture.
				await strip.evaluate((el) => {
					const s = el.scrollLeft;
					const w = window as unknown as { travel: number; top0: number };
					w.travel = 0;
					w.top0 = el.scrollTop;
					el.addEventListener('scroll', () => {
						w.travel = Math.max(w.travel, Math.abs(el.scrollLeft - s));
					});
				});
				return { x: box.x + box.width * 0.75, y: box.y + Math.min(box.height, 500) * 0.6, w };
			};
			const read = () =>
				strip.evaluate((el) => {
					const w = window as unknown as { travel: number; top0: number };
					return { travel: w.travel, scrolled: el.scrollTop - w.top0, left: el.scrollLeft };
				});
			const reading = page.locator('.daypanel:not([inert])');

			// Down the hours with a sideways wobble: the hours move, the day never does.
			let at = await open();
			await swipe(page, { x: at.x, y: at.y, dx: -18, dy: -220, steps: 20, stepMs: 16 });
			await page.waitForTimeout(600);
			let r = await read();
			expect(r.travel).toBe(0);
			expect(r.scrolled).toBeGreaterThan(100);
			await expect(page).toHaveURL(new RegExp(`day=${first}`));

			// A fifth of a day, slowly, then let go: it springs back.
			at = await open();
			await swipe(page, { x: at.x, y: at.y, dx: -0.2 * at.w, steps: 25, stepMs: 20, holdMs: 150 });
			await expect.poll(async () => (await read()).left).toBe(0);
			expect((await read()).travel).toBeGreaterThan(0.1 * at.w);
			await expect(reading).toHaveAttribute('data-day', first);
			await expect(page).toHaveURL(new RegExp(`day=${first}`));

			// Over a third of a day: the next one.
			at = await open();
			await swipe(page, { x: at.x, y: at.y, dx: -0.45 * at.w, steps: 25, stepMs: 20, holdMs: 150 });
			await expect(page).toHaveURL(new RegExp(`day=${next}`));
			await expect(reading).toHaveAttribute('data-day', next);

			// A short fast flick: the next one too.
			at = await open();
			await swipe(page, { x: at.x, y: at.y, dx: -60, steps: 4, stepMs: 12 });
			await expect(page).toHaveURL(new RegExp(`day=${next}`));

			// A flick across most of the screen still moves one day, and the strip
			// never travelled further than one on the way.
			at = await open();
			await swipe(page, { x: at.x, y: at.y, dx: -1.8 * at.w, steps: 8, stepMs: 10 });
			await expect(page).toHaveURL(new RegExp(`day=${next}`));
			expect((await read()).travel).toBeLessThanOrEqual(at.w + 1);
		} finally {
			fixture.teardown();
		}
	});

	test('the date names the day a move commits to, once, and the arrows never move', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const first = fixture.tripBody.startDate;
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${first}&view=day`);
			await expect(page.locator(`.daypanel[data-day="${first}"]`)).toBeVisible();
			await settled(page);
			const strip = page.locator('.sched .boardscroll');
			const box = (await strip.boundingBox())!;
			const w = await page
				.locator('.daypanel')
				.first()
				.evaluate((el) => el.getBoundingClientRect().width);
			const x = box.x + box.width * 0.75;
			// On screen: at rest a phone's docked box runs on below the fold.
			const y = box.y + Math.min(box.height, 500, page.viewportSize()!.height - box.y) * 0.6;

			/** Every frame from here: the date as written, and where each arrow stands. */
			const watch = () =>
				page.evaluate(() => {
					const w = window as unknown as { seen: { title: string; l: number; r: number }[] };
					w.seen = [];
					const tick = () => {
						const head = document.querySelector('.sched .boardhead')!;
						const [l, r] = [...head.querySelectorAll('.navbtn')].map(
							(b) => b.getBoundingClientRect().left
						);
						w.seen.push({ title: head.querySelector('.curday')!.textContent ?? '', l, r });
						requestAnimationFrame(tick);
					};
					requestAnimationFrame(tick);
				});
			const seen = async () => {
				const frames = await page.evaluate(
					() => (window as unknown as { seen: { title: string; l: number; r: number }[] }).seen
				);
				const titles: string[] = [];
				for (const f of frames) if (titles[titles.length - 1] !== f.title) titles.push(f.title);
				return {
					titles,
					lefts: [...new Set(frames.map((f) => f.l))],
					rights: [...new Set(frames.map((f) => f.r))]
				};
			};

			// Slowly past halfway, back short of a third, and let go: it springs
			// back, and the date said the day it started on the whole way.
			await watch();
			const cdp = await page.context().newCDPSession(page);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
			const path = [
				...Array.from({ length: 24 }, (_, i) => (-0.65 * w * (i + 1)) / 24),
				...Array.from({ length: 24 }, (_, i) => -0.65 * w + (0.55 * w * (i + 1)) / 24)
			];
			for (const dx of path) {
				await page.waitForTimeout(20);
				await cdp.send('Input.dispatchTouchEvent', {
					type: 'touchMove',
					touchPoints: [{ x: x + dx, y }]
				});
			}
			await page.waitForTimeout(150);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
			await cdp.detach();
			await page.waitForTimeout(800);
			let s = await seen();
			expect(s.titles).toHaveLength(1);
			expect(s.titles[0]).toContain('10');
			expect(s.lefts).toHaveLength(1);
			expect(s.rights).toHaveLength(1);
			await expect(page).toHaveURL(new RegExp(`day=${first}`));

			// A swipe that goes: the date changes once, to the day it went to, and
			// the arrows are where they were.
			await watch();
			await swipe(page, { x, y, dx: -0.55 * w, steps: 12, stepMs: 16 });
			await expect(page).toHaveURL(/day=2027-02-11/);
			await page.waitForTimeout(800);
			const was = s;
			s = await seen();
			expect(s.titles).toHaveLength(2);
			expect(s.titles[1]).toContain('11');
			expect(s.lefts).toEqual(was.lefts);
			expect(s.rights).toEqual(was.rights);
		} finally {
			fixture.teardown();
		}
	});

	test('a second swipe straight after the first moves the strip and lands a day further', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const first = fixture.tripBody.startDate;
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${first}&view=day`);
			await expect(page.locator(`.daypanel[data-day="${first}"]`)).toBeVisible();
			await settled(page);
			const strip = page.locator('.sched .boardscroll');
			const box = (await strip.boundingBox())!;
			const w = await page
				.locator('.daypanel')
				.first()
				.evaluate((el) => el.getBoundingClientRect().width);
			const x = box.x + box.width * 0.75;
			// On screen: at rest a phone's docked box runs on below the fold.
			const y = box.y + Math.min(box.height, 500, page.viewportSize()!.height - box.y) * 0.6;

			await swipe(page, { x, y, dx: -0.55 * w, steps: 10, stepMs: 16 });
			// The first swipe's slide is still running and its day's payload may
			// not be back: the second must still be taken as a swipe, from the day
			// the first one went to.
			await page.waitForTimeout(100);
			await page.evaluate(() => {
				const w = window as unknown as { held: number; left: number[] };
				const el = document.querySelector<HTMLElement>('.sched .boardscroll')!;
				w.held = 0;
				w.left = [];
				// After the strip's own handler: a move it took is a cancelled one.
				addEventListener('touchmove', (e) => {
					if (e.defaultPrevented) w.held++;
					w.left.push(el.scrollLeft);
				});
			});
			await swipe(page, { x, y, dx: -0.55 * w, steps: 10, stepMs: 16 });
			const moved = await page.evaluate(() => {
				const w = window as unknown as { held: number; left: number[] };
				return { held: w.held, left: w.left };
			});
			// The strip followed the finger...
			expect(moved.held).toBeGreaterThan(5);
			expect(Math.max(...moved.left) - Math.min(...moved.left)).toBeGreaterThan(0.3 * w);
			// ...and the two swipes are two days.
			await expect(page).toHaveURL(/day=2027-02-12/, { timeout: 8000 });
			await expect(page.locator('.daypanel:not([inert])')).toHaveAttribute(
				'data-day',
				'2027-02-12'
			);
			await expect(page.locator('.sched .boardhead .curday')).toContainText('12');
		} finally {
			fixture.teardown();
		}
	});

	/** Where a finger goes on the strip, and how wide a day is. */
	async function aim(page: Page) {
		const box = (await page.locator('.sched .boardscroll').boundingBox())!;
		const w = await page
			.locator('.daypanel')
			.first()
			.evaluate((el) => el.getBoundingClientRect().width);
		return {
			x: box.x + box.width * 0.75,
			// On screen: at rest a phone's docked box runs on below the fold.
			y: box.y + Math.min(box.height, 500, page.viewportSize()!.height - box.y) * 0.6,
			w
		};
	}

	test('a touch while the hours are still moving scrolls them, not the day', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const first = fixture.tripBody.startDate;
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${first}&view=day`);
			await expect(page.locator(`.daypanel[data-day="${first}"]`)).toBeVisible();
			await settled(page);
			const { x, y, w } = await aim(page);
			const strip = page.locator('.sched .boardscroll');
			await strip.evaluate((el) => {
				const s = el.scrollLeft;
				const g = window as unknown as { travel: number };
				g.travel = 0;
				el.addEventListener('scroll', () => {
					g.travel = Math.max(g.travel, Math.abs(el.scrollLeft - s));
				});
			});
			// The hours coasting: a few pixels a frame, which is what a flick's
			// momentum looks like to the page, and not written by the page itself.
			// It goes on through the touch, as momentum does, so a slow machine
			// cannot let it stop before the finger lands.
			const coasted = await strip.evaluate(
				(el) =>
					new Promise<number>((started) => {
						const top = el.scrollTop;
						let n = 0;
						const tick = () => {
							el.scrollTop += 4;
							if (++n === 4) started(el.scrollTop - top);
							if (n < 60) requestAnimationFrame(tick);
						};
						requestAnimationFrame(tick);
					})
			);
			expect(coasted).toBeGreaterThan(0);
			// A clear sideways swipe that lands on them is the scroll being caught.
			await swipe(page, { x, y, dx: -0.55 * w, steps: 10, stepMs: 16 });
			await page.waitForTimeout(600);
			expect(await page.evaluate(() => (window as unknown as { travel: number }).travel)).toBe(0);
			await expect(page).toHaveURL(new RegExp(`day=${first}`));
		} finally {
			fixture.teardown();
		}
	});

	test('a touch straight after the page moves the hours itself can still swipe', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const first = fixture.tripBody.startDate;
		const last = fixture.tripBody.endDate;
		// The middle day starts at nine and the last at five, so arriving on the
		// middle day brings the last into the strip and opens the window an hour
		// earlier: the page scrolls the hours down by that hour to keep them still.
		await addEvent(request, fixture, {
			day: '2027-02-11',
			type: 'activity',
			start: 540,
			duration: 45
		});
		await addEvent(request, fixture, { day: last, type: 'activity', start: 300, duration: 45 });
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${first}&view=day`);
			await expect(page.locator(`.daypanel[data-day="${first}"]`)).toBeVisible();
			await settled(page);
			const { x, y, w } = await aim(page);
			const strip = page.locator('.sched .boardscroll');
			// The reader scrolls the hours a little, so the page's own jump comes a
			// moment after a real scroll: read as movement, it was fast.
			await strip.evaluate((el) => {
				el.scrollTop += 40;
				const g = window as unknown as { rebased: Promise<void> };
				let top = el.scrollTop;
				g.rebased = new Promise((done) =>
					el.addEventListener('scroll', () => {
						if (el.scrollTop - top >= 50) done();
						top = el.scrollTop;
					})
				);
			});
			await swipe(page, { x, y, dx: -0.55 * w, steps: 10, stepMs: 16 });
			await expect(page).toHaveURL(/day=2027-02-11/);
			// The payload lands and the hours are re-based; the next swipe comes
			// straight after, well inside the coasting window.
			await page.evaluate(() => (window as unknown as { rebased: Promise<void> }).rebased);
			await swipe(page, { x, y, dx: -0.55 * w, steps: 10, stepMs: 16 });
			await expect(page).toHaveURL(new RegExp(`day=${last}`), { timeout: 5000 });
		} finally {
			fixture.teardown();
		}
	});

	test('a block lifted by a long press still carries to the next day', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const first = fixture.tripBody.startDate;
		const next = '2027-02-11';
		try {
			await addEvent(request, fixture, {
				day: first,
				type: 'activity',
				start: 600,
				duration: 60,
				title: 'Carried'
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${first}&view=day`);
			const block = page.locator('.daypanel:not([inert]) .block', { hasText: 'Carried' });
			await expect(block).toBeVisible();
			await block.scrollIntoViewIfNeeded();
			await settled(page);
			const from = (await block.boundingBox())!;
			const box = (await page.locator('.sched .boardscroll').boundingBox())!;

			const cdp = await page.context().newCDPSession(page);
			const x = from.x + from.width / 2;
			const y = from.y + 20;
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
			// Held still past the long press, which lifts the block.
			await page.waitForTimeout(700);
			const edge = box.x + box.width - 6;
			for (let i = 1; i <= 8; i++) {
				await cdp.send('Input.dispatchTouchEvent', {
					type: 'touchMove',
					touchPoints: [{ x: x + ((edge - x) * i) / 8, y }]
				});
				await page.waitForTimeout(30);
			}
			await expect(page.locator('.sched .boardhead')).toContainText('11', { timeout: 5000 });
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
			await cdp.detach();
			await expect(page).toHaveURL(new RegExp(`day=${next}`), { timeout: 5000 });
			await expect(
				page.locator(`.daypanel[data-day="${next}"] .block`, { hasText: 'Carried' })
			).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('a payload landing under a finger does not move the strip a day, and the url follows', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		// Five days, so the window of three re-indexes as the reader moves.
		const patch = await apiSend(request, fixture, 'PATCH', `/trips/${fixture.tripId}`, {
			name: fixture.tripBody.name,
			startDate: fixture.tripBody.startDate,
			endDate: '2027-02-14',
			currency: fixture.tripBody.homeCurrency
		});
		expect(patch.status(), await patch.text()).toBe(200);
		try {
			await signIn(page, fixture.sessionCookie);
			const strip = page.locator('.sched .boardscroll');
			await page.goto(`/trips/${fixture.tripId}/schedule?day=2027-02-11&view=day`);
			await expect(page.locator('.daypanel[data-day="2027-02-11"]')).toBeVisible();
			await settled(page);
			// A slow network from here on: every day's payload takes a second and a half.
			await page.route(/\/schedule\?day=/, async (route) => {
				await new Promise((r) => setTimeout(r, 1500));
				// A request the page has given up on in the meantime is already gone.
				await route.continue().catch(() => {});
			});
			const box = (await strip.boundingBox())!;
			const w = await page
				.locator('.daypanel')
				.first()
				.evaluate((el) => el.getBoundingClientRect().width);
			const x = box.x + box.width * 0.75;
			// On screen: at rest a phone's docked box runs on below the fold.
			const y = box.y + Math.min(box.height, 500, page.viewportSize()!.height - box.y) * 0.6;

			/** The url, the panel being read, the stepper and the panel under the strip's seat. */
			const agree = () =>
				page.evaluate(() => {
					const el = document.querySelector<HTMLElement>('.sched .boardscroll')!;
					const panels = [...el.querySelectorAll<HTMLElement>('.daypanel')];
					const w = panels[0].getBoundingClientRect().width;
					return {
						url: new URL(location.href).searchParams.get('day'),
						reading: el.querySelector<HTMLElement>('.daypanel:not([inert])')?.dataset.day,
						seat: panels[Math.round(el.scrollLeft / w)]?.dataset.day,
						stepper: document.querySelector('.sched .boardhead .curday')?.textContent ?? ''
					};
				});

			// One swipe to the 12th; its payload is still on the way.
			await swipe(page, { x, y, dx: -0.45 * w, steps: 12, stepMs: 16 });
			await expect(page).toHaveURL(/day=2027-02-12/);
			await page.waitForTimeout(450);

			// The next swipe starts before it lands, and is still held when it does.
			const landed = page.waitForResponse((r) => r.url().includes('day=2027-02-12'));
			const cdp = await page.context().newCDPSession(page);
			const t0 = Date.now() / 1000;
			await cdp.send('Input.dispatchTouchEvent', {
				type: 'touchStart',
				touchPoints: [{ x, y }],
				timestamp: t0
			});
			for (let i = 1; i <= 12; i++) {
				await page.waitForTimeout(16);
				await cdp.send('Input.dispatchTouchEvent', {
					type: 'touchMove',
					touchPoints: [{ x: x - (0.45 * w * i) / 12, y }],
					timestamp: t0 + (i * 16) / 1000
				});
			}
			await landed;
			await page.waitForTimeout(300);
			await cdp.send('Input.dispatchTouchEvent', {
				type: 'touchEnd',
				touchPoints: [],
				timestamp: Date.now() / 1000
			});
			await cdp.detach();

			// A deliberate swipe from the 12th is the 13th, and everything says so.
			await expect(page).toHaveURL(/day=2027-02-13/);
			await expect.poll(agree, { timeout: 8000 }).toEqual({
				url: '2027-02-13',
				reading: '2027-02-13',
				seat: '2027-02-13',
				stepper: expect.stringContaining('Feb 13')
			});

			// A swipe that only half starts while a slide is still running springs
			// back, and the url names whatever the strip comes to rest on.
			await swipe(page, { x, y, dx: -0.45 * w, steps: 8, stepMs: 12 });
			await swipe(page, { x, y, dx: 30, steps: 4, stepMs: 40, holdMs: 150 });
			await page.unroute(/\/schedule\?day=/);
			await expect
				.poll(
					async () => {
						const a = await agree();
						return (
							a.url === a.reading &&
							a.url === a.seat &&
							a.stepper.includes(`Feb ${Number(a.url?.slice(-2))}`)
						);
					},
					{ timeout: 8000 }
				)
				.toBe(true);
		} finally {
			fixture.teardown();
		}
	});
});

test.describe('each fact once', () => {
	test('a long journey says when to leave, and a lone card does not repeat who is going', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		try {
			await seedMembers(request, fixture, ['Ana']);
			const { cityId, cafe, belem } = await seedLisbon(request, fixture);
			await addEvent(request, fixture, {
				day,
				cityId,
				type: 'food',
				start: 540,
				duration: 60,
				poiId: cafe
			});
			await addEvent(request, fixture, {
				day,
				cityId,
				type: 'activity',
				start: 720,
				duration: 60,
				poiId: belem
			});
			// An hour's drive, pinned, so the bar is tall enough for its meta row.
			const res = await apiSend(
				request,
				fixture,
				'GET',
				`/trips/${fixture.tripId}/schedule?day=${day}&view=day`
			);
			const body = (await res.json()) as { board: { day: string; legs: { id: string }[] }[] };
			const leg = body.board.find((b) => b.day === day)!.legs[0];
			const pin = await apiSend(
				request,
				fixture,
				'PATCH',
				`/trips/${fixture.tripId}/schedule/legs/${leg.id}`,
				{
					mode: 'drive',
					mins: 60,
					title: ''
				}
			);
			expect(pin.status(), await pin.text()).toBe(200);
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);

			// Leave at 11, an hour: the arrival at noon is the block's own start.
			const meta = page.locator('.daypanel:not([inert]) .block.leg .bmeta');
			await expect(meta).toHaveText(/^11:00 AM\s*60m$/);

			// The dialog's dates are its Start and End fields, not a subtitle too;
			// one card for everybody does not name them again; minutes are a number.
			await page.getByRole('button', { name: copy.common.editLabel('Belem') }).click();
			const dialog = page.getByRole('dialog');
			await expect(dialog.locator('.msub')).toHaveCount(0);
			await expect(dialog.locator('.jhead')).toHaveText(copy.schedule.journey.heading);
			const card = dialog.locator('.jrow');
			await expect(card).toHaveCount(1);
			await expect(card.locator('.jwho')).toHaveCount(0);
			await expect(card).toHaveAttribute(
				'aria-label',
				copy.schedule.journey.groupLabel(copy.common.everyone)
			);
			await expect(card.locator('.jminsf')).toHaveText(copy.schedule.journey.minutes);
		} finally {
			fixture.teardown();
		}
	});
});
