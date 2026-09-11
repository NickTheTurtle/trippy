import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempRoot = join(tmpdir(), `trippy-cache-tests-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = join(tempRoot, 'cache.test.db');

let cache: typeof import('../src/infra/cache.ts');
let photos: typeof import('../src/providers/photo-cache.ts');
let db: Awaited<typeof import('../src/db.ts')>['db'];

beforeAll(async () => {
	let mod: Awaited<typeof import('../src/db.ts')>;
	[cache, photos, mod] = await Promise.all([
		import('../src/infra/cache.ts'),
		import('../src/providers/photo-cache.ts'),
		import('../src/db.ts')
	]);
	db = mod.db;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('provider cache', () => {
	it('does not buy the same answer twice after a restart', async () => {
		let calls = 0;
		const load = async () => {
			calls++;
			return ['acropolis'];
		};

		const before = cache.createPersistentCache<string[]>('search', 60_000, 10);
		expect(await before.take('athens', load)).toEqual(['acropolis']);
		expect(await before.take('athens', load)).toEqual(['acropolis']);
		expect(calls).toBe(1);

		// A second instance is what a restarted process has: no memory of the
		// first, only the table. This is the whole point of persisting.
		const after = cache.createPersistentCache<string[]>('search', 60_000, 10);
		expect(await after.take('athens', load)).toEqual(['acropolis']);
		expect(calls).toBe(1);
	});

	it('keeps namespaces apart, so a search and a details row cannot collide', async () => {
		const search = cache.createPersistentCache<string>('search', 60_000, 10);
		const details = cache.createPersistentCache<string>('details', 60_000, 10);
		expect(await search.take('x', async () => 'from search')).toBe('from search');
		expect(await details.take('x', async () => 'from details')).toBe('from details');
	});

	it('buys again once the entry has expired', async () => {
		let calls = 0;
		const load = async () => {
			calls++;
			return calls;
		};
		const expired = cache.createPersistentCache<number>('ttl', -1, 10);
		await expired.take('k', load);
		// A fresh instance, so the memory layer cannot answer and the stored row
		// is already past its expiry.
		await cache.createPersistentCache<number>('ttl', -1, 10).take('k', load);
		expect(calls).toBe(2);
	});
});

describe('photo cache', () => {
	it('round-trips bytes and keeps widths apart', () => {
		const name = 'places/abc/photos/def';
		const bytes = new Uint8Array([1, 2, 3, 4]);
		expect(photos.readPhoto(name, 640)).toBeNull();

		photos.writePhoto(name, 640, bytes, 'image/jpeg');
		const hit = photos.readPhoto(name, 640);
		expect(hit?.contentType).toBe('image/jpeg');
		expect(Array.from(hit!.bytes)).toEqual([1, 2, 3, 4]);

		// A different width is a different image, not a hit on this one.
		expect(photos.readPhoto(name, 320)).toBeNull();
	});

	it('replaces rather than duplicates when the same photo is written again', () => {
		const name = 'places/abc/photos/ghi';
		photos.writePhoto(name, 640, new Uint8Array([9]), 'image/jpeg');
		const size = photos.photoCacheSize();
		photos.writePhoto(name, 640, new Uint8Array([8]), 'image/webp');
		expect(photos.photoCacheSize()).toBe(size);
		expect(photos.readPhoto(name, 640)?.contentType).toBe('image/webp');
	});

	it('stops serving a photo once Google 30 day cap has passed', () => {
		const name = 'places/abc/photos/stale';
		photos.writePhoto(name, 640, new Uint8Array([1]), 'image/jpeg');
		expect(photos.readPhoto(name, 640)).not.toBeNull();

		// One day short of the cap it is still ours to serve; one day past it,
		// it is not, and the row has to stop answering rather than be refreshed.
		const written = Date.now();
		const day = 24 * 60 * 60 * 1000;
		vi.spyOn(Date, 'now').mockReturnValue(written + 29 * day);
		expect(photos.readPhoto(name, 640)).not.toBeNull();
		vi.spyOn(Date, 'now').mockReturnValue(written + 31 * day);
		expect(photos.readPhoto(name, 640)).toBeNull();
	});

	it('drops expired rows on the next write rather than keeping them forever', () => {
		const written = Date.now();
		photos.writePhoto('places/abc/photos/sweep', 640, new Uint8Array([1]), 'image/jpeg');
		const before = photos.photoCacheSize();

		vi.spyOn(Date, 'now').mockReturnValue(written + 31 * 24 * 60 * 60 * 1000);
		photos.writePhoto('places/abc/photos/fresh', 640, new Uint8Array([2]), 'image/jpeg');
		// Everything written before the jump expired, so only the new row is left.
		expect(photos.photoCacheSize()).toBe(1);
		expect(before).toBeGreaterThan(1);
	});

	it('keeps the newest 500 photos and no more', () => {
		// The cap is what stops a long run of unusual widths growing the
		// database without limit. Time is advanced between writes because the
		// eviction orders by expiry, which for a fixed TTL is write order.
		const base = Date.now();
		let clock = base;
		vi.spyOn(Date, 'now').mockImplementation(() => clock);
		// Start from an empty table: the prune on the first write clears
		// whatever the earlier cases left, since they are all in the past now.
		clock = base + 31 * 24 * 60 * 60 * 1000;

		for (let i = 0; i < 505; i++) {
			clock += 1000;
			photos.writePhoto(`places/cap/photos/p${i}`, 640, new Uint8Array([i % 256]), 'image/jpeg');
		}

		expect(photos.photoCacheSize()).toBe(500);
		// The first five written are the five that went.
		expect(photos.readPhoto('places/cap/photos/p0', 640)).toBeNull();
		expect(photos.readPhoto('places/cap/photos/p4', 640)).toBeNull();
		expect(photos.readPhoto('places/cap/photos/p5', 640)).not.toBeNull();
		expect(photos.readPhoto('places/cap/photos/p504', 640)).not.toBeNull();
	});
});

/**
 * The cost controls on the memory layer.
 *
 * Every miss here is a billed provider call, so what matters is not only that a
 * repeat question is free but that a burst of the same question is one call, a
 * failure is not remembered as an answer, and a stream of unique questions
 * cannot walk a long-running server into an OOM.
 */
describe('cache limits', () => {
	it('makes a burst of the same question cost one call', async () => {
		let calls = 0;
		let release: (v: string) => void = () => {};
		const load = () => {
			calls++;
			return new Promise<string>((resolve) => {
				release = resolve;
			});
		};

		const c = cache.createCache<string>(60_000, 10);
		// Three callers arrive before the first has returned. A value cache
		// would never see this; caching the promise is what collapses it.
		const all = Promise.all([c.take('k', load), c.take('k', load), c.take('k', load)]);
		release('answer');
		expect(await all).toEqual(['answer', 'answer', 'answer']);
		expect(calls).toBe(1);
	});

	it('does not remember a failure as though it were an answer', async () => {
		let calls = 0;
		const load = async () => {
			calls++;
			if (calls === 1) throw new Error('upstream down');
			return 'answer';
		};

		const c = cache.createCache<string>(60_000, 10);
		await expect(c.take('k', load)).rejects.toThrow('upstream down');
		// The next caller gets a real attempt, not the stored rejection.
		expect(await c.take('k', load)).toBe('answer');
		expect(calls).toBe(2);
		expect(await c.take('k', load)).toBe('answer');
		expect(calls).toBe(2);
	});

	it('does not let an older failure evict a newer answer for the same key', async () => {
		// The guard this covers only matters when a request outlives its own
		// TTL: a later caller finds the entry stale, starts a fresh load and
		// overwrites it, and only then does the first request fail. That
		// rejection must not delete the answer that replaced it.
		let clock = Date.now();
		vi.spyOn(Date, 'now').mockImplementation(() => clock);

		let fail: (e: Error) => void = () => {};
		const slow = new Promise<string>((_, reject) => {
			fail = reject;
		});

		const c = cache.createCache<string>(1000, 10);
		const first = c.take('k', () => slow);
		first.catch(() => {});

		clock += 2000;
		expect(await c.take('k', async () => 'answer')).toBe('answer');

		fail(new Error('too late'));
		await first.catch(() => {});

		let calls = 0;
		expect(
			await c.take('k', async () => {
				calls++;
				return 'refetched';
			})
		).toBe('answer');
		expect(calls).toBe(0);
	});

	it('stays bounded when every question is a new one', async () => {
		const c = cache.createCache<number>(60_000, 3);
		for (let i = 0; i < 50; i++) await c.take(`k${i}`, async () => i);
		expect(c.size).toBeLessThanOrEqual(3);

		// What is left is the newest, and the oldest is gone.
		let calls = 0;
		await c.take('k0', async () => {
			calls++;
			return 0;
		});
		expect(calls).toBe(1);
	});

	it('never keeps a stored answer longer than Google 30 day cap', async () => {
		const asked = 365 * 24 * 60 * 60 * 1000;
		const before = Date.now();
		const c = cache.createPersistentCache<string>('ttlcap', asked, 10);
		await c.take('k', async () => 'answer');

		const row = db
			.prepare(`SELECT expires_at FROM provider_cache WHERE key = ?`)
			.get('ttlcap|k') as { expires_at: number };
		expect(row.expires_at).toBeLessThanOrEqual(before + 30 * 24 * 60 * 60 * 1000 + 1000);
	});

	it('treats a stored row it cannot parse as a miss rather than a crash', async () => {
		// A row written by an older shape of the value is not an answer to
		// today's question, and must not take the request down either.
		db.prepare(
			`INSERT INTO provider_cache (key, value, expires_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
		).run('legacy|k', 'not json at all', Date.now() + 60_000);

		let calls = 0;
		const c = cache.createPersistentCache<string>('legacy', 60_000, 10);
		expect(
			await c.take('k', async () => {
				calls++;
				return 'answer';
			})
		).toBe('answer');
		expect(calls).toBe(1);
		// And the bad row was overwritten, so it cannot keep costing a call.
		expect(await cache.createPersistentCache<string>('legacy', 60_000, 10).take('k', async () => {
			calls++;
			return 'answer';
		})).toBe('answer');
		expect(calls).toBe(1);
	});
});
