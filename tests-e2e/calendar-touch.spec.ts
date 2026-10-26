import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { apiSend } from './fixtures/seed';
import { signIn } from './fixtures/session';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function move(cdp: CDPSession, x: number, y: number, dy: number) {
	for (let i = 1; i <= 12; i++) {
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [{ x, y: y + (dy * i) / 12 }]
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function positionBoard(page: Page, docked: boolean) {
	await page.evaluate((docked) => {
		const board = document.querySelector('.sched .board')!;
		const bar = document.querySelector('header')!.getBoundingClientRect().bottom;
		window.scrollTo(
			0,
			board.getBoundingClientRect().top + window.scrollY - bar - (docked ? 0 : 60)
		);
	}, docked);
}

test('the hours scroll repeatedly even when the board is partly below the fold', async ({
	page,
	request
}) => {
	const fixture = await createApiFixture(request);
	try {
		await signIn(page, fixture.sessionCookie);
		await page.goto(`/trips/${fixture.tripId}/schedule`);
		const board = page.locator('.sched .boardscroll');
		await expect(board).toBeVisible();
		await page.evaluate(() => document.fonts.ready);
		await positionBoard(page, false);
		await expect(page.locator('html')).toHaveCSS('scroll-snap-type', 'none');
		// Stay outside the former parked/unparked boundary, including rounding at the dock.
		await expect(board).toHaveCSS('overflow-y', 'auto');
		const cdp = await page.context().newCDPSession(page);
		try {
			for (const docked of [false, true, false]) {
				await positionBoard(page, docked);
				const r = (await board.boundingBox())!;
				const before = await board.evaluate((el) => el.scrollTop);
				const y = Math.min(r.y + 180, 600);
				await cdp.send('Input.dispatchTouchEvent', {
					type: 'touchStart',
					touchPoints: [{ x: 195, y }]
				});
				await move(cdp, 195, y, -100);
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
				await expect.poll(() => board.evaluate((el) => el.scrollTop)).toBeGreaterThan(before + 40);
				await expect(board).toHaveCSS('overflow-y', 'auto');
			}
		} finally {
			await cdp.detach();
		}
	} finally {
		fixture.teardown();
	}
});

test('a lifted touch can move and resize after pointer cancellation, but touch cancellation saves nothing', async ({
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
			{
				day,
				type: 'activity',
				title: 'Touch event',
				start: 600,
				duration: 90
			}
		);
		expect(res.status()).toBe(201);
		const { id } = (await res.json()) as { id: string };
		await signIn(page, fixture.sessionCookie);
		await page.goto(`/trips/${fixture.tripId}/schedule?day=${day}&view=day`);
		const block = page.locator('.daypanel:not([inert]) .block:not(.leg)', {
			hasText: 'Touch event'
		});
		await expect(block).toBeVisible();
		await page.evaluate(() => document.fonts.ready);
		await positionBoard(page, true);
		await page.locator('.boardscroll').evaluate((el) => {
			el.scrollTop = 120;
		});
		const writes: { op: string; startMin?: number; endMin?: number }[] = [];
		page.on('request', (r) => {
			if (r.method() === 'POST' && r.url().endsWith(`/events/${id}/op`))
				writes.push(r.postDataJSON());
		});
		const cdp = await page.context().newCDPSession(page);
		try {
			for (const kind of ['move', 'resize', 'cancel'] as const) {
				const target = kind === 'resize' ? block.locator('.bresize') : block.locator('.bface');
				const r = (await target.boundingBox())!;
				const x = r.x + r.width / 2;
				const y = kind === 'resize' ? r.y + r.height / 2 : r.y + 20;
				const top = await page.locator('.boardscroll').evaluate((el) => el.scrollTop);
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
				await expect(block).toHaveClass(kind === 'resize' ? /resizing/ : /dragging/);
				// Mobile browsers can stop the pointer stream while the touch is still held.
				await target.dispatchEvent('pointercancel', { pointerType: 'touch' });
				await expect(block).toHaveClass(kind === 'resize' ? /resizing/ : /dragging/);
				await move(cdp, x, y, 45);
				await expect(page.locator('.boardscroll')).toHaveJSProperty('scrollTop', top);
				if (kind === 'cancel') {
					await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
					await expect(block).not.toHaveClass(/dragging|resizing/);
					expect(writes).toHaveLength(2);
				} else {
					const written = page.waitForResponse((r) => r.url().endsWith(`/events/${id}/op`));
					await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
					expect((await written).status()).toBe(200);
					await expect.poll(() => writes.length).toBe(kind === 'move' ? 1 : 2);
					const last = writes.at(-1)!;
					expect(last.op).toBe(kind);
					expect(kind === 'move' ? last.startMin : last.endMin).toBeGreaterThan(
						kind === 'move' ? 600 : 690
					);
				}
			}
		} finally {
			await cdp.detach();
		}
	} finally {
		fixture.teardown();
	}
});

test('ordinary swipes on events and their resize grips scroll without saving an edit', async ({
	page,
	request
}) => {
	const fixture = await createApiFixture(request);
	try {
		const res = await apiSend(
			request,
			fixture,
			'POST',
			`/trips/${fixture.tripId}/schedule/events`,
			{
				day: fixture.tripBody.startDate,
				type: 'activity',
				title: 'Scroll over me',
				start: 600,
				duration: 120
			}
		);
		expect(res.status()).toBe(201);
		await signIn(page, fixture.sessionCookie);
		await page.goto(`/trips/${fixture.tripId}/schedule`);
		const block = page.locator('.daypanel:not([inert]) .block:not(.leg)', {
			hasText: 'Scroll over me'
		});
		await expect(block).toBeVisible();
		await page.evaluate(() => document.fonts.ready);
		await positionBoard(page, true);
		let writes = 0;
		page.on('request', (r) => {
			if (r.method() === 'POST' && r.url().endsWith('/op')) writes++;
		});
		const board = page.locator('.boardscroll');
		const cdp = await page.context().newCDPSession(page);
		try {
			for (const selector of ['.bface', '.bresize']) {
				await board.evaluate((el) => {
					el.scrollTop = 150;
				});
				const target = (await block.locator(selector).boundingBox())!;
				const x = target.x + target.width / 2;
				const y = selector === '.bface' ? target.y + 20 : target.y + target.height / 2;
				await cdp.send('Input.dispatchTouchEvent', {
					type: 'touchStart',
					touchPoints: [{ x, y }]
				});
				await move(cdp, x, y, -90);
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
				await expect
					.poll(() => board.evaluate((el) => el.scrollTop), {
						message: `scrolling from ${selector}`
					})
					.toBeGreaterThan(190);
				await expect(block).not.toHaveClass(/dragging|resizing/);
				expect(writes).toBe(0);
			}
		} finally {
			await cdp.detach();
		}
	} finally {
		fixture.teardown();
	}
});

test('time segments are editable inputs for the numeric keyboard and save the typed time', async ({
	page,
	request
}) => {
	const fixture = await createApiFixture(request);
	try {
		await signIn(page, fixture.sessionCookie);
		await page.goto(`/trips/${fixture.tripId}/schedule`);
		await page.getByRole('button', { name: '+ Add', exact: true }).tap();
		const hour = page.getByLabel('Start hour', { exact: true });
		const minute = page.getByLabel('Start minute', { exact: true });
		await expect(hour).toHaveJSProperty('tagName', 'INPUT');
		await expect(minute).toHaveAttribute('inputmode', 'numeric');
		await hour.tap();
		await expect(hour).toBeFocused();
		// A software keyboard can send input without any desktop digit keydown.
		await hour.fill('');
		await page.keyboard.insertText('8');
		await expect(minute).toBeFocused();
		await page.keyboard.insertText('3');
		await page.keyboard.insertText('5');
		const meridiem = page.getByLabel('Start meridiem', { exact: true });
		if ((await meridiem.getAttribute('aria-valuetext')) !== 'PM') await meridiem.tap();
		await expect(hour).toHaveValue('8');
		await expect(minute).toHaveValue('35');
		await expect(meridiem).toHaveAttribute('aria-valuetext', 'PM');
		const endHour = page.getByLabel('End hour', { exact: true });
		const endMinute = page.getByLabel('End minute', { exact: true });
		await endHour.fill('9');
		await endMinute.fill('40');
		const endMeridiem = page.getByLabel('End meridiem', { exact: true });
		if ((await endMeridiem.getAttribute('aria-valuetext')) !== 'PM') await endMeridiem.tap();
		const save = page.waitForRequest(
			(r) => r.method() === 'POST' && r.url().endsWith('/schedule/events')
		);
		await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).tap();
		expect((await save).postDataJSON()).toMatchObject({
			start: 20 * 60 + 35,
			endMin: 21 * 60 + 40
		});
	} finally {
		fixture.teardown();
	}
});
