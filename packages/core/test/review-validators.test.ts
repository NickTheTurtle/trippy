import { describe, expect, it } from 'vitest';
import { CURRENCY_CODES, isCurrencyCode, unknownCurrency } from '../src/currency';
import { splitByWeight } from '../src/split';
import {
	DAY_MAX,
	DAY_MIN,
	dayOutOfWindow,
	isDayInWindow,
	isIanaZone,
	isOutsideTrip,
	isShareWeight,
	MAX_SHARE_WEIGHT,
	shareTooLarge,
	stayNightsProblem
} from '../src/validate';

/**
 * The shared validators the pre-1.0 review moved into core, so the routes, the
 * store and the clients answer the same question the same way.
 */

describe('isCurrencyCode', () => {
	it('takes every code the offline table converts', () => {
		for (const code of CURRENCY_CODES) expect(isCurrencyCode(code), code).toBe(true);
	});

	it('refuses a well-formed code nothing can convert offline', () => {
		// A code only the live feed carries was offered once rates landed and threw
		// on the next offline read.
		expect(isCurrencyCode('AFN')).toBe(false);
		expect(isCurrencyCode('XYZ')).toBe(false);
	});

	it('refuses lower case, blanks and prototype keys', () => {
		expect(isCurrencyCode('usd')).toBe(false);
		expect(isCurrencyCode('')).toBe(false);
		expect(isCurrencyCode('constructor')).toBe(false);
		expect(isCurrencyCode('__proto__')).toBe(false);
	});

	it('has one message for every field', () => {
		expect(unknownCurrency()).toBe('Pick a currency from the list.');
	});
});

describe('isIanaZone', () => {
	it('takes real zones, including UTC, which the old regex refused', () => {
		expect(isIanaZone('UTC')).toBe(true);
		expect(isIanaZone('Europe/Athens')).toBe(true);
		expect(isIanaZone('America/Argentina/Buenos_Aires')).toBe(true);
		expect(isIanaZone('America/Port-au-Prince')).toBe(true);
	});

	it('refuses a zone-shaped string Intl has never heard of', () => {
		// Passed `Area/Location` and then threw out of every clock drawn for it.
		expect(isIanaZone('Mars/Olympus_Mons')).toBe(false);
	});

	it('refuses offsets, blanks and junk', () => {
		expect(isIanaZone('+05:30')).toBe(false);
		expect(isIanaZone('-08:00')).toBe(false);
		expect(isIanaZone('')).toBe(false);
		expect(isIanaZone('   ')).toBe(false);
		expect(isIanaZone('x'.repeat(65))).toBe(false);
		expect(isIanaZone(42 as unknown as string)).toBe(false);
	});
});

describe('isShareWeight', () => {
	it('takes zero up to the ceiling', () => {
		expect(isShareWeight(0)).toBe(true);
		expect(isShareWeight(2.5)).toBe(true);
		expect(isShareWeight(MAX_SHARE_WEIGHT)).toBe(true);
	});

	it('refuses negatives, non-finite values and anything over the ceiling', () => {
		expect(isShareWeight(-1)).toBe(false);
		expect(isShareWeight(MAX_SHARE_WEIGHT + 1)).toBe(false);
		expect(isShareWeight(1e308)).toBe(false);
		expect(isShareWeight(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isShareWeight(Number.NaN)).toBe(false);
		expect(shareTooLarge()).toContain('1,000,000');
	});
});

describe('splitByWeight with weights that overflow', () => {
	it('still sums back to the total when the weights sum to Infinity', () => {
		const out = splitByWeight(10_000, [1e308, 1e308]);
		expect(out.every(Number.isFinite)).toBe(true);
		expect(out.reduce((a, b) => a + b, 0)).toBe(10_000);
		expect(out).toEqual([5000, 5000]);
	});

	it('still sums back when one weight times the total would overflow', () => {
		const out = splitByWeight(1e12, [1e300, 3e300]);
		expect(out.every(Number.isFinite)).toBe(true);
		expect(out.reduce((a, b) => a + b, 0)).toBe(1e12);
		expect(out).toEqual([2.5e11, 7.5e11]);
	});

	it('leaves ordinary weights exactly as they were', () => {
		expect(splitByWeight(100, [1, 1, 1])).toEqual([34, 33, 33]);
		expect(splitByWeight(-1000, [1, 3])).toEqual([-250, -750]);
	});
});

describe('the day window', () => {
	it('takes both ends and refuses a slipped year', () => {
		expect(isDayInWindow(DAY_MIN)).toBe(true);
		expect(isDayInWindow(DAY_MAX)).toBe(true);
		expect(isDayInWindow('1999-12-31')).toBe(false);
		expect(isDayInWindow('2101-01-01')).toBe(false);
		expect(dayOutOfWindow()).toBe('Pick a date between 2000 and 2100.');
	});
});

describe('isOutsideTrip', () => {
	it('bounds by both endpoints, inclusive', () => {
		expect(isOutsideTrip('2026-10-10', '2026-10-10', '2026-10-15')).toBe(false);
		expect(isOutsideTrip('2026-10-15', '2026-10-10', '2026-10-15')).toBe(false);
		expect(isOutsideTrip('2026-10-09', '2026-10-10', '2026-10-15')).toBe(true);
		expect(isOutsideTrip('2026-10-16', '2026-10-10', '2026-10-15')).toBe(true);
	});

	it('bounds nothing when a trip cannot say where it is', () => {
		expect(isOutsideTrip('1999-01-01', null, '2026-10-15')).toBe(false);
		expect(isOutsideTrip('1999-01-01', '2026-10-15', '2026-10-10')).toBe(false);
	});
});

describe('stayNightsProblem', () => {
	const first = '2026-10-10';
	const last = '2026-10-15';

	it('refuses zero and negative nights as order', () => {
		expect(stayNightsProblem('2026-10-12', '2026-10-12')).toBe('order');
		expect(stayNightsProblem('2026-10-12', '2026-10-11', first, last)).toBe('order');
	});

	it('lets the last night be the trip\u2019s last day, checking out the morning after', () => {
		expect(stayNightsProblem('2026-10-15', '2026-10-16', first, last)).toBeNull();
		expect(stayNightsProblem('2026-10-14', '2026-10-15', first, last)).toBeNull();
	});

	it('refuses a night before the trip or after its last day', () => {
		expect(stayNightsProblem('2026-10-09', '2026-10-11', first, last)).toBe('outside');
		expect(stayNightsProblem('2026-10-14', '2026-10-17', first, last)).toBe('outside');
		// A checkout on the first day means a night before the trip.
		expect(stayNightsProblem(null, first, first, last)).toBe('outside');
	});

	it('leaves a half-filled or undated range alone, and cannot bound an undated trip', () => {
		expect(stayNightsProblem(null, null, first, last)).toBeNull();
		expect(stayNightsProblem('2026-10-12', null, first, last)).toBeNull();
		expect(stayNightsProblem(null, '2026-10-13', first, last)).toBeNull();
		expect(stayNightsProblem('1999-01-01', '1999-01-02', null, null)).toBeNull();
	});
});
