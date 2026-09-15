import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createApiFixture, registerUser } from './fixtures/api';
import { invite } from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn } from './fixtures/session';

/**
 * People: the roster, the dialog that adds one, and the two ways somebody
 * leaves it (an organizer removing them, or a member leaving of their own
 * accord). People are added through the dialog where that flow is the point,
 * and through the API where the point is what registering does next.
 */

const cpl = copy.people;

test.describe('people', () => {
	test('an organizer adds a person by name and address, sees it pending, and revokes it', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/people`);

			// Driven through the dialog, since turning a name and an address into a
			// pending member is the flow under test.
			await page.getByRole('button', { name: copy.common.add, exact: true }).click();
			const dialog = page.getByRole('dialog');
			await dialog.getByLabel(cpl.add.nameLabel).fill('Zoe');
			await dialog.getByLabel(cpl.add.emailLabel).fill('zoe@example.test');
			await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();

			// An invite is a real placeholder member, tagged invited and carrying the
			// address it was sent to, not a separate pending list.
			const row = page.getByRole('listitem').filter({ hasText: 'Zoe' });
			await expect(row).toContainText(cpl.row.invitedTag);
			await expect(row).toContainText('zoe@example.test');

			// Revoking is removing that row, from inside its own dialog and behind
			// the house confirmation.
			await page.getByRole('button', { name: cpl.row.editLabel('Zoe') }).click();
			await page
				.getByRole('dialog')
				.getByRole('button', { name: copy.common.delete, exact: true })
				.click();
			const confirm = page.getByRole('dialog');
			await expect(confirm.getByRole('heading', { name: cpl.deleteTitle('Zoe') })).toBeVisible();
			await confirm.getByRole('button', { name: copy.common.delete, exact: true }).click();
			await expect(page.getByRole('listitem').filter({ hasText: 'Zoe' })).toHaveCount(0);
		} finally {
			fixture.teardown();
		}
	});

	test('a person added by name alone is on the roster with no address and no invited tag', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/people`);

			await page.getByRole('button', { name: copy.common.add, exact: true }).click();
			const dialog = page.getByRole('dialog');
			await dialog.getByLabel(cpl.add.nameLabel).fill('Mum');
			await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();

			// Nothing was sent, so nothing claims to be waiting, and the synthetic
			// address the server keeps for its index never reaches the page.
			const row = page.getByRole('listitem').filter({ hasText: 'Mum' });
			await expect(row).toBeVisible();
			await expect(row).not.toContainText(cpl.row.invitedTag);
			await expect(row).not.toContainText('waypoint.invalid');
		} finally {
			fixture.teardown();
		}
	});

	test('an organizer edits the address an invited person is waiting at', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/people`);

			await page.getByRole('button', { name: copy.common.add, exact: true }).click();
			let dialog = page.getByRole('dialog');
			await dialog.getByLabel(cpl.add.nameLabel).fill('Kim');
			await dialog.getByLabel(cpl.add.emailLabel).fill('typo@example.test');
			await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();

			await page.getByRole('button', { name: cpl.row.editLabel('Kim') }).click();
			dialog = page.getByRole('dialog');
			await dialog.getByLabel(cpl.edit.emailLabel).fill('kim@example.test');
			await dialog.getByRole('button', { name: copy.common.save, exact: true }).click();

			const row = page.getByRole('listitem').filter({ hasText: 'Kim' });
			await expect(row).toContainText('kim@example.test');
			await expect(row).not.toContainText('typo@example.test');
		} finally {
			fixture.teardown();
		}
	});

	test('registering with an invited address joins the trip automatically', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const email = `invitee-${randomUUID()}@example.test`;
		// The invite lands first, as a placeholder; registering that same address
		// is what turns the placeholder into a real membership.
		await invite(request, fixture, email);
		const joiner = await registerUser(request, { email, name: 'Joiner' });
		try {
			await signIn(page, joiner.sessionCookie);
			// A member can read the trip; a stranger gets Trip not found. Reading the
			// header is the proof the registration joined them.
			await page.goto(`/trips/${fixture.tripId}/discover`);
			await expect(
				page.getByRole('heading', { level: 1, name: fixture.tripBody.name })
			).toBeVisible();
		} finally {
			fixture.teardown();
			joiner.teardown();
		}
	});

	test('an organizer removes a joined member after confirming', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		// A real account rather than a placeholder, so this covers removing someone
		// who genuinely joined, not just revoking an invite.
		const member = await registerUser(request, { name: 'Mallory' });
		await invite(request, fixture, member.email);
		try {
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/people`);

			const row = page.getByRole('listitem').filter({ hasText: 'Mallory' });
			await expect(row).toBeVisible();
			await page.getByRole('button', { name: cpl.row.removeLabel('Mallory') }).click();
			// The row states who they are; the removal lives in that dialog's footer.
			await page
				.getByRole('dialog')
				.getByRole('button', { name: copy.common.delete, exact: true })
				.click();

			// The confirmation says the house sentence and repeats the bare verb.
			const confirm = page.getByRole('dialog');
			await expect(confirm.getByText(copy.ui.confirmDialog.undone)).toBeVisible();
			await expect(
				confirm.getByRole('heading', { name: cpl.deleteTitle('Mallory') })
			).toBeVisible();
			await confirm.getByRole('button', { name: copy.common.delete, exact: true }).click();

			await expect(page.getByRole('listitem').filter({ hasText: 'Mallory' })).toHaveCount(0);
		} finally {
			fixture.teardown();
			member.teardown();
		}
	});

	test('a member can leave a trip they did not organize', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		const member = await registerUser(request, { name: 'Wanderer' });
		await invite(request, fixture, member.email);
		try {
			await signIn(page, member.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/discover`);

			// A non-organizer's header offers Leave, not Edit.
			await page.getByRole('button', { name: copy.tripShell.leaveTrip }).click();
			const confirm = page.getByRole('dialog');
			await expect(
				confirm.getByRole('heading', {
					name: copy.tripShell.leaveDialog.title(fixture.tripBody.name)
				})
			).toBeVisible();
			await expect(confirm.getByText(copy.ui.confirmDialog.undone)).toBeVisible();
			await confirm.getByRole('button', { name: copy.common.leave, exact: true }).click();

			// Leaving drops them back to the list, and the trip is no longer theirs to read.
			await expect(page).toHaveURL(/\/trips$/);
			await page.goto(`/trips/${fixture.tripId}/discover`);
			await expect(page.getByText(copy.tripShell.notFound)).toBeVisible();
		} finally {
			fixture.teardown();
			member.teardown();
		}
	});
});
