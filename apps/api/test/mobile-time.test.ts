import { describe, expect, it } from 'vitest';
import { normalizeTimePickerMinutes } from '../../mobile/src/ui/time';

describe('mobile time picker normalization', () => {
	it('treats wrapped midnight as the end of day when editing an end time', () => {
		expect(normalizeTimePickerMinutes(0, 9 * 60 + 5, 24 * 60, 5)).toBe(24 * 60);
	});

	it('keeps midnight as start of day when it is in range', () => {
		expect(normalizeTimePickerMinutes(0, 0, 24 * 60, 5)).toBe(0);
	});

	it('maps values below the lower bound to end of day for an end-time picker', () => {
		expect(normalizeTimePickerMinutes(30, 23 * 60, 24 * 60, 5)).toBe(24 * 60);
	});
});
