import { expect, test, type BrowserContext } from '@playwright/test';
import { apiURL, createApiFixture, registerUser, type RegisteredUser } from './fixtures/api';
import {
	addCity,
	addExpense,
	addPlace,
	addStay,
	addTask,
	apiSend,
	discoverStays,
	expensesData,
	invite
} from './fixtures/seed';
import { copy } from './fixtures/copy';
import { signIn, signedInContext, logOut } from './fixtures/session';

/**
 * Concurrency: two people (or one person in two places) writing the same trip
 * at the same time.
 *
 * Every case asserts two separate claims: what the database ended up holding,
 * read straight back through the API, and what the browser showed. They are not
 * the same claim. "The screen looks right" can hide a lost write, and "the row
 * was written" can hide a screen that never caught up. The interesting failures
 * live exactly where the two diverge, so both are checked.
 *
 * State is seeded and raced through the API rather than clicked, because the
 * point here is simultaneity: `Promise.all` on two authenticated requests is
 * the only way to fire two writes at genuinely the same moment. node:sqlite is
 * a single synchronous writer, so the two handlers serialize inside the one API
 * process; that is expected and fine, as long as it never turns two writes into
 * one lost update, which is what these assert.
 */

const ce = copy.expenses;

const LISBON = { name: 'Lisbon', country: 'Portugal', tz: 'Europe/Lisbon' };

/** Sums the net balances the API reports; a coherent ledger always nets to zero. */
function netsToZero(balances: { netCents: number }[]): number {
	return balances.reduce((sum, b) => sum + b.netCents, 0);
}

