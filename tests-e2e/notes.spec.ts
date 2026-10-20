import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createApiFixture, registerUser, type ApiFixture } from './fixtures/api';
import { apiSend, invite, type Client } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

/**
 * Preparation > Notes: the trip's one shared notepad. Typing saves by itself,
 * a reload brings the text back, and what another member saves turns up in an
 * open notepad without a reload, including while this one has unsaved typing
 * of its own, when the two are merged rather than one replacing the other.
 */

const cp = copy.preparation;
const cn = cp.notes;

type Notes = { body: string; version: number };

async function openNotes(page: Page, fixture: ApiFixture) {
	await page.goto(`/trips/${fixture.tripId}/preparation`);
	await page
		.getByRole('navigation', { name: cp.navAriaLabel })
		.getByRole('button', { name: cp.sections.notes })
		.click();
	const box = page.getByRole('textbox', { name: cn.label });
	await expect(box).toBeVisible();
	return box;
}

async function readNotes(
	request: APIRequestContext,
	client: Client,
	tripId: string
): Promise<Notes> {
	const res = await apiSend(request, client, 'GET', `/trips/${tripId}/pretrip/notes`);
	expect(res.status(), await res.text()).toBe(200);
	return res.json() as Promise<Notes>;
}

/** Saves the notepad as another member would, on whatever version is current. */
async function writeNotes(
	request: APIRequestContext,
	client: Client,
	tripId: string,
	body: string
): Promise<void> {
	const { version } = await readNotes(request, client, tripId);
	const res = await apiSend(request, client, 'PUT', `/trips/${tripId}/pretrip/notes`, {
		body,
		version
	});
	expect(res.status(), await res.text()).toBe(200);
}

