import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The rule that makes the provider quota safe to attach: a gate is charged only
 * when a call actually reaches a provider, never when the answer comes from the
 * cache. If a cached hit spent quota, ordinary repeat searching would burn the
 * allowance for answers already paid for, and a caller could be blocked from a
 * free result. These cases pin that the cache is consulted first.
 */

const tempRoot = join(tmpdir(), `trippy-provider-quota-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = join(tempRoot, 'provider-quota.test.db');
process.env.GOOGLE_SERVER_KEY = 'test-key';

let places: typeof import('../src/providers/places.ts');

beforeAll(async () => {
	places = await import('../src/providers/places.ts');
});

const ATHENS = { city: 'Athens', country: 'Greece', region: 'Attica', lat: 37.9838, lng: 23.7275 };

function stubProvider() {
	let calls = 0;
	vi.stubGlobal('fetch', async (input: string | URL) => {
		calls += 1;
		const url = String(input);
		if (url.includes(':searchText')) {
			return {
				ok: true,
				json: async () => ({
					places: [
						{
							id: 'p1',
							displayName: { text: 'Result' },
							formattedAddress: 'Somewhere',
							location: { latitude: 37.9, longitude: 23.7 },
							types: ['tourist_attraction']
						}
					]
				})
			};
		}
		return { ok: true, json: async () => ({}) };
	});
	return () => calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('the quota gate and the cache', () => {
	it('charges once on a miss and not at all on the cached repeat', async () => {
		stubProvider();
		let charges = 0;
		const gate = () => {
			charges += 1;
		};

		// A miss: the provider is reached and the gate is charged.
		await places.searchPlaces('novel query one', ATHENS, 'place', undefined, gate);
		expect(charges).toBe(1);

		// The identical query again is served from cache: the gate is never called,
		// so the repeat costs no quota.
		await places.searchPlaces('novel query one', ATHENS, 'place', undefined, gate);
		expect(charges).toBe(1);
	});

	it('does not cache a result the gate refused, and does not charge twice for it', async () => {
		const callCount = stubProvider();
		let attempts = 0;
		const throwingGate = () => {
			attempts += 1;
			throw new Error('over quota');
		};

		await expect(
			places.searchPlaces('novel query two', ATHENS, 'place', undefined, throwingGate)
		).rejects.toThrow('over quota');
		expect(attempts).toBe(1);
		// The provider was never reached, and nothing was cached: a later attempt
		// with an allowing gate still makes the real call.
		expect(callCount()).toBe(0);

		let allowed = 0;
		await places.searchPlaces('novel query two', ATHENS, 'place', undefined, () => {
			allowed += 1;
		});
		expect(allowed).toBe(1);
		expect(callCount()).toBeGreaterThan(0);
	});
});
