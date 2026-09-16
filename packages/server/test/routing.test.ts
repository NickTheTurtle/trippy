import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlannedLeg } from '@trippy/core/travel';
import { guessLeg, minsByMode } from '@trippy/core/travel';

/**
 * How a journey's duration is resolved, and what happens when the paid provider
 * cannot answer.
 *
 * `routeLegs` runs on every schedule board load and bills Google Routes, so the
 * thing that matters most here is the fallback chain: Google, then OSRM (driving
 * only), then the straight-line estimate that never fails. None of it may reach
 * a real provider, so `fetch` is stubbed for every case and the stub's call
 * count is asserted, which is the only way to prove the cache actually saves a
 * billed request rather than merely returning the same number.
 */

const tempRoot = join(tmpdir(), `trippy-routing-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = join(tempRoot, 'routing.test.db');

let routing: typeof import('../src/providers/routing.ts');

beforeEach(async () => {
	routing = await import('../src/providers/routing.ts');
	process.env.GOOGLE_SERVER_KEY = 'test-key';
	delete process.env.GOOGLE_MAPS_KEY;
	delete process.env.GOOGLE_PLACES_KEY;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	delete process.env.GOOGLE_SERVER_KEY;
	delete process.env.GOOGLE_MAPS_KEY;
	delete process.env.GOOGLE_PLACES_KEY;
});

/**
 * A leg with distinct coordinates per call, so each test lands on its own cache
 * key and cannot be answered by an earlier test's cached result. `km` drives the
 * estimate and the mode guess; the coordinates only shape the cache key and the
 * request bodies, so they are free to vary.
 */
let seq = 0;
function makeLeg(km: number, over: Partial<PlannedLeg> = {}): PlannedLeg {
	seq += 1;
	const base = seq * 0.001;
	return {
		key: `from-${seq}>to-${seq}>solo`,
		fromEventId: `from-${seq}`,
		toEventId: `to-${seq}`,
		people: ['solo'],
		fromLat: 37.97 + base,
		fromLng: 23.72 + base,
		toLat: 37.98 + base,
		toLng: 23.73 + base,
		km,
		afterMin: 600,
		beforeMin: 720,
		openEnded: false,
		...over
	};
}

const GOOGLE = 'googleapis.com';
const OSRM = 'project-osrm.org';

/** How many stubbed requests went to each provider. */
function callCounts(stub: ReturnType<typeof vi.fn>) {
	const urls = stub.mock.calls.map((c) => String(c[0]));
	return {
		google: urls.filter((u) => u.includes(GOOGLE)).length,
		osrm: urls.filter((u) => u.includes(OSRM)).length
	};
}

/** Google answers `600s` (ten minutes); OSRM answers 720s (twelve). */
function googleOk(): Response {
	return new Response(JSON.stringify({ routes: [{ duration: '600s' }] }), { status: 200 });
}
function osrmOk(): Response {
	return new Response(JSON.stringify({ routes: [{ duration: 720 }] }), { status: 200 });
}

describe('guessMode thresholds', () => {
	it('picks the mode a distance of that length is usually made in', () => {
		expect(routing.guessMode(0.5)).toBe('walk');
		expect(routing.guessMode(3)).toBe('transit');
		expect(routing.guessMode(100)).toBe('drive');
		expect(routing.guessMode(1000)).toBe('flight');
	});

	it('puts a distance sitting exactly on a cut into the upper band', () => {
		// The cut is `dist < threshold` on the padded distance (km * 1.3), so a
		// value landing exactly on 1.1, 8 or 500 belongs to the slower mode.
		expect(routing.guessMode(1.1 / 1.3)).toBe('transit');
		expect(routing.guessMode(8 / 1.3)).toBe('drive');
		expect(routing.guessMode(500 / 1.3)).toBe('flight');
	});
});

describe('the fallback chain', () => {
	it('uses Google when it answers, and never asks OSRM', async () => {
		const stub = vi.fn(async () => googleOk());
		vi.stubGlobal('fetch', stub);

		const res = await routing.routeLeg(makeLeg(100), 'drive');
		expect(res).toEqual({ mode: 'drive', mins: 10, routed: true });
		expect(callCounts(stub)).toEqual({ google: 1, osrm: 0 });
	});

	it('falls through to OSRM when Google throws', async () => {
		const stub = vi.fn(async (input: unknown) => {
			if (String(input).includes(GOOGLE)) throw new Error('google down');
			return osrmOk();
		});
		vi.stubGlobal('fetch', stub);

		const res = await routing.routeLeg(makeLeg(100), 'drive');
		expect(res).toEqual({ mode: 'drive', mins: 12, routed: true });
		expect(callCounts(stub)).toEqual({ google: 1, osrm: 1 });
	});

	it('falls through to OSRM when Google answers non-ok', async () => {
		const stub = vi.fn(async (input: unknown) => {
			if (String(input).includes(GOOGLE)) return new Response('nope', { status: 500 });
			return osrmOk();
		});
		vi.stubGlobal('fetch', stub);

		const res = await routing.routeLeg(makeLeg(100), 'drive');
		expect(res.routed).toBe(true);
		expect(res.mins).toBe(12);
		expect(callCounts(stub)).toEqual({ google: 1, osrm: 1 });
	});

	it('falls through to OSRM when Google times out', async () => {
		vi.useFakeTimers();
		const stub = vi.fn((input: unknown, init: { signal: AbortSignal }) => {
			if (String(input).includes(GOOGLE)) {
				// Never resolves on its own: only the 3s abort ends it.
				return new Promise<Response>((_, reject) => {
					init.signal.addEventListener('abort', () => reject(new Error('aborted')));
				});
			}
			return Promise.resolve(osrmOk());
		});
		vi.stubGlobal('fetch', stub);

		const pending = routing.routeLeg(makeLeg(100), 'drive');
		await vi.advanceTimersByTimeAsync(3000);
		const res = await pending;
		expect(res.routed).toBe(true);
		expect(res.mins).toBe(12);
		expect(callCounts(stub)).toEqual({ google: 1, osrm: 1 });
	});

	it('skips Google entirely when no key is configured', async () => {
		delete process.env.GOOGLE_SERVER_KEY;
		const stub = vi.fn(async (input: unknown) => {
			if (String(input).includes(GOOGLE)) throw new Error('should not be called');
			return osrmOk();
		});
		vi.stubGlobal('fetch', stub);

		const res = await routing.routeLeg(makeLeg(100), 'drive');
		expect(res.mins).toBe(12);
		expect(callCounts(stub)).toEqual({ google: 0, osrm: 1 });
	});

	it('uses the deprecated Places key as a rollout fallback', async () => {
		delete process.env.GOOGLE_SERVER_KEY;
		process.env.GOOGLE_PLACES_KEY = 'old-server-key';
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const stub = vi.fn(async () => googleOk());
		vi.stubGlobal('fetch', stub);

		const res = await routing.routeLeg(makeLeg(100), 'drive');
		expect(res).toEqual({ mode: 'drive', mins: 10, routed: true });
		expect(callCounts(stub)).toEqual({ google: 1, osrm: 0 });
		expect(warn).toHaveBeenCalledWith(
			'GOOGLE_PLACES_KEY is deprecated. Set GOOGLE_SERVER_KEY for server-side Google Places and Routes calls.'
		);
	});

	it('does not use the browser Maps key for server-side routing', async () => {
		delete process.env.GOOGLE_SERVER_KEY;
		delete process.env.GOOGLE_PLACES_KEY;
		process.env.GOOGLE_MAPS_KEY = 'browser-key';
		const stub = vi.fn(async (input: unknown) => {
			if (String(input).includes(GOOGLE)) throw new Error('browser key must not be used');
			return osrmOk();
		});
		vi.stubGlobal('fetch', stub);

		const res = await routing.routeLeg(makeLeg(100), 'drive');
		expect(res).toEqual({ mode: 'drive', mins: 12, routed: true });
		expect(callCounts(stub)).toEqual({ google: 0, osrm: 1 });
	});

	it('does not ask OSRM about a walk, so a stroll never gets a driving time', async () => {
		const stub = vi.fn(async (input: unknown) => {
			if (String(input).includes(GOOGLE)) throw new Error('google down');
			return osrmOk();
		});
		vi.stubGlobal('fetch', stub);

		const res = await routing.routeLeg(makeLeg(0.6), 'walk');
		// OSRM knows only driving, so a walk that Google could not answer falls
		// straight to the straight-line estimate rather than a car's time.
		expect(res.mode).toBe('walk');
		expect(res.routed).toBe(false);
		expect(callCounts(stub)).toEqual({ google: 1, osrm: 0 });
	});

	it('asks no provider at all about a ferry, and honours the mode', async () => {
		const stub = vi.fn(async () => googleOk());
		vi.stubGlobal('fetch', stub);

		const res = await routing.routeLeg(makeLeg(30), 'ferry');
		// Ferry has no Google equivalent and is not a mode OSRM answers, so the
		// estimate stands, wearing the label the traveller chose.
		expect(res.mode).toBe('ferry');
		expect(res.routed).toBe(false);
		expect(res.mins).toBeGreaterThan(0);
		expect(callCounts(stub)).toEqual({ google: 0, osrm: 0 });
	});

	it('estimates when both providers fail, so the day still plans', async () => {
		const stub = vi.fn(async () => {
			throw new Error('both down');
		});
		vi.stubGlobal('fetch', stub);

		const res = await routing.routeLeg(makeLeg(100), 'drive');
		expect(res.mode).toBe('drive');
		expect(res.routed).toBe(false);
		expect(res.mins).toBeGreaterThan(0);
		expect(callCounts(stub)).toEqual({ google: 1, osrm: 1 });
	});

	it('guesses the mode from the distance when none is given', async () => {
		const stub = vi.fn(async () => {
			throw new Error('offline');
		});
		vi.stubGlobal('fetch', stub);

		// A short hop with no mode is a walk; the estimate keeps that label.
		const res = await routing.routeLeg(makeLeg(0.5));
		expect(res.mode).toBe('walk');
		expect(res.routed).toBe(false);
	});
});

describe('the estimate and its label come from one estimator', () => {
	/** Nothing may reach a provider here: the estimate is what is under test. */
	function offline() {
		const stub = vi.fn(async () => {
			throw new Error('offline');
		});
		vi.stubGlobal('fetch', stub);
		return stub;
	}

	it('gives a long unlabelled leg a flight time, not 43 hours of driving', async () => {
		offline();
		const res = await routing.routeLeg(makeLeg(1000));
		// The old code took the label from `guessMode` and the number from a
		// mode-blind estimate, which paired "flight" with 2605 minutes.
		expect(res.mode).toBe('flight');
		expect(res.mins).toBe(minsByMode(1000, 'flight'));
		expect(res.mins).toBeLessThan(6 * 60);
	});

	it('agrees with core for any unlabelled leg, mode and minutes alike', async () => {
		offline();
		for (const km of [0.4, 3, 40, 1000]) {
			const res = await routing.routeLeg(makeLeg(km));
			expect({ mode: res.mode, mins: res.mins }).toEqual(guessLeg(km));
		}
	});

	it('prices a chosen mode as that mode, not as a drive wearing its label', async () => {
		offline();
		const ferry = await routing.routeLeg(makeLeg(30), 'ferry');
		expect(ferry.mins).toBe(minsByMode(30, 'ferry'));
		const walk = await routing.routeLeg(makeLeg(2), 'walk');
		expect(walk.mins).toBe(minsByMode(2, 'walk'));
		// A ferry across 30km is not the drive around the bay, and a 2km walk is
		// not a bus ride; the old estimate gave both the same number.
		expect(ferry.mins).not.toBe(minsByMode(30, 'drive'));
		expect(walk.mins).not.toBe(minsByMode(2, 'transit'));
	});
});

describe('the cache', () => {
	it('answers a repeated leg from memory rather than buying it twice', async () => {
		const stub = vi.fn(async () => googleOk());
		vi.stubGlobal('fetch', stub);

		const leg = makeLeg(100);
		const first = await routing.routeLeg(leg, 'drive');
		const second = await routing.routeLeg(leg, 'drive');
		expect(second).toEqual(first);
		// The whole point of the cache: the second board load is free.
		expect(callCounts(stub)).toEqual({ google: 1, osrm: 0 });
	});

	it('keys on the mode, so the same pair in two modes is two lookups', async () => {
		const stub = vi.fn(async () => googleOk());
		vi.stubGlobal('fetch', stub);

		const leg = makeLeg(100);
		await routing.routeLeg(leg, 'drive');
		await routing.routeLeg(leg, 'transit');
		expect(callCounts(stub).google).toBe(2);
	});
});

describe('routeLegs', () => {
	it('resolves a batch and falls back per leg, never as a whole', async () => {
		const legA = makeLeg(100, { key: 'a>b>solo' });
		const legB = makeLeg(100, { key: 'c>d>solo' });
		const stub = vi.fn(async (input: unknown, init?: { body?: string }) => {
			if (String(input).includes(GOOGLE)) {
				// Fail Google only for legB, by matching its origin coordinate.
				const body = init?.body ?? '';
				if (body.includes(String(legB.fromLat))) throw new Error('google down for B');
				return googleOk();
			}
			return osrmOk();
		});
		vi.stubGlobal('fetch', stub);

		const out = await routing.routeLegs([legA, legB], () => 'drive');
		expect(out.get('a>b>solo')).toEqual({ mode: 'drive', mins: 10, routed: true });
		// legB's Google failed, so it fell to OSRM on its own, not as a batch.
		expect(out.get('c>d>solo')).toEqual({ mode: 'drive', mins: 12, routed: true });
	});
});
