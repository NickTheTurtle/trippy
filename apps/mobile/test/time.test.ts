import { describe, expect, it } from 'vitest';
import { normalizeTimePickerMinutes } from '../src/ui/time';

const DAY_END = 24 * 60;

describe('normalizeTimePickerMinutes', () => {
	it('reads 12:00 AM as the end of the day when the field can reach midnight', () => {
		expect(normalizeTimePickerMinutes(0, 9 * 60 + 15, DAY_END, 5)).toBe(DAY_END);
		// Android does not enforce the step, so a minute past midnight counts too.
		expect(normalizeTimePickerMinutes(2, 9 * 60 + 15, DAY_END, 5)).toBe(DAY_END);
	});

	it('keeps 12:00 AM as the start of the day when midnight is in range', () => {
		expect(normalizeTimePickerMinutes(0, 0, DAY_END - 15, 5)).toBe(0);
	});

	it('clamps an end picked before the start up to the earliest end, not to midnight', () => {
		expect(normalizeTimePickerMinutes(9 * 60, 10 * 60 + 15, DAY_END, 5)).toBe(10 * 60 + 15);
	});

	it('snaps to the step and holds the upper bound', () => {
		expect(normalizeTimePickerMinutes(9 * 60 + 7, 0, DAY_END, 5)).toBe(9 * 60 + 5);
		expect(normalizeTimePickerMinutes(23 * 60 + 55, 0, 23 * 60 + 45, 5)).toBe(23 * 60 + 45);
	});
});
