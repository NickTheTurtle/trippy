import { expect, test } from '@playwright/test';
import { createApiFixture } from './fixtures/api';
import { addExpense, apiSend, expensesData, seedMembers } from './fixtures/seed';

/**
 * The settle-up endpoint's two refusals, and the boundary it does allow.
 *
 * The ledger already knows what each person owes, so a transfer is held to it
 * rather than trusted from the client: a payment from someone who owes nothing,
 * or one larger than the debt, would invert the balance it was meant to clear.
 * Both guards live in the route handler, so they are exercised through the API
 * with the status left unasserted (`apiSend`), which is exactly what a
 * refusal-branch test needs to read a 400 back.
 *
 * The fixture's own account (`E2E User`) pays ninety split evenly with Alice, so
 * Alice owes forty-five and the fixture is owed forty-five. That one expense is
 * all three cases need.
 */
test.describe('settle-up guards', () => {
	test('refuses a payment from someone who does not owe anything', async ({ request }) => {
		const fixture = await createApiFixture(request);
		try {
			await seedMembers(request, fixture, ['Alice']);
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Shared cab',
				amount: 90,
				payerId: fixture.userId,
				participantIds: [fixture.userId]
			});

			// The fixture paid for itself alone, so it is owed nothing and owes
			// nothing: a transfer out of a zero (or positive) balance is refused.
			const res = await apiSend(
				request,
				fixture,
				'POST',
				`/trips/${fixture.tripId}/expenses/settle`,
				{
					fromId: fixture.userId,
					toId: fixture.userId,
					amountCents: 1000
				}
			);
			expect(res.status()).toBe(400);
			expect((await res.json()).error).toBe('That person does not owe anything.');
		} finally {
			fixture.teardown();
		}
	});

	test('refuses an amount larger than the debt', async ({ request }) => {
		const fixture = await createApiFixture(request);
		try {
			const members = await seedMembers(request, fixture, ['Alice']);
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Shared cab',
				amount: 90,
				payerId: fixture.userId,
				participantIds: [fixture.userId, members['Alice']]
			});

			// Alice owes exactly 4500. One cent over her debt would tip her balance
			// past zero into the fixture's favour, so it is refused.
			const res = await apiSend(
				request,
				fixture,
				'POST',
				`/trips/${fixture.tripId}/expenses/settle`,
				{
					fromId: members['Alice'],
					toId: fixture.userId,
					amountCents: 4501
				}
			);
			expect(res.status()).toBe(400);
			expect((await res.json()).error).toBe(
				'That is more than they owe. Enter the outstanding amount or less.'
			);
		} finally {
			fixture.teardown();
		}
	});

	test('settles exactly the full debt', async ({ request }) => {
		const fixture = await createApiFixture(request);
		try {
			const members = await seedMembers(request, fixture, ['Alice']);
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Shared cab',
				amount: 90,
				payerId: fixture.userId,
				participantIds: [fixture.userId, members['Alice']]
			});

			// The suggestion is exactly Alice's debt; paying it to the cent is the
			// boundary the guard allows (refused only when strictly greater).
			const before = await expensesData(request, fixture);
			const t = before.settlement[0];
			expect(t.amountCents).toBe(4500);

			const res = await apiSend(
				request,
				fixture,
				'POST',
				`/trips/${fixture.tripId}/expenses/settle`,
				{
					fromId: t.fromId,
					toId: t.toId,
					amountCents: t.amountCents,
					token: t.token
				}
			);
			expect(res.status(), await res.text()).toBe(201);

			// Paying the whole debt leaves the ledger even and nothing to settle.
			const after = await expensesData(request, fixture);
			expect(after.settlement).toHaveLength(0);
			expect(after.balances.reduce((n, b) => n + b.netCents, 0)).toBe(0);
		} finally {
			fixture.teardown();
		}
	});
});
