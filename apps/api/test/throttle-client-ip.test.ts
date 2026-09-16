import { beforeEach, describe, expect, it } from 'vitest';
import { pickClientIp } from '../src/client-ip.ts';
import {
	recordFailure,
	retryAfterMs,
	clearFailures,
	resetThrottle,
	REGISTER_ATTEMPTS
} from '@trippy/server/throttle';

/**
 * The client address and the throttle, together.
 *
 * Neither half is interesting alone: the throttle is only as good as the key it
 * counts against, and the key is only as good as the header parsing behind it.
 * If a caller can choose their own client address, the exponential backoff on
 * login and registration is decorative, because every guess arrives as a brand
 * new client. These cases drive the two through each other the way a request
 * does.
 */

const SOCKET = '198.51.100.9';
const LOGIN_FREE_ATTEMPTS = 5;

beforeEach(() => resetThrottle());

describe('a spoofed forwarded-for cannot reset the throttle', () => {
	it('counts a run of guesses with forged headers as one caller', () => {
		// No proxy configured, so the header is ignored and every attempt lands on
		// the socket address. The attacker varies the header on every request.
		let wait = 0;
		for (let i = 0; i < 20; i++) {
			const ip = pickClientIp(`10.10.10.${i}`, SOCKET, 0);
			expect(ip).toBe(SOCKET);
			wait = recordFailure(`login:ip:${ip}`);
		}
		expect(wait).toBeGreaterThan(0);
		expect(retryAfterMs(`login:ip:${SOCKET}`)).toBeGreaterThan(0);
	});

	it('still counts them as one caller behind a single trusted proxy', () => {
		// Behind Caddy, which appends the true client last. The forged prefix
		// changes on every request and must change nothing about the key.
		let wait = 0;
		for (let i = 0; i < 20; i++) {
			const ip = pickClientIp(`10.10.10.${i}, 203.0.113.7`, '127.0.0.1', 1);
			expect(ip).toBe('203.0.113.7');
			wait = recordFailure(`login:ip:${ip}`);
		}
		expect(wait).toBeGreaterThan(0);
	});

	it('would have been defeated by reading the leftmost value', () => {
		// The bug this parsing exists to prevent, spelled out: taking the first
		// entry gives the attacker a fresh key per request and no backoff ever
		// applies.
		for (let i = 0; i < 20; i++) {
			const spoofed = `10.10.10.${i}`;
			recordFailure(`login:ip:${spoofed}`);
			expect(retryAfterMs(`login:ip:${spoofed}`)).toBe(0);
		}
	});

	it('does not make one client out of two real ones', () => {
		// The mirror-image bug. Blocking a whole deployment because one caller
		// misbehaved is its own denial of service.
		for (let i = 0; i < 20; i++) {
			recordFailure(`login:ip:${pickClientIp('evil, 203.0.113.7', '127.0.0.1', 1)}`);
		}
		expect(retryAfterMs(`login:ip:203.0.113.8`)).toBe(0);
	});

	it('cannot be dodged by changing notation', () => {
		// Same client, three ways of writing it. Normalisation is what keeps them
		// one throttle key.
		const forms = ['203.0.113.7', '203.0.113.7:51000', '::ffff:203.0.113.7'];
		for (const form of forms) {
			expect(pickClientIp(`evil, ${form}`, '127.0.0.1', 1)).toBe('203.0.113.7');
		}
		for (let i = 0; i < 20; i++) recordFailure('login:ip:203.0.113.7');
		expect(retryAfterMs('login:ip:203.0.113.7')).toBeGreaterThan(0);
	});
});

describe('the registration quota uses the same key', () => {
	it('lets a real person through and stops a bulk signup run', () => {
		const ip = pickClientIp('1.1.1.1, 203.0.113.7', '127.0.0.1', 1);
		// Well inside the allowance: a household registering a few accounts.
		for (let i = 0; i < REGISTER_ATTEMPTS; i++) {
			recordFailure(`register:ip:${ip}`, Date.now(), REGISTER_ATTEMPTS);
		}
		expect(retryAfterMs(`register:ip:${ip}`)).toBe(0);
		// One past it, and the backoff starts.
		recordFailure(`register:ip:${ip}`, Date.now(), REGISTER_ATTEMPTS);
		expect(retryAfterMs(`register:ip:${ip}`)).toBeGreaterThan(0);
	});

	it('is a looser allowance than the login one, on purpose', () => {
		// Signing up is not guessing a secret, so the registration ceiling is
		// about bulk account creation and can sit well above the login one.
		expect(REGISTER_ATTEMPTS).toBeGreaterThan(LOGIN_FREE_ATTEMPTS);
	});

	it('forgets a caller once they succeed', () => {
		const ip = pickClientIp(undefined, SOCKET, 0);
		for (let i = 0; i < 10; i++) recordFailure(`login:ip:${ip}`);
		expect(retryAfterMs(`login:ip:${ip}`)).toBeGreaterThan(0);
		clearFailures(`login:ip:${ip}`);
		expect(retryAfterMs(`login:ip:${ip}`)).toBe(0);
	});
});
