import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';

export const apiURL = process.env.E2E_API_URL ?? 'http://localhost:5175/api';

export interface TripBody {
	name: string;
	dates: string;
	startDate: string;
	endDate: string;
	homeCurrency: string;
}

export interface ApiFixture {
	email: string;
	userId: string;
	tripId: string;
	tripBody: TripBody;
	sessionCookie: string;
	teardown: () => void;
}

export async function createApiFixture(request: APIRequestContext): Promise<ApiFixture> {
	const dbPath = requireThrowawayDbPath();
	const runId = randomUUID();
	const email = `e2e-${runId}@example.test`;
	const password = `password-${runId}`;

	const register = await request.post(`${apiURL}/auth/register`, {
		data: {
			email,
			name: 'E2E User',
			password
		}
	});
	expect(register.status()).toBe(201);
	const registered = (await register.json()) as { user: { id: string; email: string } };
	expect(registered.user.email).toBe(email);

	const sessionCookie = cookieHeader(register);
	expect(sessionCookie).toContain('session=');

	const tripBody: TripBody = {
		name: `E2E Trip ${runId}`,
		dates: '',
		startDate: '2027-02-10',
		endDate: '2027-02-12',
		homeCurrency: 'USD'
	};

	const created = await request.post(`${apiURL}/trips`, {
		headers: { cookie: sessionCookie },
		data: tripBody
	});
	expect(created.status()).toBe(201);
	const createdJson = (await created.json()) as { trip: { id: string; name: string } };
	expect(createdJson.trip.name).toBe(tripBody.name);

	return {
		email,
		userId: registered.user.id,
		tripId: createdJson.trip.id,
		tripBody,
		sessionCookie,
		teardown: () => removeUserRows(dbPath, registered.user.id)
	};
}

export async function readTrip(request: APIRequestContext, fixture: ApiFixture): Promise<APIResponse> {
	return request.get(`${apiURL}/trips/${fixture.tripId}`, {
		headers: { cookie: fixture.sessionCookie }
	});
}

export interface RegisteredUser {
	email: string;
	password: string;
	name: string;
	userId: string;
	sessionCookie: string;
	teardown: () => void;
}

/**
 * Registers a fresh account and hands back its cookie, without creating a trip.
 * Used where a spec needs a second real person (collaboration, invites that
 * auto-join), as opposed to the placeholder members `seedMembers` invites.
 */
export async function registerUser(
	request: APIRequestContext,
	overrides: { email?: string; name?: string; password?: string } = {}
): Promise<RegisteredUser> {
	const runId = randomUUID();
	const email = overrides.email ?? `e2e-${runId}@example.test`;
	const password = overrides.password ?? `password-${runId}`;
	const name = overrides.name ?? 'E2E User';

	const register = await request.post(`${apiURL}/auth/register`, {
		data: { email, name, password }
	});
	expect(register.status(), await register.text()).toBe(201);
	const registered = (await register.json()) as { user: { id: string } };

	const dbPath = requireThrowawayDbPath();
	return {
		email,
		password,
		name,
		userId: registered.user.id,
		sessionCookie: cookieHeader(register),
		teardown: () => removeUserRows(dbPath, registered.user.id)
	};
}

/** The bare `session` cookie value, for handing to `context.addCookies`. */
export function sessionValue(sessionCookie: string): string {
	return sessionCookie.split('session=')[1]?.split(';')[0] ?? '';
}

/**
 * Deletes a user (and, by foreign-key cascade, their trips and rows) from the
 * throwaway database. For a spec that registers through the UI and so never got
 * a `teardown` from a fixture, but still must not leave the account behind.
 */
export function deleteUser(userId: string): void {
	removeUserRows(requireThrowawayDbPath(), userId);
}

function cookieHeader(response: APIResponse): string {
	const setCookie = response.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
	return setCookie.map((h) => h.value.split(';', 1)[0]).join('; ');
}

function requireThrowawayDbPath(): string {
	const configured = process.env.E2E_TRIPPY_DB ?? process.env.TRIPPY_DB;
	if (!configured) {
		throw new Error(
			'Set E2E_TRIPPY_DB or TRIPPY_DB to the same throwaway SQLite database used by the API server.'
		);
	}

	const dbPath = resolve(configured);
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
	const forbidden = [
		resolve(repoRoot, 'data', 'app.db').toLowerCase(),
		resolve(repoRoot, 'packages', 'server', 'src', 'app.db').toLowerCase()
	];
	if (forbidden.includes(dbPath.toLowerCase())) {
		throw new Error('E2E teardown refuses to touch the product database. Use a throwaway TRIPPY_DB file.');
	}
	if (!existsSync(dbPath)) {
		throw new Error(`E2E teardown database does not exist: ${dbPath}`);
	}
	return dbPath;
}

function removeUserRows(dbPath: string, userId: string): void {
	const db = new DatabaseSync(dbPath);
	try {
		db.exec('PRAGMA foreign_keys = ON');
		db.prepare('DELETE FROM users WHERE id = ?').run(userId);
	} finally {
		db.close();
	}
}