test.describe('concurrency: same account in two places at once', () => {
	// One person with the trip open on a laptop and a phone: two contexts, but
	// the same session cookie copied into both, so both are the same user.

	test('an edit made in one tab reaches the other tab live over the stream', async ({
		browser,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const contexts: BrowserContext[] = [];
		try {
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Brunch',
				amount: 40,
				payerId: fixture.userId,
				participantIds: [fixture.userId]
			});

			const a = await signedInContext(browser, fixture.sessionCookie);
			const b = await signedInContext(browser, fixture.sessionCookie);
			contexts.push(a.context, b.context);
			await signIn(a.page, fixture.sessionCookie);
			await signIn(b.page, fixture.sessionCookie);
			await a.page.goto(`/trips/${fixture.tripId}/expenses`);
			await b.page.goto(`/trips/${fixture.tripId}/expenses`);
			await expect(b.page.getByRole('listitem').filter({ hasText: 'Brunch' })).toBeVisible();

			// Rename it through the edit dialog in tab A, the way a real click does.
			await a.page.getByRole('button', { name: copy.common.editLabel('Brunch') }).click();
			const dialog = a.page.getByRole('dialog');
			await dialog.getByLabel(ce.addDialog.descriptionLabel).fill('Brunch renamed');
			await dialog.getByRole('button', { name: copy.common.save, exact: true }).click();
			await expect(dialog).toBeHidden();

			// Tab B never reloaded: the rename arrives on its own over SSE. Because
			// tab B has no dialog open, its refetch is not deferred and lands at once.
			await expect(
				b.page.getByRole('listitem').filter({ hasText: 'Brunch renamed' })
			).toBeVisible();

			// And the database agrees: one expense, carrying the new description.
			const data = await expensesData(request, fixture);
			expect(data.expenses).toHaveLength(1);
			expect(data.expenses[0].description).toBe('Brunch renamed');
		} finally {
			for (const c of contexts) await c.close();
			await fixture.teardown();
		}
	});

	test('both tabs saving the same expense refuses the second and keeps the first write', async ({
		request
	}) => {
		// Same account, two writes carrying the same base version. Optimistic
		// concurrency turns the loser into a 409 rather than a silent clobber, so
		// exactly one lands and the winner survives untouched.
		const fixture = await createApiFixture(request);
		try {
			const id = await addExpense(request, fixture, fixture.tripId, {
				description: 'Base',
				amount: 40,
				payerId: fixture.userId,
				participantIds: [fixture.userId]
			});
			const before = await expensesData(request, fixture);
			const version = before.expenses.find((e) => e.id === id)!.version;

			const put = (description: string) =>
				apiSend(request, fixture, 'PUT', `/trips/${fixture.tripId}/expenses/${id}`, {
					description,
					amount: 40,
					currency: 'USD',
					payerId: fixture.userId,
					splitMode: 'even',
					participantIds: [fixture.userId],
					version
				});
			const [first, second] = await Promise.all([put('First writer'), put('Second writer')]);

			// One save applied, one was refused for carrying a stale version.
			expect([first.status(), second.status()].sort()).toEqual([200, 409]);

			// The surviving description is exactly the one whose request returned
			// 200; the refused write left no trace, and the version moved once.
			const winner = first.status() === 200 ? 'First writer' : 'Second writer';
			const after = await expensesData(request, fixture);
			const now = after.expenses.find((e) => e.id === id)!;
			expect(now.description).toBe(winner);
			expect(now.version).toBe(version + 1);
		} finally {
			await fixture.teardown();
		}
	});

	test('a tab that was offline during a change catches up when it reconnects', async ({
		browser,
		request
	}) => {
		// The SSE stream replays with Last-Event-ID, so a tab that missed events
		// while backgrounded gets them on reconnect rather than showing a stale
		// screen forever. A warm-up change first, so the tab holds a Last-Event-ID
		// to resume from (which biases the reconnect to the replay path).
		const fixture = await createApiFixture(request);
		let context: BrowserContext | null = null;
		try {
			const b = await signedInContext(browser, fixture.sessionCookie);
			context = b.context;
			await signIn(b.page, fixture.sessionCookie);
			await b.page.goto(`/trips/${fixture.tripId}/expenses`);

			await addExpense(request, fixture, fixture.tripId, {
				description: 'Warm up',
				amount: 20,
				payerId: fixture.userId,
				participantIds: [fixture.userId]
			});
			await expect(b.page.getByRole('listitem').filter({ hasText: 'Warm up' })).toBeVisible();

			// Cut the tab off, change the trip while it cannot hear, then reconnect.
			await context.setOffline(true);
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Missed while away',
				amount: 30,
				payerId: fixture.userId,
				participantIds: [fixture.userId]
			});
			await context.setOffline(false);

			// The browser's own EventSource retry resumes with Last-Event-ID and
			// the missed event replays, so the row it never saw appears. The retry
			// can take a few seconds, so this assertion is given room.
			await expect(
				b.page.getByRole('listitem').filter({ hasText: 'Missed while away' })
			).toBeVisible({ timeout: 20_000 });
		} finally {
			if (context) await context.close();
			await fixture.teardown();
		}
	});

	test('a resume point from a previous process is answered with a reset, not a silent gap', async ({
		browser,
		request
	}) => {
		// A Last-Event-ID from an earlier server process carries a stale epoch. The
		// stream cannot know which events were missed, so it must answer `reset`
		// and let the client refetch everything rather than replay a wrong slice.
		// Driven at the transport, because this is a property of the stream itself:
		// Playwright's request API would block on an endless SSE body, so the read
		// is done inside the page with fetch and an AbortController.
		const fixture = await createApiFixture(request);
		let context: BrowserContext | null = null;
		try {
			const b = await signedInContext(browser, fixture.sessionCookie);
			context = b.context;
			await signIn(b.page, fixture.sessionCookie);
			await b.page.goto(`/trips/${fixture.tripId}/expenses`);

			const body = await b.page.evaluate(async (tripId) => {
				const controller = new AbortController();
				const res = await fetch(`/api/trips/${tripId}/events`, {
					headers: { 'Last-Event-ID': 'deadbeef.5' },
					signal: controller.signal
				});
				const reader = res.body!.getReader();
				const decoder = new TextDecoder();
				let text = '';
				const deadline = Date.now() + 4000;
				while (Date.now() < deadline) {
					const { value, done } = await reader.read();
					if (done) break;
					text += decoder.decode(value, { stream: true });
					if (text.includes('event: reset')) break;
				}
				controller.abort();
				return text;
			}, fixture.tripId);

			expect(body).toContain('event: reset');
		} finally {
			if (context) await context.close();
			await fixture.teardown();
		}
	});

	test('logging out in one tab makes the other tab fail cleanly, not hang', async ({
		browser,
		request
	}) => {
		// Both tabs share one session token. Logging out in A destroys that token
		// server-side, so B's next write must fail visibly and B must be bounced to
		// login on its next navigation, never left spinning on a dead session.
		const fixture = await createApiFixture(request);
		const contexts: BrowserContext[] = [];
		try {
			const a = await signedInContext(browser, fixture.sessionCookie);
			const b = await signedInContext(browser, fixture.sessionCookie);
			contexts.push(a.context, b.context);
			await signIn(a.page, fixture.sessionCookie);
			await signIn(b.page, fixture.sessionCookie);
			await a.page.goto('/trips');
			await b.page.goto(`/trips/${fixture.tripId}/expenses`);

			await logOut(a.page);

			// B's next write goes out on the shared session token, which A's logout
			// destroyed. It is refused rather than silently accepted.
			const write = await apiSend(request, fixture, 'POST', `/trips/${fixture.tripId}/expenses`, {
				description: 'Ghost',
				amount: 10,
				payerId: fixture.userId,
				participantIds: [fixture.userId]
			});
			expect(write.status()).toBe(401);

			// Database-visible: the dead session no longer authorizes reads either,
			// so nothing B attempts can have landed.
			const check = await apiSend(request, fixture, 'GET', `/trips/${fixture.tripId}/expenses`);
			expect(check.status()).toBe(401);

			// Browser-visible consequence: B's open page, on its next navigation, is
			// bounced to login by the auth guard rather than hanging on a spinner or
			// rendering a half-alive trip on a session that no longer exists.
			await b.page.reload();
			await expect(b.page).toHaveURL(/\/login/);
		} finally {
			for (const c of contexts) await c.close();
			await fixture.teardown();
		}
	});
});

