import { expect, test, type Locator, type Page } from '@playwright/test';
import { apiURL, createApiFixture, registerUser } from './fixtures/api';
import { addExpense, expensesData, invite, seedMembers } from './fixtures/seed';
import { copy, formatMoney } from './fixtures/copy';
import { signIn, signedInContext } from './fixtures/session';

/**
 * Expenses: the ledger, the balances it nets out to, and the transfers that
 * clear them. The highest-value area, so it is the most thorough.
 *
 * State is seeded through the API and read back on the page wherever the split
 * maths is the point, because clicking every participant in is slower and adds
 * nothing the API does not. The add dialog, the exact-sum refusal, the
 * concurrent-edit conflict and settling up are driven through the UI, because
 * there the flow itself is what is under test.
 */

const ce = copy.expenses;
const usd = (cents: number) => formatMoney(cents, 'USD');

/** Opens a custom Select by its accessible name and chooses one option. */
async function chooseInSelect(scope: Locator, triggerName: string, option: string) {
	await scope.getByRole('button', { name: triggerName }).click();
	await scope.getByRole('option', { name: option, exact: true }).click();
}

/** Switches to a section of the Expenses page by its nav button. */
async function goToSection(page: Page, label: string) {
	await page.getByRole('button', { name: label }).click();
}

/** The balances row for one member, located by the name it carries. */
function balanceRow(page: Page, name: string): Locator {
	return page.getByRole('listitem').filter({ hasText: name });
}

