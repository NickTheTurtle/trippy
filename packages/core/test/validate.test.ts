import { describe, expect, it } from 'vitest';
import {
	MAX_AMOUNT_CENTS,
	MAX_NAME_LENGTH,
	isAmountInRange,
	isNameLength,
	isValidEmail,
	safeExternalUrl
} from '../src/validate';

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

/**
 * Amounts are bounded because an unbounded one took a whole page down. An
 * expense above the safe-integer limit stored fine and then threw on every
 * later read of the trip's ledger, so Expenses answered 500 for everyone and
 * there was no screen left from which to delete the row.
 */
describe('isAmountInRange', () => {
	it('accepts the amounts a real trip produces, in either direction', () => {
		for (const cents of [1, -1, 100, 999_999_99, MAX_AMOUNT_CENTS, -MAX_AMOUNT_CENTS]) {
			expect(isAmountInRange(cents), String(cents)).toBe(true);
		}
	});

	it('rejects anything past the bound, including the value that broke the ledger', () => {
		for (const cents of [MAX_AMOUNT_CENTS + 1, -MAX_AMOUNT_CENTS - 1, 90071992547409920]) {
			expect(isAmountInRange(cents), String(cents)).toBe(false);
		}
	});

	it('rejects the non-numbers that arithmetic on user input produces', () => {
		for (const cents of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(isAmountInRange(cents), String(cents)).toBe(false);
		}
	});

	// The bound is well inside the safe-integer limit on purpose: the display
	// path divides cents into a double, which stops being cent-exact long before
	// the integers do. Measured on the rendered string, which is what a reader
	// actually sees, rather than on a subtraction that cancels its own precision.
	it('still renders every cent correctly at the bound', () => {
		expect((MAX_AMOUNT_CENTS / 100).toFixed(2)).toBe('100000000000.00');
		expect(((MAX_AMOUNT_CENTS + 1) / 100).toFixed(2)).toBe('100000000000.01');
		expect(((MAX_AMOUNT_CENTS + 99) / 100).toFixed(2)).toBe('100000000000.99');
	});
});

/**
 * Names are bounded because the layout is sized by them. A single unbroken run
 * of thousands of characters has no break opportunity, so it set the minimum
 * width of the card it was in and dragged the page out sideways with it.
 */
describe('isNameLength', () => {
	it('accepts a name at the limit and rejects the one past it', () => {
		expect(isNameLength('x'.repeat(MAX_NAME_LENGTH))).toBe(true);
		expect(isNameLength('x'.repeat(MAX_NAME_LENGTH + 1))).toBe(false);
	});

	it('has nothing to say about a blank name, which is a different check', () => {
		expect(isNameLength('')).toBe(true);
	});
});

/**
 * Links are member-authored and rendered as real anchors, so an unchecked one
 * is a script that runs when somebody else clicks the card.
 */
describe('safeExternalUrl', () => {
	it('keeps an ordinary http and https link as it is', () => {
		expect(safeExternalUrl('https://example.test/rooms?id=4')).toBe(
			'https://example.test/rooms?id=4'
		);
		expect(safeExternalUrl('http://example.test')).toBe('http://example.test');
	});

	it('assumes https for a bare host, which is how people type a link', () => {
		expect(safeExternalUrl('example.test/rooms')).toBe('https://example.test/rooms');
	});

	it('rejects every scheme that executes rather than navigates', () => {
		for (const raw of [
			'javascript:alert(1)',
			'JavaScript:alert(1)',
			'  javascript:alert(1)',
			'java\tscript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'vbscript:msgbox(1)',
			'file:///etc/passwd'
		]) {
			expect(safeExternalUrl(raw), raw).toBe(null);
		}
	});

	it('rejects a word that is not a link at all', () => {
		for (const raw of ['', '   ', 'banana', 'see the website']) {
			expect(safeExternalUrl(raw), raw).toBe(null);
		}
	});
});
