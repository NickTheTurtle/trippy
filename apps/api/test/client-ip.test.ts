import { describe, expect, it } from 'vitest';
import { pickClientIp, parseProxyTrust, normalizeIp } from '../src/client-ip.ts';

/**
 * How the client address is read from `X-Forwarded-For`.
 *
 * The header is a list that grows left to right through proxies, and the client
 * writes the leftmost entry, so trusting the first value (as the code used to)
 * lets a caller mint a fresh identity per request by prepending an address and
 * slip every per-IP throttle. Behind our own proxy the trustworthy value is the
 * one it appended, counted from the right, or the first entry that is not one
 * of our own proxies when they are listed by address. These cases pin that a
 * spoofed prefix is ignored, that an unconfigured deployment ignores the header
 * completely, and that the same client cannot become two throttle keys by
 * arriving in a different notation.
 */

describe('pickClientIp, counting hops', () => {
	it('ignores the header entirely when no proxy is trusted', () => {
		// Local development: no proxy, so the socket address is the only truth and
		// a stray header must not override it.
		expect(pickClientIp('9.9.9.9', '127.0.0.1', 0)).toBe('127.0.0.1');
	});

	it('takes the value the single trusted proxy appended, not the first', () => {
		// Caddy appends the real client at the end. `1.1.1.1` is what the caller
		// tried to pass off as itself and must be ignored.
		expect(pickClientIp('1.1.1.1, 203.0.113.7', undefined, 1)).toBe('203.0.113.7');
	});

	it('is not fooled by a spoofed multi-hop prefix', () => {
		// The attacker stuffs several fake hops in; Caddy still appends the true
		// client last, and with one trusted proxy that last entry is what we take.
		expect(pickClientIp('evil, 1.1.1.1, 2.2.2.2, 203.0.113.7', undefined, 1)).toBe('203.0.113.7');
	});

	it('counts more than one hop from the right when configured', () => {
		expect(pickClientIp('client, 203.0.113.7, 10.0.0.1', undefined, 2)).toBe('203.0.113.7');
	});

	it('uses the sole entry a proxy adds when the client sent no header', () => {
		expect(pickClientIp('203.0.113.7', undefined, 1)).toBe('203.0.113.7');
	});

	it('falls back to the socket address when the header is too short to trust', () => {
		// More trusted hops than entries means the request did not really traverse
		// them; trusting the short list would be trusting a forgeable one.
		expect(pickClientIp('203.0.113.7', '10.0.0.5', 2)).toBe('10.0.0.5');
	});

	it('falls back to the socket address when the header is absent', () => {
		expect(pickClientIp(undefined, '10.0.0.5', 1)).toBe('10.0.0.5');
	});

	it('tolerates padding and empty entries', () => {
		expect(pickClientIp('  1.1.1.1 ,  , 203.0.113.7 ', undefined, 1)).toBe('203.0.113.7');
	});

	it('cannot be shortened by padding the header with unusable entries', () => {
		// `unknown` and obfuscated identifiers name nobody. Counting them as hops
		// would let a caller shift which entry we land on, which is the count-mode
		// version of spoofing.
		expect(pickClientIp('unknown, _hidden, 203.0.113.7', undefined, 1)).toBe('203.0.113.7');
	});

	it('answers "unknown" when nothing at all identifies the caller', () => {
		expect(pickClientIp(undefined, undefined, 0)).toBe('unknown');
	});
});

describe('pickClientIp, trusting proxies by address', () => {
	const ours = ['10.0.0.2', '10.0.0.3'];

	it('skips our own proxies from the right and takes the first that is not', () => {
		expect(pickClientIp('203.0.113.7, 10.0.0.3', '10.0.0.2', ours)).toBe('203.0.113.7');
	});

	it('is not fooled by a caller who names our proxy addresses itself', () => {
		// The attacker prepends our internal addresses hoping to be skipped over.
		// Skipping stops at the first entry that is not ours, counting from the
		// right, so the forged prefix is never reached.
		expect(pickClientIp('10.0.0.2, 10.0.0.3, 203.0.113.7, 10.0.0.3', '10.0.0.2', ours)).toBe(
			'203.0.113.7'
		);
	});

	it('ignores the header when the request did not come from one of our proxies', () => {
		// A direct hit on the app port with a hand-written header. Only a proxy we
		// run can be trusted to have appended anything truthful.
		expect(pickClientIp('203.0.113.7', '198.51.100.9', ours)).toBe('198.51.100.9');
	});

	it('falls back to the socket when every entry is one of ours', () => {
		expect(pickClientIp('10.0.0.3', '10.0.0.2', ours)).toBe('10.0.0.2');
	});

	it('matches a proxy that appears as an IPv4-mapped IPv6 socket address', () => {
		expect(pickClientIp('203.0.113.7, 10.0.0.3', '::ffff:10.0.0.2', ours)).toBe('203.0.113.7');
	});
});

describe('normalizing an address', () => {
	it('strips a port so one client is one throttle key', () => {
		expect(normalizeIp('203.0.113.7:54321')).toBe('203.0.113.7');
		expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
		expect(normalizeIp('[2001:db8::1]')).toBe('2001:db8::1');
	});

	it('unwraps an IPv4-mapped IPv6 address', () => {
		expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
	});

	it('treats a withheld or obfuscated identifier as no address at all', () => {
		expect(normalizeIp('unknown')).toBeNull();
		expect(normalizeIp('_secret')).toBeNull();
		expect(normalizeIp('   ')).toBeNull();
		expect(normalizeIp(undefined)).toBeNull();
	});

	it('is case-insensitive, so one IPv6 client is one key', () => {
		expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
	});
});

describe('reading the trusted-proxy setting', () => {
	it('reads a bare number as a hop count', () => {
		expect(parseProxyTrust('1')).toBe(1);
		expect(parseProxyTrust(' 2 ')).toBe(2);
	});

	it('reads anything else as a list of proxy addresses', () => {
		expect(parseProxyTrust('10.0.0.2, 10.0.0.3')).toEqual(['10.0.0.2', '10.0.0.3']);
	});

	it('fails closed on nothing, zero or garbage', () => {
		// An unparseable setting must not be allowed to mean "trust the header".
		expect(parseProxyTrust(undefined)).toBe(0);
		expect(parseProxyTrust('')).toBe(0);
		expect(parseProxyTrust('0')).toBe(0);
		expect(parseProxyTrust('yes please')).toEqual(['yes please']);
		expect(parseProxyTrust('unknown')).toBe(0);
		expect(parseProxyTrust('-1')).toEqual(['-1']);
	});

	it('an unusable setting still cannot let a spoofed header through', () => {
		// Whatever garbage lands in the variable, the result is only ever a count
		// or an address list, and neither reads a header from a peer that is not
		// on the list.
		expect(pickClientIp('1.1.1.1', '127.0.0.1', parseProxyTrust('yes please'))).toBe('127.0.0.1');
		expect(pickClientIp('1.1.1.1', '127.0.0.1', parseProxyTrust('-1'))).toBe('127.0.0.1');
		expect(pickClientIp('1.1.1.1', '127.0.0.1', parseProxyTrust(''))).toBe('127.0.0.1');
	});
});
