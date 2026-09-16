import { expect, test } from '@playwright/test';
import { apiURL } from './fixtures/api';

/**
 * The suite must never be able to spend money.
 *
 * Google Places and Routes are billed per request, so an e2e run that reaches
 * them costs real money every time, moves under its own feet as the provider's
 * answers change, and fails whenever a third party is down. The harness sets
 * `TRIPPY_OFFLINE_PROVIDERS` for the API server it starts (see
 * playwright.config.ts), which makes `env.ts` hide every Google key.
 *
 * This asserts the outcome rather than the setting, and it is deliberately
 * checked against the running server: a developer's machine has a live key in
 * `.env`, so "the key happened to be absent" is not the thing being relied on.
 * If this ever reports "google", the protection has been undone and the next
 * run is billable.
 */
test('the suite runs on the keyless provider, never on the paid one', async ({ request }) => {
	const health = await request.get(`${apiURL}/health`);
	expect(health.status()).toBe(200);
	await expect(health.json()).resolves.toEqual(
		expect.objectContaining({ ok: true, provider: 'osm' })
	);
});
