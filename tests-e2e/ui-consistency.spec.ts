import { expect, test } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { addCity } from './fixtures/seed';
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

			await page.getByRole('button', { name: copy.discover.cityList.removeLabel('Porto') }).click();
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

	test('the slugs a tab used to have still land on the tab that owns them', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			// Renaming a slug to match its label is only free while the old one keeps
			// working, so the redirects are the load-bearing half of that change.
			const moved = [
				['calendar', 'schedule', copy.nav.schedule],
				['pretrip', 'preparation', copy.nav.preparation],
				['costs', 'preparation', copy.nav.preparation],
				['lodging', 'discover', copy.nav.discover]
			] as const;

			for (const [from, to, label] of moved) {
				await page.goto(`/trips/${fixture.tripId}/${from}`);
				await expect(page).toHaveURL(new RegExp(`/trips/${fixture.tripId}/${to}$`));
				await expect(page.getByRole('link', { name: label })).toHaveAttribute(
					'aria-current',
					'page'
				);
			}
		} finally {
			fixture.teardown();
		}
	});
});
