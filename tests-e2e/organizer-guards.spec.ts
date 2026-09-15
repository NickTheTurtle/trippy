import { expect, test } from '@playwright/test';
import { createApiFixture, registerUser } from './fixtures/api';
import { apiSend, invite } from './fixtures/seed';

/**
 * The organizer-only guards, proven reachable through the route.
 *
 * The exhaustive matrix (who may edit, delete, add a city, remove a member)
 * lives at the persistence layer in packages/server, where it is fast. These
 * two exist for the one thing that layer cannot show: that the guard is wired
 * into the route at all. A guard that exists in persistence but was never called
 * from the handler would pass every unit test and still let a member delete the
 * group's trip; only a request-level test catches that.
 *
 * They also pin the two different shapes the refusal takes on the wire, which is
 * easy to get wrong: delete answers 403 (a member asking to destroy the trip is
 * refused outright), while edit answers 400 because the route forwards whatever
 * message the server function returns rather than choosing a status itself.
 */
test.describe('organizer guards are wired into the routes', () => {
	test('a member cannot delete the trip (403)', async ({ request }) => {
		const fixture = await createApiFixture(request);
		const member = await registerUser(request);
		try {
			// A real second account, added to the trip as a plain member.
			await invite(request, fixture, member.email, member.name);

			const res = await apiSend(request, member, 'DELETE', `/trips/${fixture.tripId}`);
			expect(res.status(), await res.text()).toBe(403);
			expect((await res.json()).error).toBe(
				'Only the organizer can delete this trip. You can leave it instead.'
			);
		} finally {
			member.teardown();
			fixture.teardown();
		}
	});

	test('a member cannot edit the trip, and the refusal keeps its wording (400)', async ({
		request
	}) => {
		const fixture = await createApiFixture(request);
		const member = await registerUser(request);
		try {
			await invite(request, fixture, member.email, member.name);

			const res = await apiSend(request, member, 'PATCH', `/trips/${fixture.tripId}`, {
				name: 'Renamed by a member',
				startDate: '2027-02-10',
				endDate: '2027-02-12',
				currency: 'USD'
			});
			// The route forwards the server's message verbatim, so it lands as a 400
			// rather than a 403, and the organizer-only wording still reaches the client.
			expect(res.status(), await res.text()).toBe(400);
			expect((await res.json()).error).toBe('Only the organizer can edit this trip.');
		} finally {
			member.teardown();
			fixture.teardown();
		}
	});
});