test.describe('concurrency: two accounts on one trip', () => {
	// The real collaboration case: an organizer and a second registered member,
	// each in their own context with their own cookie jar.

	async function addRealMember(
		request: Parameters<typeof registerUser>[0],
		fixture: Awaited<ReturnType<typeof createApiFixture>>,
		name: string
	): Promise<RegisteredUser> {
		const user = await registerUser(request, { name });
		// A registered address is added straight to the trip, so this makes a real
		// member (not a placeholder) who can pay, owe and be authorized on routes.
		await invite(request, fixture, user.email);
		return user;
	}

	test('two members adding an expense at the same moment both land and still net to zero', async ({
		request
	}) => {
		const fixture = await createApiFixture(request);
		const bob = await addRealMember(request, fixture, 'Bob');
		try {
			const both = [fixture.userId, bob.userId];
			const [alice, bobs] = await Promise.all([
				apiSend(request, fixture, 'POST', `/trips/${fixture.tripId}/expenses`, {
					description: 'Alice dinner',
					amount: 30,
					payerId: fixture.userId,
					participantIds: both
				}),
				apiSend(request, bob, 'POST', `/trips/${fixture.tripId}/expenses`, {
					description: 'Bob lunch',
					amount: 20,
					payerId: bob.userId,
					participantIds: both
				})
			]);
			expect(alice.status()).toBe(201);
			expect(bobs.status()).toBe(201);

			// Nothing was lost: both rows are there, the trip total is their sum, and
			// the ledger still balances.
			const data = await expensesData(request, fixture);
			expect(data.expenses).toHaveLength(2);
			const total = data.expenses.reduce((sum, e) => sum + e.home_cents, 0);
			expect(total).toBe(5000);
			expect(netsToZero(data.balances)).toBe(0);
		} finally {
			await bob.teardown();
			await fixture.teardown();
		}
	});

	test('two members editing the same expense refuses the loser and keeps the winner intact', async ({
		browser,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const bob = await addRealMember(request, fixture, 'Bob');
		let context: BrowserContext | null = null;
		try {
			const both = [fixture.userId, bob.userId];
			const id = await addExpense(request, fixture, fixture.tripId, {
				description: 'Shared cab',
				amount: 40,
				payerId: fixture.userId,
				participantIds: both
			});
			const version = (await expensesData(request, fixture)).expenses.find(
				(e) => e.id === id
			)!.version;

			// Bob has the expenses page open, watching.
			const view = await signedInContext(browser, bob.sessionCookie);
			context = view.context;
			await signIn(view.page, bob.sessionCookie);
			await view.page.goto(`/trips/${fixture.tripId}/expenses`);
			await expect(view.page.getByRole('listitem').filter({ hasText: 'Shared cab' })).toBeVisible();

			const put = (client: { sessionCookie: string }, description: string) =>
				apiSend(request, client, 'PUT', `/trips/${fixture.tripId}/expenses/${id}`, {
					description,
					amount: 40,
					currency: 'USD',
					payerId: fixture.userId,
					splitMode: 'even',
					participantIds: both,
					version
				});
			const [aRes, bRes] = await Promise.all([
				put(fixture, 'Alice version'),
				put(bob, 'Bob version')
			]);
			expect([aRes.status(), bRes.status()].sort()).toEqual([200, 409]);

			const winner = aRes.status() === 200 ? 'Alice version' : 'Bob version';
			const after = await expensesData(request, fixture);
			const now = after.expenses.find((e) => e.id === id)!;
			expect(now.description).toBe(winner);
			expect(now.version).toBe(version + 1);

			// Bob's open page must not be left showing a value that was never saved:
			// it converges on the winner, whichever of them that was.
			await expect(view.page.getByRole('listitem').filter({ hasText: winner })).toBeVisible();
		} finally {
			if (context) await context.close();
			await bob.teardown();
			await fixture.teardown();
		}
	});

	test('two members marking the same settlement paid records exactly one payment', async ({
		request
	}) => {
		// Idempotent via a token derived from the ledger state. If both presses
		// created a payment the debt would invert and the app would start
		// suggesting paying the money back, so the settlement count is asserted
		// directly rather than trusting the balances alone.
		const fixture = await createApiFixture(request);
		const bob = await addRealMember(request, fixture, 'Bob');
		try {
			await addExpense(request, fixture, fixture.tripId, {
				description: 'Shared cab',
				amount: 40,
				payerId: fixture.userId,
				participantIds: [fixture.userId, bob.userId]
			});
			const before = await expensesData(request, fixture);
			const suggestion = before.settlement[0];
			expect(suggestion).toBeTruthy();

			const settle = (client: { sessionCookie: string }) =>
				apiSend(request, client, 'POST', `/trips/${fixture.tripId}/expenses/settle`, {
					fromId: suggestion.fromId,
					toId: suggestion.toId,
					amountCents: suggestion.amountCents,
					token: suggestion.token
				});
			const [first, second] = await Promise.all([settle(fixture), settle(bob)]);

			// One request created the payment (201), the other saw the same token
			// already spent and answered the existing payment (200, duplicate).
			expect([first.status(), second.status()].sort()).toEqual([200, 201]);

			const after = await expensesData(request, fixture);
			const payments = after.expenses.filter((e) => e.settlement === 1);
			expect(payments).toHaveLength(1);
			expect(netsToZero(after.balances)).toBe(0);
		} finally {
			await bob.teardown();
			await fixture.teardown();
		}
	});

	test('two members ticking the same task box leave it done once, not toggled twice', async ({
		request
	}) => {
		const fixture = await createApiFixture(request);
		const bob = await addRealMember(request, fixture, 'Bob');
		try {
			const taskId = await addTask(request, fixture, { label: 'Book the cab' });

			const [first, second] = await Promise.all([
				apiSend(
					request,
					fixture,
					'POST',
					`/trips/${fixture.tripId}/pretrip/tasks/${taskId}/toggle`,
					{
						done: true
					}
				),
				apiSend(request, bob, 'POST', `/trips/${fixture.tripId}/pretrip/tasks/${taskId}/toggle`, {
					done: true
				})
			]);
			expect(first.status()).toBe(200);
			expect(second.status()).toBe(200);

			// Both aimed at done, so the second is a no-op rather than a second flip:
			// the box is done, not ticked back off.
			const res = await apiSend(request, fixture, 'GET', `/trips/${fixture.tripId}/pretrip`);
			const task = (await res.json()).tasks.find(
				(t: { id: string; done: boolean }) => t.id === taskId
			);
			expect(task.done).toBe(true);
		} finally {
			await bob.teardown();
			await fixture.teardown();
		}
	});

	test('removing a member mid-edit refuses their next write and shows them no half-applied state', async ({
		browser,
		request
	}) => {
		// Membership is what authorizes the trip routes, so once Bob is removed his
		// next write is unreadable to him (404, the "not yours" answer) and his open
		// page must resolve to trip-not-found, not a stale half-alive screen.
		const fixture = await createApiFixture(request);
		const bob = await addRealMember(request, fixture, 'Bob');
		let context: BrowserContext | null = null;
		try {
			const view = await signedInContext(browser, bob.sessionCookie);
			context = view.context;
			await signIn(view.page, bob.sessionCookie);
			await view.page.goto(`/trips/${fixture.tripId}/expenses`);
			await expect(
				view.page.getByRole('button', { name: ce.addExpense, exact: true })
			).toBeVisible();

			const removed = await apiSend(
				request,
				fixture,
				'DELETE',
				`/trips/${fixture.tripId}/people/${bob.userId}`
			);
			expect(removed.status()).toBe(200);

			// Bob's next write, against a trip he is no longer in, is refused.
			const write = await apiSend(request, bob, 'POST', `/trips/${fixture.tripId}/expenses`, {
				description: 'Too late',
				amount: 10,
				payerId: bob.userId,
				participantIds: [bob.userId]
			});
			expect(write.status()).toBe(404);

			// Nothing of Bob's landed, and his reloaded page shows trip-not-found.
			const data = await expensesData(request, fixture);
			expect(data.expenses).toHaveLength(0);
			await view.page.reload();
			await expect(view.page.getByText(copy.tripShell.notFound)).toBeVisible();
		} finally {
			if (context) await context.close();
			await bob.teardown();
			await fixture.teardown();
		}
	});

	test('deleting an expense while another member has it open makes their save fail cleanly', async ({
		browser,
		request
	}) => {
		const fixture = await createApiFixture(request);
		const bob = await addRealMember(request, fixture, 'Bob');
		let context: BrowserContext | null = null;
		try {
			const both = [fixture.userId, bob.userId];
			const id = await addExpense(request, fixture, fixture.tripId, {
				description: 'Doomed expense',
				amount: 40,
				payerId: fixture.userId,
				participantIds: both
			});

			// Bob opens the edit dialog. While it is open his page defers refetches,
			// so the delete does not yank the dialog out from under him.
			const view = await signedInContext(browser, bob.sessionCookie);
			context = view.context;
			await signIn(view.page, bob.sessionCookie);
			await view.page.goto(`/trips/${fixture.tripId}/expenses`);
			await view.page
				.getByRole('button', { name: copy.common.editLabel('Doomed expense') })
				.click();
			const dialog = view.page.getByRole('dialog');
			await dialog.getByLabel(ce.addDialog.descriptionLabel).fill('Bob edit');

			// Alice deletes it out from under Bob.
			const del = await apiSend(
				request,
				fixture,
				'DELETE',
				`/trips/${fixture.tripId}/expenses/${id}`
			);
			expect(del.status()).toBe(200);

			// Bob saves onto a row that no longer exists: a clean error, no orphan.
			await dialog.getByRole('button', { name: copy.common.save, exact: true }).click();
			// The reason is a corner toast now. The matching node inside the dialog
			// is the announcement for a screen reader, which an open modal makes
			// inert and therefore unreachable from the corner, so both are checked:
			// the visible one and the one that is only spoken.
			await expect(view.page.locator('.toast.bad')).toBeVisible();
			await expect(dialog.getByRole('alert')).toHaveCount(1);

			const data = await expensesData(request, fixture);
			expect(data.expenses).toHaveLength(0);
		} finally {
			if (context) await context.close();
			await bob.teardown();
			await fixture.teardown();
		}
	});

	test('two members voting the same lodging option both count and neither vote is lost', async ({
		request
	}) => {
		const fixture = await createApiFixture(request);
		const bob = await addRealMember(request, fixture, 'Bob');
		try {
			const cityId = await addCity(request, fixture, LISBON);
			const stayId = await addStay(request, fixture, {
				cityId,
				name: 'Hotel Sol',
				priceCents: 10000,
				currency: 'USD'
			});

			const [first, second] = await Promise.all([
				apiSend(request, fixture, 'POST', `/trips/${fixture.tripId}/discover/stays/${stayId}/vote`),
				apiSend(request, bob, 'POST', `/trips/${fixture.tripId}/discover/stays/${stayId}/vote`)
			]);
			expect(first.status()).toBe(200);
			expect(second.status()).toBe(200);

			// Two distinct members, one vote each on the same option: the tally is
			// two, not one overwriting the other.
			const stays = await discoverStays(request, fixture, fixture.tripId);
			const option = stays[cityId].find((o) => o.id === stayId)!;
			expect(option.votes).toBe(2);
		} finally {
			await bob.teardown();
			await fixture.teardown();
		}
	});

	test('changing the home currency mid-expense leaves a coherent ledger that still nets to zero', async ({
		request
	}) => {
		// An expense locks its FX rate at write time and records which currency that
		// rate targets (`fx_home`). When the organizer later changes the trip's home
		// currency, that stored rate no longer targets the home currency, so the
		// reader falls back to a live conversion. Either way the row's home figure
		// must equal the sum of its own shares and the ledger must net to zero.
		const fixture = await createApiFixture(request);
		const bob = await addRealMember(request, fixture, 'Bob');
		try {
			const both = [fixture.userId, bob.userId];
			await addExpense(request, fixture, fixture.tripId, {
				description: 'London taxi',
				amount: 50,
				currency: 'GBP',
				payerId: fixture.userId,
				participantIds: both
			});

			const before = await expensesData(request, fixture);
			const shareSumOf = (e: { shares: Record<string, number> }) =>
				Object.values(e.shares).reduce((sum, n) => sum + n, 0);
			// While home is USD the locked GBP rate targets home, so the row's home
			// figure is the sum of its shares.
			expect(before.expenses[0].home_cents).toBe(shareSumOf(before.expenses[0]));
			expect(netsToZero(before.balances)).toBe(0);

			const patch = await apiSend(request, fixture, 'PATCH', `/trips/${fixture.tripId}`, {
				name: fixture.tripBody.name,
				startDate: fixture.tripBody.startDate,
				endDate: fixture.tripBody.endDate,
				currency: 'EUR'
			});
			expect(patch.status()).toBe(200);

			// Now home is EUR, the stored fx_home (USD) no longer matches, and the
			// reader live-converts GBP to EUR. The invariant holds regardless: the
			// home figure still equals the sum of the shares, and the ledger balances.
			const after = await expensesData(request, fixture);
			expect(after.currency).toBe('EUR');
			expect(after.expenses[0].home_cents).toBe(shareSumOf(after.expenses[0]));
			expect(after.expenses[0].home_cents).toBeGreaterThan(0);
			expect(netsToZero(after.balances)).toBe(0);
		} finally {
			await bob.teardown();
			await fixture.teardown();
		}
	});
});

test.describe('concurrency: product gaps with no protection today', () => {
	// Documented, not passed off. `pois`, `lodging_options` and `cost_items` carry
	// no version column, so their PATCH routes are last-write-wins: a concurrent
	// edit is not refused, it silently overwrites. This test records that current
	// behaviour accurately rather than pretending a 409 exists where it does not.
	// The gap is called out in the report; the fix is a product change, not a test
	// change, so no version column is added here to make it "pass".

	test('two edits to the same place both succeed with no conflict, so the last write silently wins', async ({
		request
	}) => {
		const fixture = await createApiFixture(request);
		try {
			const cityId = await addCity(request, fixture, LISBON);
			const poiId = await addPlace(request, fixture, { cityId, name: 'Belem Tower' });

			const rename = (name: string) =>
				apiSend(request, fixture, 'PATCH', `/trips/${fixture.tripId}/discover/pois/${poiId}`, {
					name
				});
			const [first, second] = await Promise.all([rename('Rename A'), rename('Rename B')]);

			// Neither is refused: there is no optimistic-concurrency check on pois,
			// so both writes are accepted. This is the gap.
			expect(first.status()).toBe(200);
			expect(second.status()).toBe(200);

			// One of the two names is left; whichever executed last won, with no
			// signal to the other writer that it clobbered anything. The same gap
			// applies to lodging_options and cost_items, which share this shape.
			const res = await apiSend(request, fixture, 'GET', `/trips/${fixture.tripId}/discover`);
			const cities = (await res.json()).cities as {
				pois: { id: string; name: string }[];
			}[];
			const poi = cities.flatMap((c) => c.pois).find((p) => p.id === poiId)!;
			expect(['Rename A', 'Rename B']).toContain(poi.name);
		} finally {
			await fixture.teardown();
		}
	});
});
