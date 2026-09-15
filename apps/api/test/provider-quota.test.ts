import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The per-caller quota on billed provider calls, and how it answers when spent.
 *
 * `cache.ts` stops a repeated question being re-bought, but a novel one costs
 * money every time and a signed-in caller can loop it. These cases pin that an
 * ordinary amount of searching is waved through, that a loop is stopped, that
 * one caller cannot spend another's allowance, and that routing degrades quietly
 * rather than failing a board load.
 */

// Set low ceilings before the modules that read them are loaded, so the limits
// are reached in a handful of calls rather than dozens.
process.env.TRIPPY_PROVIDER_LIMIT = '3';
process.env.TRIPPY_PROVIDER_IP_LIMIT = '100';
process.env.TRIPPY_ROUTING_LIMIT = '3';

let quota: typeof import('../src/provider-quota.ts');
let throttle: typeof import('@trippy/server/throttle');

beforeAll(async () => {
	[quota, throttle] = await Promise.all([
		import('../src/provider-quota.ts'),
		import('@trippy/server/throttle')
	]);
});

beforeEach(() => throttle.resetThrottle());

/** A fake Hono context carrying just what the quota code reads off it. */
function ctx(forwardedFor?: string, remote = '10.0.0.1') {
	const headers: Record<string, string> = {};
	let status = 0;
	return {
		req: {
			header: (n: string) => (n.toLowerCase() === 'x-forwarded-for' ? forwardedFor : undefined)
		},
		env: { incoming: { socket: { remoteAddress: remote, remotePort: 1, remoteFamily: 'IPv4' } } },
		header: (k: string, v: string) => {
			headers[k.toLowerCase()] = v;
		},
		json: (body: unknown, code: number) => {
			status = code;
			return { body, status, headers };
		},
		read: () => ({ headers, status })
	};
}

describe('billingGate', () => {
	it('waves through an ordinary run and then stops a loop', () => {
		// The gate is the closure a provider calls on a cache miss.
		const gate = quota.billingGate(ctx() as never, 'user-a');
		// The free allowance passes without a throw. (Limit 3 gives a few free
		// charges before backoff; the exact boundary is throttle's business.)
		expect(() => {
			for (let i = 0; i < 3; i++) gate();
		}).not.toThrow();
		// Kept hammering, it eventually refuses with a QuotaError carrying a wait.
		let threw: unknown;
		try {
			for (let i = 0; i < 20; i++) gate();
		} catch (err) {
			threw = err;
		}
		expect(threw).toBeInstanceOf(quota.QuotaError);
		expect((threw as InstanceType<typeof quota.QuotaError>).retryMs).toBeGreaterThan(0);
	});

	it("keeps one caller from spending another caller's allowance", () => {
		const a = quota.billingGate(ctx() as never, 'user-a');
		for (let i = 0; i < 20; i++) {
			try {
				a();
			} catch {
				/* drive user-a over the edge */
			}
		}
		// A different user on a different address starts clean.
		const b = quota.billingGate(ctx('203.0.113.9', '203.0.113.9') as never, 'user-b');
		expect(() => b()).not.toThrow();
	});
});

describe('routingGate', () => {
	it("allows a real trip's worth of legs, then degrades to false rather than throwing", () => {
		const gate = quota.routingGate('user-a');
		// Up to the ceiling it grants the billed call.
		expect(gate()).toBe(true);
		// Push well past the ceiling; it must return false, never throw, so a board
		// still loads with the free estimate.
		let sawFalse = false;
		for (let i = 0; i < 30; i++) if (gate() === false) sawFalse = true;
		expect(sawFalse).toBe(true);
	});
});

describe('quota429', () => {
	it('turns a QuotaError into a 429 with a Retry-After in seconds', () => {
		const c = ctx();
		const res = quota.quota429(c as never, new quota.QuotaError(4200)) as unknown as {
			status: number;
		};
		expect(res.status).toBe(429);
		expect(c.read().headers['retry-after']).toBe('5');
	});

	it('rethrows anything that is not a QuotaError', () => {
		const c = ctx();
		const boom = new Error('unrelated');
		expect(() => quota.quota429(c as never, boom)).toThrow('unrelated');
	});
});
