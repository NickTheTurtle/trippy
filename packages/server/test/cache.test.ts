import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempRoot = join(tmpdir(), `trippy-cache-tests-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = join(tempRoot, 'cache.test.db');

let cache: typeof import('../src/infra/cache.ts');
let photos: typeof import('../src/providers/photo-cache.ts');

beforeAll(async () => {
	[cache, photos] = await Promise.all([
		import('../src/infra/cache.ts'),
		import('../src/providers/photo-cache.ts')
	]);
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
});