test.describe('preparation notes', () => {
	test('typing saves by itself and survives a reload', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			const box = await openNotes(page, fixture);
			// Nothing has been written, so there is nobody to credit.
			await expect(page.locator('.notepad-status')).toHaveText('');
			// No add button on a section that is one page written in place.
			await expect(page.getByRole('button', { name: cp.add, exact: true })).toHaveCount(0);

			await box.fill('Door code 4417\nBring adapters');
			await expect(page.getByText(cn.editedBy('E2E User', 'just now'))).toBeVisible();
			await expect
				.poll(async () => (await readNotes(request, fixture, fixture.tripId)).body)
				.toBe('Door code 4417\nBring adapters');

			await page.reload();
			const again = await openNotes(page, fixture);
			await expect(again).toHaveValue('Door code 4417\nBring adapters');
		} finally {
			fixture.teardown();
		}
	});

	test('switching section straight after typing still saves', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			const box = await openNotes(page, fixture);
			await box.fill('Typed and left at once');
			// Well inside the pause a save waits for.
			await page
				.getByRole('navigation', { name: cp.navAriaLabel })
				.getByRole('button', { name: cp.sections.tasks })
				.click();
			await expect
				.poll(async () => (await readNotes(request, fixture, fixture.tripId)).body)
				.toBe('Typed and left at once');
		} finally {
			fixture.teardown();
		}
	});

	test("another member's edit appears without a reload, and typing at once keeps both", async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const bea = await registerUser(request, { name: 'Bea' });
		try {
			await invite(request, fixture, bea.email);
			await signIn(page, fixture.sessionCookie);
			const box = await openNotes(page, fixture);

			// Idle, with focus in the box: Bea's save replaces the text.
			await box.click();
			await writeNotes(request, bea, fixture.tripId, 'Ferry at 9:40');
			await expect(box).toHaveValue('Ferry at 9:40');
			await expect(page.getByText(cn.editedBy('Bea', 'just now'))).toBeVisible();

			// Both at once: this page has an unsaved line when Bea saves hers. Its
			// own save is held at the network until hers has landed, so it goes out
			// on a stale version with the text it was typed over, and the server
			// merges the two: neither line is lost.
			let release = () => {};
			const gate = new Promise<void>((resolve) => (release = resolve));
			await page.route('**/pretrip/notes', async (route) => {
				if (route.request().method() === 'PUT') await gate;
				await route.continue();
			});
			const merged = page.waitForResponse(
				async (res) =>
					res.url().endsWith('/pretrip/notes') &&
					res.request().method() === 'PUT' &&
					res.status() === 200 &&
					(await res.json()).merged === true
			);
			await box.press('End');
			await box.pressSequentially('\nPack sunscreen');
			await writeNotes(request, bea, fixture.tripId, 'Ferry at 9:40\nBook the taxi');
			release();
			await merged;

			const both = 'Ferry at 9:40\nPack sunscreen\nBook the taxi';
			await expect
				.poll(async () => (await readNotes(request, fixture, fixture.tripId)).body)
				.toBe(both);
			await expect(box).toHaveValue(both);
		} finally {
			fixture.teardown();
			bea.teardown();
		}
	});

	// The merge-then-keystroke race. A save goes out stale, its answer is held
	// at the network while this page types more, and a keystroke is injected the
	// moment the answer has been handled, before React would otherwise have
	// rendered the merged text. Every line has to survive: Bea's, the one the
	// save carried, the one typed while it was out, and the injected one.
	// `merged` is the normal path (the save carries `base` and the server
	// merges); `409` strips `base` from the request to force the fallback.
	for (const path of ['merged', '409'] as const) {
		test(`typing while a stale save is answered keeps every line (${path})`, async ({
			page,
			request
		}) => {
			const fixture = await createApiFixture(request);
			const bea = await registerUser(request, { name: 'Bea' });
			try {
				await invite(request, fixture, bea.email);
				await writeNotes(request, bea, fixture.tripId, 'Ferry at 9:40');
				await signIn(page, fixture.sessionCookie);
				await page.addInitScript(injectKeystrokeAfterFirstSave);
				const box = await openNotes(page, fixture);
				await expect(box).toHaveValue('Ferry at 9:40');

				let releaseRequest = () => {};
				const requestGate = new Promise<void>((resolve) => (releaseRequest = resolve));
				let releaseAnswer = () => {};
				const answerGate = new Promise<void>((resolve) => (releaseAnswer = resolve));
				let answered = () => {};
				const serverAnswered = new Promise<void>((resolve) => (answered = resolve));
				let first = true;
				await page.route('**/pretrip/notes', async (route) => {
					if (route.request().method() !== 'PUT' || !first) return route.continue();
					first = false;
					await requestGate;
					const sent = route.request().postDataJSON() as Record<string, unknown>;
					if (path === '409') delete sent.base;
					const response = await route.fetch({ postData: JSON.stringify(sent) });
					answered();
					await answerGate;
					await route.fulfill({ response });
				});

				await box.click();
				await box.press('Control+End');
				await box.pressSequentially('\nPack sunscreen');
				await writeNotes(request, bea, fixture.tripId, 'Ferry at 9:40\nBook the taxi');
				releaseRequest();
				await serverAnswered;
				// The answer is on its way back; type more before it arrives.
				await box.press('Control+End');
				await box.pressSequentially('\nAlso towels');
				releaseAnswer();

				const all = 'Top\nFerry at 9:40\nPack sunscreen\nAlso towels\nBook the taxi';
				await expect(box).toHaveValue(all);
				await expect
					.poll(async () => (await readNotes(request, fixture, fixture.tripId)).body)
					.toBe(all);
			} finally {
				fixture.teardown();
				bea.teardown();
			}
		});
	}

	test('text typed as the section is left, while saves fail, comes back and is saved', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			const box = await openNotes(page, fixture);
			await page.route('**/pretrip/notes', (route) =>
				route.request().method() === 'PUT' ? route.abort() : route.continue()
			);
			const failed = page.waitForEvent(
				'requestfailed',
				(req) => req.method() === 'PUT' && req.url().endsWith('/pretrip/notes')
			);
			await box.fill('Written offline');
			await page
				.getByRole('navigation', { name: cp.navAriaLabel })
				.getByRole('button', { name: cp.sections.tasks })
				.click();
			await failed;
			expect((await readNotes(request, fixture, fixture.tripId)).body).toBe('');

			// Back online and back on the notepad: the text is there and goes out.
			await page.unroute('**/pretrip/notes');
			await page
				.getByRole('navigation', { name: cp.navAriaLabel })
				.getByRole('button', { name: cp.sections.notes })
				.click();
			await expect(page.getByRole('textbox', { name: cn.label })).toHaveValue('Written offline');
			await expect
				.poll(async () => (await readNotes(request, fixture, fixture.tripId)).body)
				.toBe('Written offline');
		} finally {
			fixture.teardown();
		}
	});
	test('hiding the page with a save that never lands keeps the lines of that save', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		let releaseFirst = () => {};
		try {
			await writeNotes(request, fixture, fixture.tripId, 'Ferry at 9:40');
			await signIn(page, fixture.sessionCookie);
			const box = await openNotes(page, fixture);
			await expect(box).toHaveValue('Ferry at 9:40');

			// The first save is held and then dropped: it never reaches the server.
			// Every later one goes through.
			const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
			let puts = 0;
			await page.route('**/pretrip/notes', async (route) => {
				if (route.request().method() !== 'PUT' || puts++ > 0) return route.continue();
				await firstGate;
				await route.abort().catch(() => {});
			});
			const firstSent = page.waitForRequest(
				(req) => req.method() === 'PUT' && req.url().endsWith('/pretrip/notes')
			);
			await box.click();
			await box.press('Control+End');
			await box.pressSequentially('\nfirst line');
			await firstSent;
			await box.pressSequentially('\nsecond line');

			// Hidden with that save still out: the latest text goes at once, sent as
			// though the first had landed, and naming the base the first was sent from.
			const speculative = page.waitForResponse(
				(res) => res.request().method() === 'PUT' && res.url().endsWith('/pretrip/notes')
			);
			await page.evaluate(() => {
				Object.defineProperty(document, 'visibilityState', {
					value: 'hidden',
					configurable: true
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});
			const answer = await speculative;
			expect(answer.status()).toBe(200);
			expect(answer.request().postDataJSON()).toMatchObject({
				base: 'Ferry at 9:40\nfirst line',
				priorBase: 'Ferry at 9:40'
			});
			// The server never saw the first save, and still has its line.
			expect((await readNotes(request, fixture, fixture.tripId)).body).toBe(
				'Ferry at 9:40\nfirst line\nsecond line'
			);
		} finally {
			releaseFirst();
			fixture.teardown();
		}
	});

	test('a cancelled save that still reaches the server late does not double a line', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await writeNotes(request, fixture, fixture.tripId, 'Ferry at 9:40');
			await signIn(page, fixture.sessionCookie);
			const box = await openNotes(page, fixture);
			await expect(box).toHaveValue('Ferry at 9:40');

			// The first save is held at the network and its exact request kept, so
			// it can be replayed after the speculative save, the way a request that
			// was already on its way would arrive.
			let late: Record<string, unknown> | null = null;
			let puts = 0;
			await page.route('**/pretrip/notes', async (route) => {
				if (route.request().method() !== 'PUT' || puts++ > 0) return route.continue();
				late = route.request().postDataJSON() as Record<string, unknown>;
				// Never answered here: the page cancels it when it sends in its place.
			});
			const firstSent = page.waitForRequest(
				(req) => req.method() === 'PUT' && req.url().endsWith('/pretrip/notes')
			);
			await box.click();
			await box.press('Control+End');
			// Mid-word, so the next save extends the same line rather than adding one.
			await box.pressSequentially('\nfirst lin');
			await firstSent;
			await box.pressSequentially('e\nsecond line');

			const speculative = page.waitForResponse(
				(res) => res.request().method() === 'PUT' && res.url().endsWith('/pretrip/notes')
			);
			const cancelled = page.waitForEvent(
				'requestfailed',
				(req) => req.method() === 'PUT' && req.url().endsWith('/pretrip/notes')
			);
			await page.evaluate(() => {
				Object.defineProperty(document, 'visibilityState', {
					value: 'hidden',
					configurable: true
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});
			// The page cancels the held save before sending in its place.
			await cancelled;
			expect((await speculative).status()).toBe(200);
			const all = 'Ferry at 9:40\nfirst line\nsecond line';
			expect((await readNotes(request, fixture, fixture.tripId)).body).toBe(all);

			// The cancelled save lands after all.
			expect(late).toMatchObject({ body: 'Ferry at 9:40\nfirst lin', base: 'Ferry at 9:40' });
			const res = await apiSend(
				request,
				fixture,
				'PUT',
				`/trips/${fixture.tripId}/pretrip/notes`,
				late
			);
			expect(res.status(), await res.text()).toBe(200);
			expect((await readNotes(request, fixture, fixture.tripId)).body).toBe(all);
		} finally {
			fixture.teardown();
		}
	});
});

/**
 * Runs in the page. The first time a notepad save's answer has been read, a
 * line is typed at the very top of the box on the next task: after the
 * client's handler has run, and before a render it had merely scheduled. The
 * top is used because it is the same place whichever text the box holds, so
 * the expected result does not depend on who won.
 */
function injectKeystrokeAfterFirstSave() {
	const original = window.fetch.bind(window);
	let armed = true;
	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const res = await original(input, init);
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		if (armed && init?.method === 'PUT' && url.endsWith('/pretrip/notes')) {
			armed = false;
			const read = res.json.bind(res);
			res.json = async () => {
				const value = await read();
				setTimeout(() => {
					const box = document.querySelector('textarea');
					if (!box) return;
					box.focus();
					box.setSelectionRange(0, 0);
					document.execCommand('insertText', false, 'Top\n');
				}, 0);
				return value;
			};
		}
		return res;
	};
}