test.describe('expenses', () => {
	test('an even split agrees across the row, the trip total and the balances', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await seedMembers(request, fixture, ['Alice', 'Bob']);
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/expenses`);

			// Added through the dialog, because turning a form into a ledger row, a
			// total and three balances is exactly the flow this asserts.
			await page.getByRole('button', { name: ce.addExpense, exact: true }).click();
			const dialog = page.getByRole('dialog');
			await dialog.getByLabel(ce.addDialog.descriptionLabel).fill('Dinner');
			await dialog.getByLabel(ce.addDialog.amountLabel).fill('90');
			await chooseInSelect(dialog, ce.addDialog.paidByLabel, 'E2E User');
			await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();
			await expect(dialog).toBeHidden();

			// The row reads the whole amount, and the trip total matches it.
			const row = page.getByRole('listitem').filter({ hasText: 'Dinner' });
			await expect(row).toContainText(usd(9000));
			const totalStat = page.getByText(ce.tripTotal, { exact: true }).locator('..');
			await expect(totalStat).toContainText(usd(9000));
			// Split three ways, the per-person headline is a third of the total.
			const perPersonStat = page.getByText(ce.perPerson, { exact: true }).locator('..');
			await expect(perPersonStat).toContainText(usd(3000));

			// The payer covered ninety and owes a third of it, so is up sixty; the
			// two who owe a third each are down thirty. Signs and figures agree.
			await goToSection(page, ce.sections.balances);
			await expect(balanceRow(page, 'E2E User')).toContainText(`+${usd(6000)}`);
			await expect(balanceRow(page, 'Alice')).toContainText(usd(-3000));
			await expect(balanceRow(page, 'Bob')).toContainText(usd(-3000));

			// The API view agrees with the page: the balances net to zero.
			const data = await expensesData(request, fixture);
			expect(data.balances.reduce((n, b) => n + b.netCents, 0)).toBe(0);
			const byName = Object.fromEntries(data.balances.map((b) => [b.name, b.netCents]));
			expect(byName['E2E User']).toBe(6000);
			expect(byName['Alice']).toBe(-3000);
			expect(byName['Bob']).toBe(-3000);
		} finally {
			fixture.teardown();
		}
	});

	test('a split by shares divides in proportion to the shares', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			const members = await seedMembers(request, fixture, ['Alice', 'Bob']);
			// Alice carries two shares to one each for Bob and the payer: of 120 that
			// is 60, 30 and 30. Seeded, since the arithmetic, not the widget, is the point.
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Boat by shares',
				amount: 120,
				payerId: fixture.userId,
				splitMode: 'shares',
				participantIds: [fixture.userId, members['Alice'], members['Bob']],
				weights: { [fixture.userId]: 1, [members['Alice']]: 2, [members['Bob']]: 1 }
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/expenses`);

			// The row names its mode and its participant count.
			const row = page.getByRole('listitem').filter({ hasText: 'Boat by shares' });
			await expect(row).toContainText(ce.row.splitLabel('shares', 3));

			// Payer paid 120, owes 30, so is up 90; Alice down 60; Bob down 30.
			await goToSection(page, ce.sections.balances);
			await expect(balanceRow(page, 'E2E User')).toContainText(`+${usd(9000)}`);
			await expect(balanceRow(page, 'Alice')).toContainText(usd(-6000));
			await expect(balanceRow(page, 'Bob')).toContainText(usd(-3000));
		} finally {
			fixture.teardown();
		}
	});

	test('a split by exact amounts charges each person the amount stated', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			const members = await seedMembers(request, fixture, ['Alice', 'Bob']);
			// Exact weights are major units: fifty, thirty and twenty make the hundred.
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Taxi by amount',
				amount: 100,
				payerId: fixture.userId,
				splitMode: 'exact',
				participantIds: [fixture.userId, members['Alice'], members['Bob']],
				weights: { [fixture.userId]: 20, [members['Alice']]: 50, [members['Bob']]: 30 }
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/expenses`);

			const row = page.getByRole('listitem').filter({ hasText: 'Taxi by amount' });
			await expect(row).toContainText(ce.row.splitLabel('exact', 3));

			// Payer paid 100 and owes only their own 20, so is up 80; Alice down 50; Bob down 30.
			await goToSection(page, ce.sections.balances);
			await expect(balanceRow(page, 'E2E User')).toContainText(`+${usd(8000)}`);
			await expect(balanceRow(page, 'Alice')).toContainText(usd(-5000));
			await expect(balanceRow(page, 'Bob')).toContainText(usd(-3000));
		} finally {
			fixture.teardown();
		}
	});

	test('an exact split whose amounts do not sum to the total is refused, naming both figures', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			const members = await seedMembers(request, fixture, ['Alice']);
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/expenses`);

			// A short allocation used to be refused by the client, which disabled the
			// button and left the user to work out why. The route names both figures,
			// so the dialog now submits and repeats what it was told. Seed amounts of
			// 40 and 30 against a total of 100.
			await page.getByRole('button', { name: ce.addExpense, exact: true }).click();
			const dialog = page.getByRole('dialog');
			await dialog.getByLabel(ce.addDialog.descriptionLabel).fill('Split short');
			await dialog.getByLabel(ce.addDialog.amountLabel).fill('100');
			await dialog.getByRole('button', { name: ce.addDialog.modes.exact.label }).click();
			await dialog.getByLabel(ce.addDialog.weightLabel(true, 'E2E User')).fill('40');
			await dialog.getByLabel(ce.addDialog.weightLabel(true, 'Alice')).fill('30');
			await dialog.getByRole('button', { name: copy.common.add, exact: true }).click();

			await expect(dialog.getByRole('alert')).toHaveText(
				'Amounts add up to 70.00, but the total is 100.00.'
			);
			await expect(dialog).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('a zero-weight participant is stored as owing nothing', async ({ page, request }) => {
		const fixture = await createApiFixture(request);
		try {
			const members = await seedMembers(request, fixture, ['Alice', 'Bob']);
			// Alice is in on it but carries no shares, so the whole hundred falls on
			// the payer and Bob, and Alice owes zero rather than an even third.
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Zero share',
				amount: 100,
				payerId: fixture.userId,
				splitMode: 'shares',
				participantIds: [fixture.userId, members['Alice'], members['Bob']],
				weights: { [fixture.userId]: 1, [members['Alice']]: 0, [members['Bob']]: 1 }
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/expenses`);

			// A zero balance is not rendered, so Alice is absent from the list while
			// the two who share the cost are present.
			await goToSection(page, ce.sections.balances);
			await expect(balanceRow(page, 'E2E User')).toBeVisible();
			await expect(balanceRow(page, 'Bob')).toBeVisible();
			await expect(balanceRow(page, 'Alice')).toHaveCount(0);

			// The stored share is exactly zero, not a rounded sliver.
			const data = await expensesData(request, fixture);
			expect(data.expenses[0].shares[members['Alice']]).toBe(0);
		} finally {
			fixture.teardown();
		}
	});

	test('a negative amount records income and credits the participants', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			const members = await seedMembers(request, fixture, ['Alice', 'Bob']);
			// A refund of sixty coming back to the group: entered as a negative
			// amount, it credits everyone selected instead of charging them.
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Deposit refund',
				amount: -60,
				payerId: fixture.userId,
				participantIds: [fixture.userId, members['Alice'], members['Bob']]
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/expenses`);

			// The row is tagged income and shows the amount as a credit.
			const row = page.getByRole('listitem').filter({ hasText: 'Deposit refund' });
			await expect(row).toContainText(ce.row.incomeTag);
			await expect(row).toContainText(usd(-6000));

			// However it is signed, a ledger with one entry still nets to zero.
			const data = await expensesData(request, fixture);
			expect(data.balances.reduce((n, b) => n + b.netCents, 0)).toBe(0);
		} finally {
			fixture.teardown();
		}
	});

	test('a foreign-currency expense converts at the rate locked when it was recorded', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			const members = await seedMembers(request, fixture, ['Alice', 'Bob']);
			// A ninety-euro dinner in a dollar trip. The home figure must be the sum
			// of its own shares at the rate it was recorded at, not today's rate: a
			// read path that reconverted was a real bug, and the shares and the
			// balances would silently disagree with the headline.
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Euro dinner',
				amount: 90,
				currency: 'EUR',
				payerId: fixture.userId,
				participantIds: [fixture.userId, members['Alice'], members['Bob']]
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/expenses`);

			// The row shows the euro amount and an approximate home figure beneath it.
			const row = page.getByRole('listitem').filter({ hasText: 'Euro dinner' });
			await expect(row).toContainText('€');
			await expect(row).toContainText('≈');

			const data = await expensesData(request, fixture);
			const exp = data.expenses[0];
			const shareSum = Object.values(exp.shares).reduce((n, c) => n + c, 0);
			// The locked home figure equals the sum of the shares built from it.
			expect(exp.home_cents).toBe(shareSum);
			// And the page prints that exact figure, not a fresh conversion.
			await expect(row).toContainText(`≈ ${usd(exp.home_cents)}`);
		} finally {
			fixture.teardown();
		}
	});

	test('a second editor saving the same expense is refused without losing the first write', async ({
		browser,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			await seedMembers(request, fixture, ['Alice']);
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Original',
				amount: 60,
				payerId: fixture.userId,
				participantIds: [fixture.userId]
			});

			const { context: ctxA, page: pageA } = await signedInContext(browser, fixture.sessionCookie);
			const { context: ctxB, page: pageB } = await signedInContext(browser, fixture.sessionCookie);
			try {
				await pageA.goto(`/trips/${fixture.tripId}/expenses`);
				await pageB.goto(`/trips/${fixture.tripId}/expenses`);

				// Both open the same expense at the version it currently has.
				await pageA.getByRole('button', { name: ce.row.editLabel('Original') }).click();
				await pageB.getByRole('button', { name: ce.row.editLabel('Original') }).click();
				const dialogA = pageA.getByRole('dialog');
				const dialogB = pageB.getByRole('dialog');
				await expect(dialogA).toBeVisible();
				await expect(dialogB).toBeVisible();

				// A saves first and wins.
				await dialogA.getByLabel(ce.addDialog.descriptionLabel).fill('Kept from A');
				await dialogA.getByRole('button', { name: copy.common.save, exact: true }).click();
				await expect(dialogA).toBeHidden();

				// B saved against a version that no longer exists: refused, and told
				// to reload rather than silently overwriting A.
				await dialogB.getByLabel(ce.addDialog.descriptionLabel).fill('Lost from B');
				await dialogB.getByRole('button', { name: copy.common.save, exact: true }).click();
				await expect(
					dialogB.getByText('Someone else changed this expense. Reload to see their version.')
				).toBeVisible();

				// The first write survived; B's was not applied.
				const data = await expensesData(request, fixture);
				expect(data.expenses[0].description).toBe('Kept from A');
			} finally {
				await ctxA.close();
				await ctxB.close();
			}
		} finally {
			fixture.teardown();
		}
	});

	test('marking a suggested transfer paid clears the balance it settles', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			const members = await seedMembers(request, fixture, ['Alice']);
			// Payer covers ninety split with Alice, so Alice owes forty-five and the
			// settlement suggests exactly that transfer.
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Shared cab',
				amount: 90,
				payerId: fixture.userId,
				participantIds: [fixture.userId, members['Alice']]
			});
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/expenses`);

			await goToSection(page, ce.sections.settle);
			await page
				.getByRole('button', { name: ce.settleRow.markPaidLabel('Alice', 'E2E User', usd(4500)) })
				.click();

			// Once the payment lands, there is nothing left to settle and the
			// balances read as even.
			await expect(page.getByText(ce.nothingToSettle)).toBeVisible();
			await goToSection(page, ce.sections.balances);
			await expect(page.getByText(ce.allEven)).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('settling the same suggested transfer twice records one payment, not two', async ({
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			const members = await seedMembers(request, fixture, ['Alice']);
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Shared cab',
				amount: 90,
				payerId: fixture.userId,
				participantIds: [fixture.userId, members['Alice']]
			});

			// The suggestion carries a token derived from the balances it settles.
			// Sending it twice must collapse to one payment: a second press, or a
			// second member pressing at the same instant, would otherwise invert the
			// debt. Driven through the API to control the timing exactly.
			const before = await expensesData(request, fixture);
			const t = before.settlement[0];

			const settle = () =>
				request.post(`${apiURL}/trips/${fixture.tripId}/expenses/settle`, {
					headers: { cookie: fixture.sessionCookie },
					data: { fromId: t.fromId, toId: t.toId, amountCents: t.amountCents, token: t.token }
				});

			const first = await settle();
			expect(first.status()).toBe(201);
			const second = await settle();
			// A repeat answers 200 and flags itself a duplicate rather than writing again.
			expect(second.status()).toBe(200);
			expect((await second.json()).duplicate).toBe(true);

			// One payment recorded, and the balances came out even.
			const after = await expensesData(request, fixture);
			const payments = after.expenses.filter((e) => e.settlement === 1);
			expect(payments).toHaveLength(1);
			expect(after.balances.reduce((n, b) => n + b.netCents, 0)).toBe(0);
		} finally {
			fixture.teardown();
		}
	});

	test('removing an invited member who owes money keeps the expense and marks it for review', async ({
		page,
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			// An invited placeholder is deleted outright when nothing points at
			// them, and that delete cascades. Naming them on an expense has to
			// change the answer: the cascade would take a row the group already
			// agreed, so they are kept off the trip but on the ledger instead.
			const members = await seedMembers(request, fixture, ['Ghost']);
			const ghostId = members['Ghost'];
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Shared taxi',
				amount: 50,
				payerId: fixture.userId,
				splitMode: 'exact',
				participantIds: [fixture.userId, ghostId],
				weights: { [fixture.userId]: 20, [ghostId]: 30 }
			});

			const removed = await request.delete(`${apiURL}/trips/${fixture.tripId}/people/${ghostId}`, {
				headers: { cookie: fixture.sessionCookie }
			});
			expect(removed.status()).toBe(200);

			const data = await expensesData(request, fixture);
			const taxi = data.expenses.find((e) => e.description === 'Shared taxi');
			// The expense is still there and still worth what it was.
			expect(taxi).toBeTruthy();
			expect(taxi!.amount_cents).toBe(5000);
			expect((taxi as { needsReview?: boolean }).needsReview).toBe(true);
			expect(data.balances.reduce((n, b) => n + b.netCents, 0)).toBe(0);

			// And the row says so on screen, as a sign rather than a sentence.
			await signIn(page, fixture.sessionCookie);
			await page.goto(`/trips/${fixture.tripId}/expenses`);
			const row = page.getByRole('listitem').filter({ hasText: 'Shared taxi' }).first();
			await expect(row.getByRole('img', { name: ce.row.reviewTitle })).toBeVisible();
		} finally {
			fixture.teardown();
		}
	});

	test('removing a member with money in the ledger re-divides even splits and flags exact ones', async ({
		request
	}) => {
		const fixture = await createApiFixture(request);
		// Bob is a real account rather than a placeholder, so this covers the
		// ordinary member path. The placeholder path is covered separately below,
		// since it reaches the same outcome by a different route.
		const bob = await registerUser(request, { name: 'Bob' });
		try {
			const members = await seedMembers(request, fixture, ['Alice']);
			await invite(request, fixture, bob.email);
			const aliceId = members['Alice'];
			// One even expense and one exact expense, both charging Bob.
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Even meal',
				amount: 90,
				payerId: fixture.userId,
				participantIds: [fixture.userId, aliceId, bob.userId]
			});
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Exact meal',
				amount: 90,
				payerId: fixture.userId,
				splitMode: 'exact',
				participantIds: [fixture.userId, aliceId, bob.userId],
				weights: { [fixture.userId]: 30, [aliceId]: 30, [bob.userId]: 30 }
			});

			// Bob leaves the trip with money still on both expenses.
			const removed = await request.delete(
				`${apiURL}/trips/${fixture.tripId}/people/${bob.userId}`,
				{ headers: { cookie: fixture.sessionCookie } }
			);
			expect(removed.status()).toBe(200);

			const data = await expensesData(request, fixture);
			const even = data.expenses.find((e) => e.description === 'Even meal')!;
			const exact = data.expenses.find((e) => e.description === 'Exact meal')!;

			// The even split re-divides among who is left: Bob no longer carries a share.
			expect(even.shares[bob.userId] ?? 0).toBe(0);
			// The exact split cannot be re-divided (only the group can say who
			// absorbs a stated amount), so it is flagged for review instead.
			expect((exact as { needsReview?: boolean }).needsReview).toBe(true);
			// Either way the ledger still nets to zero.
			expect(data.balances.reduce((n, b) => n + b.netCents, 0)).toBe(0);
		} finally {
			fixture.teardown();
			bob.teardown();
		}
	});
});
