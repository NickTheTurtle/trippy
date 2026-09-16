import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlannedLeg } from '@trippy/core/travel';

/**
 * What `/api/health` is able to say, and for how long it remembers it.
 *
 * Two behaviours are pinned here. A routing failure must be visible at all:
 * `withTimeout` used to turn every throw into `null` and a non-ok response
 * returned `null`, so a board running entirely on straight-line estimates was
 * indistinguishable from a board with real routes. And a recorded failure must
 * outlive the process: the API runs under `tsx watch`, restarts on every file
 * save, and an in-memory-only record meant health went back to green after each
 * one while the key was still being rejected.
 *
 * Nothing here may reach a provider, so `fetch` is stubbed in every case.
 */
const tempRoot = join(tmpdir(), `trippy-provider-health-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = join(tempRoot, 'provider-health.test.db');

let health: typeof import('../src/providers/provider-health.ts');
let places: typeof import('../src/providers/places.ts');
let routing: typeof import('../src/providers/routing.ts');

beforeAll(async () => {
	[health, places, routing] = await Promise.all([
		import('../src/providers/provider-health.ts'),
		import('../src/providers/places.ts'),
		import('../src/providers/routing.ts')
	]);
});

beforeEach(() => {
	health.resetProviderHealth('all');
	process.env.GOOGLE_SERVER_KEY = 'live-key-shaped-string';
	delete process.env.TRIPPY_OFFLINE_PROVIDERS;
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
	delete process.env.GOOGLE_SERVER_KEY;
});

const GOOGLE = 'googleapis.com';

/** A leg with its own coordinates, so each case misses the route cache. */
let seq = 0;
function makeLeg(km = 40): PlannedLeg {
	seq += 1;
	const base = seq * 0.001;
	return {
		key: `health-${seq}`,
		fromEventId: `from-${seq}`,
		toEventId: `to-${seq}`,
		people: ['solo'],
		fromLat: 37.9 + base,
		fromLng: 23.7 + base,
		toLat: 38.0 + base,
		toLng: 23.8 + base,
		km,
		afterMin: 600,
		beforeMin: 720,
		openEnded: false
	};
}

describe('a routing failure is visible', () => {
	it('records a rejected key and still answers the leg', async () => {
		vi.stubGlobal('fetch', async (input: unknown) => {
			if (String(input).includes(GOOGLE)) return new Response('denied', { status: 403 });
			throw new Error('osrm unreachable');
		});

		const leg = await routing.routeLeg(makeLeg(), 'drive');
		// The board still gets a number: degrading is correct, hiding it is not.
		expect(leg.routed).toBe(false);
		expect(leg.mins).toBeGreaterThan(0);

		const status = routing.routingStatus();
		expect(status.configured).toBe('google');
		expect(status.serving).toBe('fallback');
		expect(status.degraded).toBe(true);
		expect(status.lastFailure?.op).toBe('google routes');
		expect(status.lastFailure?.reason).toBe('google 403');
		// The free provider's own trouble is reported beside the paid one's, not
		// on top of it: the thing to fix here is the key.
		expect(status.fallbackFailure?.op).toBe('osrm route');
	});

	it('tells a timeout apart from a refusal, because the fix differs', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', (input: unknown, init: { signal: AbortSignal }) => {
			if (String(input).includes(GOOGLE)) {
				return new Promise<Response>((_, reject) => {
					init.signal.addEventListener('abort', () => reject(new Error('aborted')));
				});
			}
			return Promise.resolve(new Response('no', { status: 500 }));
		});

		const pending = routing.routeLeg(makeLeg(), 'drive');
		await vi.advanceTimersByTimeAsync(3000);
		await pending;

		expect(routing.routingStatus().lastFailure?.reason).toMatch(/timeout after \d+ms/);
	});

	it('logs one line per distinct failure per minute, not one per leg', async () => {
		const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
		vi.stubGlobal('fetch', async () => new Response('denied', { status: 403 }));

		// A walk, so only Google is asked: OSRM answers about driving only, and
		// this case is about how often one failure is logged.
		for (let i = 0; i < 5; i += 1) await routing.routeLeg(makeLeg(0.5), 'walk');

		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain('[routing] google routes failed: google 403');
		expect(routing.routingStatus().lastFailure?.count).toBe(5);
	});

	it('clears once Google answers again, so a fixed key is reported fixed', async () => {
		vi.stubGlobal('fetch', async () => new Response('denied', { status: 403 }));
		await routing.routeLeg(makeLeg(), 'drive');
		expect(routing.routingStatus().degraded).toBe(true);

		vi.stubGlobal(
			'fetch',
			async () => new Response(JSON.stringify({ routes: [{ duration: '600s' }] }), { status: 200 })
		);
		const good = await routing.routeLeg(makeLeg(), 'drive');
		expect(good).toEqual({ mode: 'drive', mins: 10, routed: true });
		expect(routing.routingStatus()).toMatchObject({ degraded: false, serving: 'google' });
	});

	it('reports free routing as free rather than as degradation', async () => {
		delete process.env.GOOGLE_SERVER_KEY;
		vi.stubGlobal('fetch', async () => new Response('no', { status: 500 }));
		await routing.routeLeg(makeLeg(), 'drive');
		const status = routing.routingStatus();
		// OSRM failed, which is worth seeing, but nothing paid for was refused.
		expect(status.configured).toBe('none');
		expect(status.degraded).toBe(false);
		expect(status.fallbackFailure?.op).toBe('osrm route');
	});
});

describe('degraded survives a restart', () => {
	/** What `tsx watch` does on a file save: memory gone, database kept. */
	const restart = () => health.resetProviderHealth('memory');

	it('still reports routing degraded in a fresh process', async () => {
		vi.stubGlobal('fetch', async () => new Response('denied', { status: 403 }));
		await routing.routeLeg(makeLeg(), 'drive');

		restart();

		const status = routing.routingStatus();
		expect(status.degraded).toBe(true);
		expect(status.lastFailure?.reason).toBe('google 403');
	});

	it('still reports places degraded in a fresh process', async () => {
		vi.stubGlobal('fetch', async (input: unknown) => {
			if (String(input).includes(GOOGLE)) return { ok: false, status: 403 };
			return { ok: true, json: async () => ({ features: [] }) };
		});
		await places.searchPlaces('a query nobody has asked before', {
			city: 'Athens',
			country: 'Greece',
			region: 'Attica'
		});
		expect(places.providerStatus().serving).toBe('osm');

		restart();

		const status = places.providerStatus();
		expect(status.configured).toBe('google');
		expect(status.serving).toBe('osm');
		expect(status.lastFailure?.reason).toBe('google 403');
	});

	it('does not resurrect a failure that a later success cleared', async () => {
		vi.stubGlobal('fetch', async () => new Response('denied', { status: 403 }));
		await routing.routeLeg(makeLeg(), 'drive');
		vi.stubGlobal(
			'fetch',
			async () => new Response(JSON.stringify({ routes: [{ duration: '600s' }] }), { status: 200 })
		);
		await routing.routeLeg(makeLeg(), 'drive');

		restart();

		expect(routing.routingStatus().degraded).toBe(false);
	});

	it('starts clean when the record is cleared outright', async () => {
		vi.stubGlobal('fetch', async () => new Response('denied', { status: 403 }));
		await routing.routeLeg(makeLeg(), 'drive');

		health.resetProviderHealth('all');

		expect(routing.routingStatus().degraded).toBe(false);
		expect(routing.routingStatus().lastFailure).toBeNull();
	});

	it('keeps the key out of what it stores', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new Error('connect failed for ?key=live-key-shaped-string&x=1');
		});
		await routing.routeLeg(makeLeg(), 'drive');
		restart();
		const reason = routing.routingStatus().lastFailure?.reason ?? '';
		expect(reason).not.toContain('live-key-shaped-string');
		expect(reason).toContain('[redacted]');
	});
});

describe('the record is written on state changes, not on every call', () => {
	it('writes once for a storm of identical failures', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2027-03-01T00:00:00Z'));
		vi.stubGlobal('fetch', async () => new Response('denied', { status: 403 }));

		for (let i = 0; i < 4; i += 1) await routing.routeLeg(makeLeg(), 'drive');
		const first = routing.routingStatus().lastFailure?.at;

		// The stored row is the first failure's, not the fourth's: repeats inside
		// the window move memory only, so an outage is not also a write storm.
		health.resetProviderHealth('memory');
		expect(routing.routingStatus().lastFailure?.at).toBe(first);
	});
});
