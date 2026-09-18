import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { apiURL, type ApiFixture } from './api';

/**
 * API seeding helpers.
 *
 * Seeding trip state through the API and then asserting on the UI is far faster
 * and less brittle than clicking every row into place, so the specs prefer it
 * everywhere except where the flow itself is the thing under test. Everything
 * here talks to the same throwaway database the fixture cleans up, so no helper
 * needs its own teardown.
 */

/** Anything carrying a session cookie: a fixture, or a bare registered user. */
export type Client = { sessionCookie: string };

async function send(
	request: APIRequestContext,
	client: Client,
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
	path: string,
	data?: unknown
) {
	return request.fetch(`${apiURL}${path}`, {
		method,
		headers: { cookie: client.sessionCookie },
		...(data === undefined ? {} : { data })
	});
}

/**
 * The raw authenticated request, returned without asserting its status.
 *
 * The concurrency spec needs to see the exact status of a write that is meant
 * to be refused (a 409 on a stale save, a 404 after a member is removed), so it
 * cannot go through the seeders that assert success. This is deliberately thin:
 * the spec reads `res.status()` itself.
 */
export async function apiSend(
	request: APIRequestContext,
	client: Client,
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
	path: string,
	data?: unknown
): Promise<APIResponse> {
	return send(request, client, method, path, data);
}

/** The lodging options of a trip, keyed by city id, each with its live vote count. */
export async function discoverStays(
	request: APIRequestContext,
	client: Client,
	tripId: string
): Promise<Record<string, { id: string; name: string; votes: number }[]>> {
	const res = await send(request, client, 'GET', `/trips/${tripId}/discover`);
	expect(res.status(), await res.text()).toBe(200);
	return (await res.json()).stays;
}

// --- Cities -----------------------------------------------------------------

export type CityInput = {
	name: string;
	country: string;
	region?: string | null;
	tz: string;
	lat?: number;
	lng?: number;
};

/** Adds a city and returns its id, resolved from the returned trip. */
export async function addCity(
	request: APIRequestContext,
	fixture: ApiFixture,
	city: CityInput
): Promise<string> {
	const res = await send(request, fixture, 'POST', `/trips/${fixture.tripId}/cities`, city);
	expect(res.status(), await res.text()).toBe(201);
	const { trip } = (await res.json()) as { trip: { cities: { id: string; name: string }[] } };
	const match = trip.cities.find((c) => c.name === city.name.trim());
	if (!match) throw new Error(`Seeded city not found after add: ${city.name}`);
	return match.id;
}

// --- Members ----------------------------------------------------------------

/**
 * Adds somebody to the trip. A registered address is added straight away; an
 * unregistered one becomes a placeholder member, which is a real row with an id
 * that can pay, owe, be assigned and be voted for, so it is all most specs need.
 */
export async function invite(
	request: APIRequestContext,
	fixture: ApiFixture,
	email: string,
	name?: string
): Promise<void> {
	const res = await send(request, fixture, 'POST', `/trips/${fixture.tripId}/people/invites`, {
		name: name ?? email.split('@')[0],
		email
	});
	expect(res.status(), await res.text()).toBe(200);
}

/**
 * Adds one placeholder member per name and returns a name -> id map that
 * includes the organizer.
 *
 * The invited address is `<name>@example.test` and the display name is the one
 * passed in, so the map is keyed by exactly the names the caller asked for.
 * Each fixture is its own trip, so the same friendly address never collides
 * across specs.
 */
export async function seedMembers(
	request: APIRequestContext,
	fixture: ApiFixture,
	names: string[]
): Promise<Record<string, string>> {
	for (const name of names) {
		await invite(request, fixture, `${name.toLowerCase()}@example.test`, name);
	}
	const data = await expensesData(request, fixture);
	const map: Record<string, string> = {};
	for (const m of data.members) map[m.name] = m.id;
	return map;
}

// --- Expenses ---------------------------------------------------------------

export type ExpenseBody = {
	description: string;
	amount: number;
	currency?: string;
	payerId: string;
	splitMode?: 'even' | 'shares' | 'exact';
	participantIds: string[];
	/** Share counts (shares) or major-unit amounts (exact), keyed by user id. */
	weights?: Record<string, number>;
	/** The day it happened, `YYYY-MM-DD`. Omitted means the server picks today. */
	spentOn?: string;
	version?: number;
};

