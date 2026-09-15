import { describe, expect, it } from 'vitest';
import { pickClientIp } from '../src/client-ip.ts';

/**
 * How the client address is read from `X-Forwarded-For`.
 *
 * The header is a list that grows left to right through proxies, and the client
 * writes the leftmost entry, so trusting the first value (as the code used to)
 * lets a caller mint a fresh identity per request by prepending an address and
 * slip every per-IP throttle. Behind our own proxy the trustworthy value is the
 * one it appended, counted from the right. These cases pin that a spoofed prefix
 * is ignored and a single-client deployment does not collapse everyone into one.
 */

describe('pickClientIp', () => {
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
		// Two trusted proxies: take the second from the right.
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

	it('answers "unknown" when nothing at all identifies the caller', () => {
		expect(pickClientIp(undefined, undefined, 0)).toBe('unknown');
	});
});
