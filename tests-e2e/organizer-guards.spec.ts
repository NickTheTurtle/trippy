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
 * They also pin the shape the refusal takes on the wire: both answer 403, the
 * `respond.ts` status for "a member, but not allowed". Edit used to answer 400
 * because the route forwarded the server function's message without choosing a
 * status, which told a member their values were wrong when their role was.
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

	test('a member cannot edit the trip, and the refusal keeps its wording (403)', async ({
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
			// Refused on role, before any value is looked at, with the
			// organizer-only wording.
			expect(res.status(), await res.text()).toBe(403);
			expect((await res.json()).error).toBe('Only the organizer can edit this trip.');
		} finally {
			member.teardown();
			fixture.teardown();
		}
	});
});