export type ExpensesResponse = {
	currency: string;
	currencies: string[];
	members: { id: string; name: string }[];
	expenses: {
		id: string;
		description: string;
		amount_cents: number;
		home_cents: number;
		shares: Record<string, number>;
		settlement: number;
		spent_on: string;
		version: number;
	}[];
	balances: { id: string; name: string; netCents: number; former: boolean }[];
	settlement: { fromId: string; toId: string; amountCents: number; token: string }[];
	me: string;
};

export async function expensesData(
	request: APIRequestContext,
	client: Client & { tripId?: string },
	tripId?: string
): Promise<ExpensesResponse> {
	const id = tripId ?? (client as ApiFixture).tripId;
	const res = await send(request, client, 'GET', `/trips/${id}/expenses`);
	expect(res.status(), await res.text()).toBe(200);
	return res.json() as Promise<ExpensesResponse>;
}

export async function addExpense(
	request: APIRequestContext,
	client: Client,
	tripId: string,
	body: ExpenseBody
): Promise<string> {
	const res = await send(request, client, 'POST', `/trips/${tripId}/expenses`, body);
	expect(res.status(), await res.text()).toBe(201);
	return (await res.json()).id as string;
}

// --- Preparation ------------------------------------------------------------

export async function addTask(
	request: APIRequestContext,
	fixture: ApiFixture,
	body: { kind?: 'task' | 'packing'; label: string; assignees?: string[] }
): Promise<string> {
	const res = await send(request, fixture, 'POST', `/trips/${fixture.tripId}/pretrip/tasks`, {
		kind: body.kind ?? 'task',
		label: body.label,
		assignees: body.assignees ?? []
	});
	expect(res.status(), await res.text()).toBe(201);
	return (await res.json()).id as string;
}

/** Ticks or unticks a task, the way a collaborator's click does over the API. */
export async function toggleTask(
	request: APIRequestContext,
	client: Client,
	tripId: string,
	taskId: string,
	done: boolean
): Promise<void> {
	const res = await send(
		request,
		client,
		'POST',
		`/trips/${tripId}/pretrip/tasks/${taskId}/toggle`,
		{
			done
		}
	);
	expect(res.status(), await res.text()).toBe(200);
}

export async function addCost(
	request: APIRequestContext,
	fixture: ApiFixture,
	body: {
		label: string;
		amount: number;
		currency: string;
		category: string;
		assignees?: string[];
	}
): Promise<void> {
	const res = await send(request, fixture, 'POST', `/trips/${fixture.tripId}/pretrip/costs`, {
		...body,
		assignees: body.assignees ?? []
	});
	expect(res.status(), await res.text()).toBe(201);
}

// --- Discover ---------------------------------------------------------------

export async function addPlace(
	request: APIRequestContext,
	fixture: ApiFixture,
	body: {
		cityId: string;
		name: string;
		kind?: 'attraction' | 'food';
		notes?: string;
		url?: string;
		/** Somewhere real, for a spec about travel: journeys are planned from coordinates. */
		lat?: number;
		lng?: number;
	}
): Promise<string> {
	const res = await send(request, fixture, 'POST', `/trips/${fixture.tripId}/discover/pois`, {
		cityId: body.cityId,
		name: body.name,
		kind: body.kind ?? 'attraction',
		notes: body.notes ?? '',
		url: body.url ?? '',
		lat: body.lat,
		lng: body.lng
	});
	expect(res.status(), await res.text()).toBe(201);
	return (await res.json()).id as string;
}

export async function addStay(
	request: APIRequestContext,
	fixture: ApiFixture,
	body: {
		cityId: string;
		name: string;
		priceCents?: number;
		currency?: string;
		lat?: number;
		lng?: number;
	}
): Promise<string> {
	const res = await send(request, fixture, 'POST', `/trips/${fixture.tripId}/discover/stays`, {
		cityId: body.cityId,
		name: body.name,
		priceCents: body.priceCents,
		currency: body.currency,
		lat: body.lat,
		lng: body.lng
	});
	expect(res.status(), await res.text()).toBe(201);
	return (await res.json()).id as string;
}
