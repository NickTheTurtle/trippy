import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * What conversion does when the live feed is not there to answer.
 *
 * The refresh is background and best-effort: a dropped connection, a 500, or a
 * body that does not say `success` must all leave the last good rates in place
 * rather than zero the table or throw on the next balance read. `fx.test.ts`
 * pins the happy refresh; this pins the three ways it can fail without conversion
 * noticing, so a trip in a foreign currency keeps converting off the fallback
 * table the module ships with.
 */

const tempRoot = join(tmpdir(), `trippy-fx-fallback-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = join(tempRoot, 'fx-fallback.test.db');

let fx: typeof import('../src/providers/fx.ts');
const FALLBACK_EUR_PER_USD = 0.92;

beforeAll(async () => {
	fx = await import('../src/providers/fx.ts');
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Runs a stubbed refresh to completion, past the 12-hour staleness gate. */
async function refreshWith(stub: typeof fetch): Promise<void> {
	const original = globalThis.fetch;
	globalThis.fetch = stub;
	vi.useFakeTimers({ shouldAdvanceTime: true });
	try {
		// Push well past MAX_AGE_MS so the refresh is allowed to run at all.
		vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
		fx.ensureRatesFresh();
		await new Promise((r) => setTimeout(r, 5));
	} finally {
		vi.useRealTimers();
		globalThis.fetch = original;
	}
}

describe('conversion when the feed fails', () => {
	it('keeps converting off the fallback table when the request throws', async () => {
		const before = fx.rateTo('EUR', 'USD');
		expect(before).toBeCloseTo(1 / FALLBACK_EUR_PER_USD, 10);

		const stub = vi.fn(async () => {
			throw new Error('network down');
		}) as unknown as typeof fetch;
		await refreshWith(stub);

		expect(stub).toHaveBeenCalled();
		// The market never landed, so the rate is exactly what it was.
		expect(fx.rateTo('EUR', 'USD')).toBeCloseTo(before, 10);
	});

	it('does not adopt rates from a non-ok response', async () => {
		const before = fx.rateTo('EUR', 'USD');
		const stub = vi.fn(async () =>
			new Response('upstream error', { status: 500 })
		) as unknown as typeof fetch;
		await refreshWith(stub);

		expect(stub).toHaveBeenCalled();
		expect(fx.rateTo('EUR', 'USD')).toBeCloseTo(before, 10);
	});

	it('ignores a 200 body that does not report success', async () => {
		const before = fx.rateTo('EUR', 'USD');
		const stub = vi.fn(async () =>
			new Response(JSON.stringify({ result: 'error', rates: { EUR: 0.1 } }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		) as unknown as typeof fetch;
		await refreshWith(stub);

		expect(stub).toHaveBeenCalled();
		// The bogus 0.1 was offered but not accepted, because result was not success.
		expect(fx.rateTo('EUR', 'USD')).toBeCloseTo(before, 10);
	});
});
