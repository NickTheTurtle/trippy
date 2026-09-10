import { beforeEach, describe, expect, it } from 'vitest';
import {
	clearFailures,
	recordFailure,
	resetThrottle,
	retryAfterMs
} from '../src/infra/throttle.js';

/**
 * The backoff that keeps the login endpoint from being a password oracle.
 *
 * Verifying a password here is scrypt, which is deliberately slow so that a
 * stolen `users` table is worth little. Unthrottled, that same cost is a lever:
 * every guess burns real CPU, so guessing is both free to try and expensive to
 * serve. These cases pin the shape of the answer rather than its exact numbers,
 * except where the number is the point: the first few attempts must cost a real
 * person nothing.
 */
describe('failed-attempt throttling', () => {
	beforeEach(() => resetThrottle());

	it('lets an unknown key straight through', () => {
		expect(retryAfterMs('login:email:nobody@example.test')).toBe(0);
	});

	it('does not make a person who mistypes wait', () => {
		const key = 'login:email:typo@example.test';
		// Five is more mistakes than someone makes before reaching for their
		// password manager, and none of them should cost a wait.
		for (let i = 0; i < 5; i++) expect(recordFailure(key)).toBe(0);
		expect(retryAfterMs(key)).toBe(0);
	});

	it('starts waiting once the free attempts are used up, and doubles', () => {
		const key = 'login:email:guessed@example.test';
		for (let i = 0; i < 5; i++) recordFailure(key);

		const first = recordFailure(key);
		const second = recordFailure(key);
		const third = recordFailure(key);

		expect(first).toBeGreaterThan(0);
		expect(second).toBe(first * 2);
		expect(third).toBe(second * 2);
	});

	it('caps the wait, so a key can never be locked out for good', () => {
		const key = 'login:email:hammered@example.test';
		for (let i = 0; i < 100; i++) recordFailure(key);
		expect(recordFailure(key)).toBeLessThanOrEqual(15 * 60 * 1000);
	});

	it('counts down rather than staying blocked', () => {
		const now = 1_000_000;
		const key = 'login:email:waiting@example.test';
		for (let i = 0; i < 6; i++) recordFailure(key, now);
		const wait = retryAfterMs(key, now);
		expect(wait).toBeGreaterThan(0);
		expect(retryAfterMs(key, now + wait)).toBe(0);
	});

	it('forgets everything on a success', () => {
		const key = 'login:email:eventually@example.test';
		for (let i = 0; i < 10; i++) recordFailure(key);
		expect(retryAfterMs(key)).toBeGreaterThan(0);

		clearFailures(key);

		expect(retryAfterMs(key)).toBe(0);
		// And the count restarts, rather than resuming where it left off.
		expect(recordFailure(key)).toBe(0);
	});

	it('forgets a key that has been quiet for an hour', () => {
		const now = 5_000_000;
		const key = 'login:email:dormant@example.test';
		for (let i = 0; i < 10; i++) recordFailure(key, now);
		expect(retryAfterMs(key, now + 61 * 60 * 1000)).toBe(0);
	});

	it('keeps keys apart, so one account cannot lock out another', () => {
		const victim = 'login:email:victim@example.test';
		for (let i = 0; i < 20; i++) recordFailure('login:email:attacker@example.test');
		expect(retryAfterMs(victim)).toBe(0);
	});
});
