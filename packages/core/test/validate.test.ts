import { describe, expect, it } from 'vitest';
import { isValidEmail } from '../src/validate';

/**
 * One shape check, used by registration, the invite form and the profile form.
 * Registration used to have none at all, so `nope` could own an account that
 * could never be invited anywhere or mailed at.
 */
describe('isValidEmail', () => {
	it('accepts an ordinary address', () => {
		expect(isValidEmail('nova@example.test')).toBe(true);
	});

	it('accepts the subdomains, plus tags and dots real addresses use', () => {
		for (const email of [
			'nova.traveler@mail.example.test',
			'nova+trips@example.test',
			"o'brien@example.test",
			'nova_1@example.co.uk'
		]) {
			expect(isValidEmail(email), email).toBe(true);
		}
	});

	it('rejects anything without a single local@domain.tld shape', () => {
		for (const email of [
			'',
			'   ',
			'nope',
			'@example.test',
			'nova@',
			'nova@example',
			'nova@@example.test',
			'nova example@test.test',
			'nova@exam ple.test'
		]) {
			expect(isValidEmail(email), email).toBe(false);
		}
	});

	// Pinned so the laxity is a decision rather than a surprise. The check is
	// for a typo in a field, not a delivery guarantee, and mail to a doubled dot
	// bounces on its own. Tightening the pattern to catch this would start
	// rejecting addresses that genuinely deliver.
	it('lets a doubled dot through, which the loose pattern is expected to do', () => {
		expect(isValidEmail('nova@example..test')).toBe(true);
	});

	it('ignores surrounding whitespace and case, because the callers all trim and lower-case', () => {
		expect(isValidEmail('  Nova@Example.Test  ')).toBe(true);
	});

	it('does not treat a trailing dot as a top-level domain', () => {
		expect(isValidEmail('nova@example.')).toBe(false);
	});
});
