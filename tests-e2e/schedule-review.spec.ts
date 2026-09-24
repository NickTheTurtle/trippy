import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createApiFixture, type ApiFixture } from './fixtures/api';
import { addCity, addPlace, addStay, apiSend } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn, signedInContext } from './fixtures/session';

/**
 * The review pass over the board's riskiest paths: the ones that write without
 * being asked to, refuse to open, or overwrite somebody else. Each of these was
 * a real defect, and each one breaks silently: nothing on screen says a click
 * just moved a block by two minutes, or that a save just threw away another
 * person's edit.
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

/** One event as the server holds it, read back off the board payload. */
async function storedEvent(
	request: APIRequestContext,
	fixture: ApiFixture,
	day: string,
	id: string
): Promise<{ start_min: number; end_min: number; day: string; title: string } | undefined> {
	const res = await apiSend(
		request,
		fixture,
		'GET',
		`/trips/${fixture.tripId}/schedule?day=${day}&view=day`
	);
	expect(res.status()).toBe(200);
	const body = (await res.json()) as {
		board: {
			events: { id: string; start_min: number; end_min: number; day: string; title: string }[];
		}[];
	};
	return body.board.flatMap((b) => b.events).find((e) => e.id === id);
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

async function setLock(page: Page, on: boolean): Promise<void> {
	await page.getByRole('button', { name: copy.tripShell.editTrip }).click();
	const box = page.getByLabel(copy.tripShell.editDialog.lockLabel);
	if (on) await box.check();
	else await box.uncheck();
	await page.getByRole('button', { name: copy.common.save, exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
}

test.describe('the board writes only what a hand asked for', () => {
	test('a plain click on a block at 9:07 leaves it at 9:07', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		try {
			const id = await addEvent(request, fixture, {
				day,
				type: 'activity',
				start: 9 * 60 + 7,
				duration: 60,
				title: 'Odd minute'
			});
			await signIn(page, fixture.sessionCookie);

			// Every write the board makes goes through `/op`, so counting them is the
			// whole assertion: a click is not a write, whatever the snap would say.
			const writes: string[] = [];
			page.on('request', (r) => {
				if (r.method() === 'POST' && r.url().includes('/op')) writes.push(r.url());
			});

			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);
			const block = page.getByRole('button', { name: /^Odd minute, 9:07 AM/ });
			await expect(block).toBeVisible();
			await settled(page);

			await block.click();
			// The grip too: a tap on it is not a resize, and 10:07 would snap to 10:05.
			const grip = page.locator('.sched .block', { hasText: 'Odd minute' }).locator('.bresize');
			await grip.click({ force: true });
			await page.waitForTimeout(400);

			expect(writes).toEqual([]);
			const stored = await storedEvent(request, fixture, day, id);
			expect(stored?.start_min).toBe(9 * 60 + 7);
			expect(stored?.end_min).toBe(10 * 60 + 7);
			await expect(
				page.getByRole('button', { name: /^Odd minute, 9:07 AM to 10:07 AM/ })
			).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});
});

test.describe('the map card on a frozen board', () => {
	test('offers no "+ Add" on a grey pin once the schedule is locked', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		try {
			const cityId = await addCity(request, fixture, {
				name: 'Lisbon',
				country: 'Portugal',
				tz: 'Europe/Lisbon',
				lat: 38.7223,
				lng: -9.1393
			});
			await addPlace(request, fixture, {
				cityId,
				name: 'Tram stop',
				lat: 38.71,
				lng: -9.13
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);

			const pin = page.locator('.wp-pin[title="Tram stop"]');
			await pin.hover();
			await expect(page.locator('.mapcard-add')).toBeVisible();
			await page.mouse.move(0, 0);

			await setLock(page, true);
			await pin.hover();
			// The card still opens: the place is still worth reading about. It just
			// has nothing to offer that the lock would refuse.
			await expect(page.locator('.mapcard')).toBeVisible();
			await expect(page.locator('.mapcard-add')).toHaveCount(0);
		} finally {
			fixture.teardown();
		}
	});
});

test.describe('two people, one event', () => {
	test('a save made after somebody else saved is refused, not written over them', async ({
		browser,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		const a = await signedInContext(browser, fixture.sessionCookie);
		const b = await signedInContext(browser, fixture.sessionCookie);
		try {
			const id = await addEvent(request, fixture, {
				day,
				type: 'activity',
				start: 600,
				duration: 60,
				title: 'Museum'
			});
			const url = `/trips/${fixture.tripId}/schedule?day=${day}&view=day`;
			await a.page.goto(url);
			await b.page.goto(url);

			// A opens the editor and starts typing.
			await a.page.getByRole('button', { name: 'Edit Museum' }).click();
			const dialogA = a.page.getByRole('dialog');
			await dialogA.getByLabel(/^Notes/).fill('Tickets at the door');

			// B renames it and saves first.
			await b.page.getByRole('button', { name: 'Edit Museum' }).click();
			const dialogB = b.page.getByRole('dialog');
			await dialogB.getByLabel(/^Label/).fill('Museum of Art');
			await dialogB.getByRole('button', { name: copy.common.save, exact: true }).click();
			await expect(dialogB).toBeHidden();

			// A saves over the top of it. Refused with the conflict message, because
			// the dialog writes against the version it was opened on rather than
			// whatever the board has loaded since.
			await dialogA.getByRole('button', { name: copy.common.save, exact: true }).click();
			await expect(dialogA.getByText(/Someone else changed this event/)).toBeVisible();
			// Still open, with what A typed still in it, so nothing is lost.
			await expect(dialogA.getByLabel(/^Notes/)).toHaveValue('Tickets at the door');

			// And B's rename stands.
			const stored = await storedEvent(request, fixture, day, id);
			expect(stored?.title).toBe('Museum of Art');
		} finally {
			await a.context.close();
			await b.context.close();
			fixture.teardown();
		}
	});
});

test.describe('a save refused halfway', () => {
	test('can be pressed again without being refused by its own first half', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		try {
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
			await addEvent(request, fixture, {
				day,
				cityId,
				type: 'activity',
				start: 480,
				duration: 60,
				poiId: cafe
			});
			const id = await addEvent(request, fixture, {
				day,
				cityId,
				type: 'activity',
				start: 600,
				duration: 60,
				poiId: museum
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);

			await page.getByRole('button', { name: 'Edit Museum' }).click();
			const dialog = page.getByRole('dialog');
			await dialog.getByLabel(/^Notes/).fill('Closed Mondays');
			await dialog
				.locator('.jrow')
				.getByLabel(/^Minutes/)
				.fill('33');

			// The last of the three writes fails: the edit and the people have
			// landed, and each of them moved the version on.
			const failLeg = (route: import('@playwright/test').Route) =>
				route.fulfill({ status: 500, json: { error: 'Journey write failed.' } });
			await page.route('**/schedule/legs/**', failLeg);
			await dialog.getByRole('button', { name: copy.common.save, exact: true }).click();
			await expect(dialog.getByText('Journey write failed.')).toBeVisible();
			await page.unroute('**/schedule/legs/**', failLeg);

			// Pressed again, the edit goes out with the version the people write
			// left behind. Holding the edit's own answer, or the opened row's, it
			// would be refused as somebody else's change.
			await dialog.getByRole('button', { name: copy.common.save, exact: true }).click();
			await expect(dialog).toBeHidden();
			await expect(page.getByText(/Someone else changed this event/)).toHaveCount(0);

			const res = await apiSend(
				request,
				fixture,
				'GET',
				`/trips/${fixture.tripId}/schedule?day=${day}`
			);
			const body = (await res.json()) as {
				board: {
					day: string;
					events: { id: string; notes: string | null }[];
					legs: { toEventId: string; mins: number | null }[];
				}[];
			};
			const today = body.board.find((b) => b.day === day)!;
			expect(today.events.find((e) => e.id === id)?.notes).toBe('Closed Mondays');
			expect(today.legs.find((l) => l.toEventId === id)?.mins).toBe(33);
		} finally {
			fixture.teardown();
		}
	});
});

test.describe('the map follows the board', () => {
	test('frames the day rather than the trip, and a click aims it until Escape', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		try {
			const lisbon = await addCity(request, fixture, {
				name: 'Lisbon',
				country: 'Portugal',
				tz: 'Europe/Lisbon',
				lat: 38.7223,
				lng: -9.1393
			});
			const tokyo = await addCity(request, fixture, {
				name: 'Tokyo',
				country: 'Japan',
				tz: 'Asia/Tokyo',
				lat: 35.68,
				lng: 139.76
			});
			const museum = await addPlace(request, fixture, {
				cityId: lisbon,
				name: 'Museum',
				lat: 38.7139,
				lng: -9.1334
			});
			const cafe = await addPlace(request, fixture, {
				cityId: lisbon,
				name: 'Cafe',
				kind: 'food',
				lat: 38.6916,
				lng: -9.216
			});
			// A saved place on the other side of the world, which is a grey pin and
			// must not decide what the camera frames.
			await addPlace(request, fixture, {
				cityId: tokyo,
				name: 'Temple',
				lat: 35.7148,
				lng: 139.7967
			});
			await addEvent(request, fixture, {
				day,
				cityId: lisbon,
				type: 'activity',
				start: 540,
				duration: 60,
				poiId: museum
			});
			await addEvent(request, fixture, {
				day,
				cityId: lisbon,
				type: 'food',
				start: 720,
				duration: 60,
				poiId: cafe
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);

			// Pixels between the day's two pins: a few dozen framed on the day, a
			// few at world zoom, and hundreds when the camera is on one of them.
			const apart = () =>
				page.evaluate(() => {
					const a = document.querySelector('.wp-pin[title="Museum"]')!.getBoundingClientRect();
					const b = document.querySelector('.wp-pin[title="Cafe"]')!.getBoundingClientRect();
					return Math.hypot(a.x - b.x, a.y - b.y);
				});
			await expect(page.locator('.wp-pin[title="Temple"]')).toHaveCount(1);
			// Settled, not merely drawn: the camera eases into the day.
			const steady = async () => {
				let last = -1;
				await expect
					.poll(async () => {
						const now = Math.round(await apart());
						const same = now === last;
						last = now;
						return same;
					})
					.toBe(true);
				return last;
			};
			const framed = await steady();
			expect(framed).toBeGreaterThan(20);

			await page.getByRole('button', { name: /^Museum, / }).click();
			// Zoomed in on the block: the same two pins pull apart.
			await expect.poll(apart).toBeGreaterThan(framed * 1.5);
			const focused = await steady();

			// Escape hands the camera back to the day: out again, and still framing
			// the day rather than the world.
			await page.keyboard.press('Escape');
			await expect.poll(apart).toBeLessThan(focused / 1.5);
			expect(await steady()).toBeGreaterThan(20);
		} finally {
			fixture.teardown();
		}
	});
});

test.describe('journeys on the board', () => {
	/** A city with a hotel and two places a walk apart. */
	async function seedPlaces(request: APIRequestContext, fixture: ApiFixture) {
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
			lat: 38.7139,
			lng: -9.1334
		});
		const cafe = await addPlace(request, fixture, {
			cityId,
			name: 'Cafe',
			kind: 'food',
			lat: 38.7075,
			lng: -9.1364
		});
		return { cityId, museum, cafe };
	}

	test('two blocks booked back to back keep the journey between them visible', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const day = fixture.tripBody.startDate;
		try {
			const { cityId, museum, cafe } = await seedPlaces(request, fixture);
			await addEvent(request, fixture, {
				day,
				cityId,
				type: 'activity',
				start: 540,
				duration: 60,
				poiId: museum
			});
			await addEvent(request, fixture, {
				day,
				cityId,
				type: 'food',
				start: 600,
				duration: 60,
				poiId: cafe
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);

			const leg = page.locator('.daypanel:not([inert]) .block.leg');
			await expect(leg).toHaveCount(1);
			await settled(page);

			// Not merely in the DOM: the thing under the middle of it is the journey,
			// not the block it left, which is what used to be painted on top.
			const onTop = await leg.evaluate((el) => {
				const r = el.getBoundingClientRect();
				const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
				return !!hit && el.contains(hit) && r.height >= 14;
			});
			expect(onTop).toBe(true);
		} finally {
			fixture.teardown();
		}
	});

	test('the first journey of the morning names the stay it leaves', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const { startDate } = fixture.tripBody;
		const morning = '2027-02-11';
		try {
			const { cityId, museum } = await seedPlaces(request, fixture);
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
				endDay: '2027-02-12'
			});
			await addEvent(request, fixture, {
				day: morning,
				cityId,
				type: 'activity',
				start: 600,
				duration: 60,
				poiId: museum
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule?day=${morning}&view=day`);

			// The stay is not a block of this day, so a map built from the day alone
			// had no name for where the morning starts, and the bar read "Walk".
			const leg = page.locator('.daypanel:not([inert]) .block.leg').first();
			await expect(leg).toContainText('from Hotel Central');
		} finally {
			fixture.teardown();
		}
	});
});
