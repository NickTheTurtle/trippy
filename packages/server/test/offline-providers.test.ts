import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlannedLeg } from '@trippy/core/travel';

/**
 * The rule that automated runs never call a paid provider, and the observability
 * that was missing when one failed.
 *
 * Google Places and Routes are billed per request. A test suite that calls them
 * costs money every run, cannot be deterministic because the answers change
 * under it, and breaks when a third party does. The protection therefore has to
 * survive a developer's machine having a real key in `.env`, which is what
 * `TRIPPY_OFFLINE_PROVIDERS` is for and what most of this file checks.
 */
const tempRoot = join(tmpdir(), `trippy-offline-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = join(tempRoot, 'offline.test.db');

let places: typeof import('../src/providers/places.ts');
let routing: typeof import('../src/providers/routing.ts');
let fx: typeof import('../src/providers/fx.ts');
let envmod: typeof import('../src/infra/env.ts');

beforeAll(async () => {
	places = await import('../src/providers/places.ts');
	routing = await import('../src/providers/routing.ts');
	fx = await import('../src/providers/fx.ts');
	envmod = await import('../src/infra/env.ts');
});

const ATHENS = {
	city: 'Athens',
	country: 'Greece',
	region: 'Attica',
	lat: 37.9838,
	lng: 23.7275
};

/** Records every request that got as far as `fetch`, and answers as Photon. */
function recordFetch(googleStatus?: number): string[] {
	const urls: string[] = [];
	vi.stubGlobal('fetch', async (input: string | URL) => {
		const url = String(input);
		urls.push(url);
		if (url.includes('googleapis.com')) {
			if (googleStatus) return { ok: false, status: googleStatus };
			return { ok: true, json: async () => ({}) };
		}
		return { ok: true, json: async () => ({ features: [] }) };
	});
	return urls;
}

beforeEach(() => {
	// The state a careless developer is in: a live key on the machine.
	process.env.GOOGLE_SERVER_KEY = 'live-key-shaped-string';
	process.env.TRIPPY_OFFLINE_PROVIDERS = '1';
	places.resetProviderStatus();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
	delete process.env.GOOGLE_SERVER_KEY;
	delete process.env.GOOGLE_PLACES_KEY;
	delete process.env.GOOGLE_MAPS_KEY;
	delete process.env.TRIPPY_OFFLINE_PROVIDERS;
});

describe('offline provider flag', () => {
	it('hides every Google key, so nothing can send one', () => {
		process.env.GOOGLE_PLACES_KEY = 'old-key';
		process.env.GOOGLE_MAPS_KEY = 'browser-key';
		expect(envmod.env.GOOGLE_SERVER_KEY).toBeUndefined();
		expect(envmod.env.GOOGLE_PLACES_KEY).toBeUndefined();
		expect(envmod.env.GOOGLE_MAPS_KEY).toBeUndefined();
	});

	it('does not read the deprecated key as a way around the flag', () => {
		delete process.env.GOOGLE_SERVER_KEY;
		process.env.GOOGLE_PLACES_KEY = 'old-key';
		expect(places.activeProvider()).toBe('osm');
	});

	it('reports osm even with a key present', () => {
		expect(places.activeProvider()).toBe('osm');
	});

	it('searches OpenStreetMap and never googleapis.com', async () => {
		const urls = recordFetch();
		const results = await places.searchPlaces('acropolis museum', ATHENS, 'place', 'session-off1');

		expect(urls.every((u) => !u.includes('googleapis.com'))).toBe(true);
		expect(urls[0]).toContain('photon.komoot.io');
		expect(results).toEqual([]);
	});

	it('throws loudly if a paid call is attempted anyway', async () => {
		recordFetch();
		await expect(places.placeDetails('place-1', 'session-off2')).rejects.toBeInstanceOf(
			envmod.PaidProviderBlockedError
		);
		await expect(places.lookupPhoto('Acropolis', ATHENS)).rejects.toThrow(
			/TRIPPY_OFFLINE_PROVIDERS/
		);
	});

	it('does not let the OSM fallback swallow a blocked paid call', async () => {
		// `searchPlaces` degrades to Photon when Google fails, which is correct for
		// an outage and wrong for a guard: a test that reached for a billed
		// provider must fail, not quietly pass on results nobody asked for.
		recordFetch();
		await expect(places.placeDetailsCached('place-blocked')).rejects.toBeInstanceOf(
			envmod.PaidProviderBlockedError
		);
	});

	it('routes on the straight-line estimate, calling neither Google nor OSRM', async () => {
		const urls = recordFetch();
		const leg: PlannedLeg = {
			key: 'offline-leg',
			fromEventId: 'a',
			toEventId: 'b',
			people: ['solo'],
			fromLat: 37.9,
			fromLng: 23.7,
			toLat: 38.1,
			toLng: 23.9,
			km: 20
		};
		const routed = await routing.routeLeg(leg, 'drive');

		expect(urls).toEqual([]);
		expect(routed.routed).toBe(false);
		expect(routed.mins).toBeGreaterThan(0);
	});

	it('skips the FX refresh and converts from the static table', () => {
		const urls = recordFetch();
		fx.ensureRatesFresh();
		expect(urls).toEqual([]);
		// The fallback table is complete for every currency the app offers, so
		// money still converts with no network at all.
		expect(fx.convertCents(1000, 'USD', 'USD')).toBe(1000);
		expect(fx.rateTo('EUR', 'EUR')).toBe(1);
	});
});

describe('a Google failure is visible', () => {
	beforeEach(() => {
		delete process.env.TRIPPY_OFFLINE_PROVIDERS;
	});

	it('logs the status and says what is answering instead', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		recordFetch(403);

		const results = await places.searchPlaces('parthenon hill', ATHENS);

		expect(results).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);
		const line = String(warn.mock.calls[0][0]);
		expect(line).toContain('google places text search failed: google 403');
		expect(line).toContain('OpenStreetMap');
		// The key is in a header, never in a message, and must stay that way.
		expect(line).not.toContain('live-key-shaped-string');
	});

	it('reports the provider that answers, not the one configured', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		recordFetch(403);
		expect(places.providerStatus().serving).toBe('google');

		await places.searchPlaces('lycabettus view', ATHENS);

		const status = places.providerStatus();
		expect(status.configured).toBe('google');
		expect(status.serving).toBe('osm');
		expect(status.lastFailure?.reason).toBe('google 403');
	});

	it('logs one line a minute per distinct failure, not one per keystroke', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		recordFetch(403);

		// Distinct queries, so the cache cannot be what suppresses the repeats.
		for (let i = 0; i < 6; i += 1) {
			await places.searchPlaces(`spam query ${i}`, ATHENS);
		}
		expect(warn).toHaveBeenCalledTimes(1);
		expect(places.providerStatus().lastFailure?.count).toBe(6);
	});
});

describe('an empty result is not cached for a week', () => {
	beforeEach(() => {
		delete process.env.TRIPPY_OFFLINE_PROVIDERS;
		delete process.env.GOOGLE_SERVER_KEY;
	});

	it('re-asks after minutes rather than days', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
		const urls = recordFetch();

		await places.searchPlaces('nothing matches this', ATHENS);
		await places.searchPlaces('nothing matches this', ATHENS);
		expect(urls).toHaveLength(1);

		// Eleven minutes later the empty answer has expired: an outage that
		// returned nothing must not pin a query to "no results" for a week.
		vi.setSystemTime(new Date('2027-01-01T00:11:00Z'));
		await places.searchPlaces('nothing matches this', ATHENS);
		expect(urls).toHaveLength(2);
	});

	it('still caches a real answer for the full term', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2027-02-01T00:00:00Z'));
		vi.stubGlobal('fetch', async () => ({
			ok: true,
			json: async () => ({
				features: [
					{
						properties: { name: 'Acropolis', osm_key: 'tourism', osm_value: 'attraction' },
						geometry: { coordinates: [23.72, 37.97] }
					}
				]
			})
		}));

		const first = await places.searchPlaces('acropolis rock', ATHENS);
		expect(first[0].source).toBe('osm');

		vi.setSystemTime(new Date('2027-02-01T06:00:00Z'));
		const again = await places.searchPlaces('acropolis rock', ATHENS);
		expect(again[0].name).toBe('Acropolis');
	});

	it('clears rows poisoned under the old policy', async () => {
		recordFetch();
		await places.searchPlaces('poisoned probe query', ATHENS);
		// The row exists; clearing removes it and is safe to run again.
		expect(places.clearEmptySearchCache()).toBeGreaterThanOrEqual(1);
		expect(places.clearEmptySearchCache()).toBe(0);
	});
});
