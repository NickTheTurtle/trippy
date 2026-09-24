import { expect, test } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { addCity, seedMembers } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

/**
 * The house style the owner cares about, asserted once rather than trusted to
 * hold across pages: the shared confirmation wording, empty-state caption,
 * busy-label punctuation and a sane heading outline. Where a rule is a property
 * of the copy itself (a caption with no full stop, a busy label that ends in an
 * ellipsis) it is asserted against `packages/copy` directly, so a reword that
 * keeps the rule does not fail the suite and one that breaks it does.
 */

const LISBON = { name: 'Lisbon', country: 'Portugal', region: 'Lisboa', tz: 'Europe/Lisbon' };

/** Visible headings in document order, as {level, text}, from a live page. */
async function headingOutline(page: import('@playwright/test').Page) {
	return page.evaluate(() => {
		const nodes = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'));
		return nodes
			.filter((el) => (el as HTMLElement).getClientRects().length > 0)
			.map((el) => {
				const aria = el.getAttribute('aria-level');
				const level = aria ? Number(aria) : Number(el.tagName.slice(1));
				return { level, text: (el.textContent ?? '').trim() };
			});
	});
}

test.describe('ui consistency', () => {
	test('busy labels end in an ellipsis and the empty caption carries no full stop', () => {
		// A property of the copy, not of any one screen: asserting it here means a
		// reworded label is still held to the rule wherever it is shown.
		for (const label of [
			copy.common.saving,
			copy.common.deleting,
			copy.common.adding,
			copy.common.working,
			copy.ui.searchDropdown.busyLabel
		]) {
			expect(label.endsWith('...')).toBe(true);
		}
		// The empty-state caption is a fragment, not a sentence, so it takes no stop.
		expect(copy.common.nothingAdded.endsWith('.')).toBe(false);
		// The house confirmation is one fixed sentence everywhere.
		expect(copy.ui.confirmDialog.undone).toBe('Are you sure? This action cannot be undone.');
	});

	test('dialog titles and field hints follow the house shape', () => {
		// Both rules are properties of the copy, so they are checked against every
		// string in it rather than against the handful of dialogs a spec happens
		// to open. A new dialog is held to them without anyone remembering to.
		const strings: { path: string; key: string; value: string }[] = [];
		(function walk(node: unknown, path: string) {
			if (!node || typeof node !== 'object') return;
			for (const [key, value] of Object.entries(node)) {
				if (typeof value === 'string') strings.push({ path: `${path}.${key}`, key, value });
				else walk(value, `${path}.${key}`);
			}
		})(copy, 'copy');

		// A dialog title is "Add <thing>" or "Edit <thing>": lower case after the
		// verb and no article, so "Add someone" and "Add a task" are both out.
		for (const { path, key, value } of strings) {
			if (!/title$/i.test(key) || !/^(Add|Edit) /.test(value)) continue;
			expect(value, path).toMatch(/^(Add|Edit) (?!a |an |the )[a-z]+$/);
		}

		// A hint under a field is a fragment, like the caption, so it takes no
		// full stop. A hint that needs a sentence is saying too much, and it
		// never says "optional": the label carries that, in its muted suffix.
		for (const { path, key, value } of strings) {
			if (!/hint$/i.test(key)) continue;
			expect(value.endsWith('.'), path).toBe(false);
			expect(value.toLowerCase().includes('optional'), path).toBe(false);
		}
	});

	test('a delete confirmation repeats the bare verb and never names the thing on its button', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			// Two cities, because the trip's last city cannot be removed by design.
			await addCity(request, fixture, LISBON);
			await addCity(request, fixture, {
				name: 'Porto',
				country: 'Portugal',
				region: 'Porto',
				tz: 'Europe/Lisbon'
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			await page.getByRole('button', { name: copy.common.deleteLabel('Porto') }).click();
			const confirm = page.getByRole('dialog');

			// The body is the house sentence, and the title names the thing.
			await expect(confirm.getByText(copy.ui.confirmDialog.undone)).toBeVisible();

			// The confirm button is the bare verb: "Delete", not "Delete city" and
			// not "Delete Porto". The danger button is the solid one.
			const danger = confirm.locator('button.danger');
			await expect(danger).toHaveText(copy.common.delete);
			expect(await danger.textContent()).not.toContain('Porto');
			expect(await danger.textContent()).not.toContain('city');
		} finally {
			fixture.teardown();
		}
	});

	test('the trip pages each have exactly one h1 and no skipped heading levels', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await addCity(request, fixture, LISBON);
			await signIn(page, fixture.sessionCookie);

			// Every first-party page a signed-in owner reaches. The schedule is
			// covered separately below, since its board needs a day's data before it
			// has an outline worth checking.
			const routes = [
				'/trips',
				'/account',
				`/trips/${fixture.tripId}/discover`,
				`/trips/${fixture.tripId}/preparation`,
				`/trips/${fixture.tripId}/expenses`,
				`/trips/${fixture.tripId}/people`
			];

			for (const route of routes) {
				await page.goto(route);
				// Wait for the page's own h1 to settle before reading the outline, so
				// a mid-load snapshot does not report a transient zero.
				await expect(page.locator('h1').first()).toBeVisible();
				const outline = await headingOutline(page);

				const h1s = outline.filter((h) => h.level === 1);
				expect(h1s.length, `${route} should have exactly one h1`).toBe(1);

				// No heading may jump more than one level below the one before it: an
				// h1 then an h3 leaves a hole a screen-reader user falls through.
				let previous = 0;
				for (const heading of outline) {
					if (previous !== 0) {
						expect(
							heading.level - previous,
							`${route}: heading "${heading.text}" jumps past a level`
						).toBeLessThanOrEqual(1);
					}
					previous = heading.level;
				}
			}
		} finally {
			fixture.teardown();
		}
	});

	test('the schedule tab loads its own page rather than the not-found screen', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/schedule`);

			// The trip shell renders the tab strip; NotFound does not. The active tab
			// carries aria-current, which proves this is the schedule route resolved
			// rather than the silent NotFound page, which otherwise looks like a
			// passing screenshot.
			const tab = page.getByRole('link', { name: copy.nav.schedule });
			await expect(tab).toHaveAttribute('aria-current', 'page');
			await expect(page.getByRole('heading', { name: copy.notFound.heading })).toBeHidden();
		} finally {
			fixture.teardown();
		}
	});

	test('a slug a tab used to have is now a dead address like any other', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			// These four used to redirect to the tabs that absorbed or renamed them.
			// The app is in beta and nobody has a saved link to honour, so they fall
			// through to the catch-all now. Pinned because the alternative to a
			// redirect is supposed to be an honest 404, not a blank page.
			const retired = ['calendar', 'pretrip', 'costs', 'lodging'];

			for (const slug of retired) {
				await page.goto(`/trips/${fixture.tripId}/${slug}`);
				await expect(page.getByRole('heading', { name: copy.notFound.heading })).toBeVisible();
			}
		} finally {
			fixture.teardown();
		}
	});

	/**
	 * A field's controls are all the same size, and a menu matches the control
	 * that opened it. Both used to depend on inheritance: `.field` carried its
	 * label's size, so a control that did not restate its own took it, and an
	 * open menu took whatever its trigger happened to sit in.
	 */
	test('every control in a dialog form reads at one size, menus included', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.setViewportSize({ width: 1440, height: 950 });
			await page.goto(`/trips/${fixture.tripId}/schedule`);
			await page.getByRole('button', { name: /Add/ }).first().click();
			await page.locator('.modal[open]').first().waitFor();

			// Full-height controls only: `.small` and `.compact` are deliberate
			// variants and say so in their class.
			const sizes = async () =>
				page.locator('.modal[open]').evaluate((m) => {
					const out = new Set<string>();
					for (const el of m.querySelectorAll('.input, .seltrigger, .mtrigger, .tfield')) {
						const box = el as HTMLElement;
						if (box.className.includes('compact')) continue;
						if (!box.getClientRects().length) continue;
						out.add(getComputedStyle(box).fontSize);
					}
					return [...out];
				});

			expect(await sizes(), 'the closed controls disagree').toHaveLength(1);

			// An option and the value it is about to become are one sentence.
			await page.getByRole('button', { name: 'Type' }).click();
			const option = page.locator('.selopt').first();
			await option.waitFor();
			const menu = await option.evaluate((el) => getComputedStyle(el).fontSize);
			expect([menu], 'the menu disagrees with its own trigger').toEqual(await sizes());
		} finally {
			fixture.teardown();
		}
	});

	/**
	 * A page filter and the page's own button are one row, so they are one size.
	 * The schedule's "View as" was compact and Discover's type filter was not, so
	 * the same kind of control was 32px on one page and 42px on the next, and on
	 * the schedule it sat beside a 42px `+ Add` it did not match.
	 */
	test('a page filter dropdown matches the button beside it, on every page', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await addCity(request, fixture, LISBON);
			await seedMembers(request, fixture, ['Ana']);
			await signIn(page, fixture.sessionCookie);
			await page.setViewportSize({ width: 1440, height: 950 });

			const row = async (path: string) => {
				await page.goto(`/trips/${fixture.tripId}/${path}`);
				const trigger = page.locator('.seltrigger').first();
				await trigger.waitFor();
				return page.evaluate(() => {
					const read = (el: Element) => {
						const r = el.getBoundingClientRect();
						return { h: Math.round(r.height), font: getComputedStyle(el).fontSize };
					};
					const t = document.querySelector('.seltrigger') as HTMLElement;
					const b = document.querySelector('.btn.primary') as HTMLElement;
					return { filter: read(t), button: read(b) };
				});
			};

			const schedule = await row('schedule');
			expect(schedule.filter, 'the schedule filter misses its own button').toEqual(schedule.button);

			const discover = await row('discover');
			expect(discover.filter, 'discover filter misses its own button').toEqual(discover.button);
			expect(schedule.filter, 'the two pages disagree').toEqual(discover.filter);
		} finally {
			fixture.teardown();
		}
	});
});
