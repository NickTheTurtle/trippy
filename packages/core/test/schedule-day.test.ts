import { describe, expect, it } from 'vitest';
import { isIsoDay, localDay, openingScheduleDay } from '@trippy/core/schedule-day';

describe('the schedule opening day', () => {
	const trip = { start: '2027-02-10', end: '2027-02-12' };

	it('opens on today the first time while the trip is happening', () => {
		expect(openingScheduleDay({ ...trip, remembered: null, today: '2027-02-11' })).toBe(
			'2027-02-11'
		);
	});

	it('reopens on the day the reader left, ahead of today', () => {
		expect(openingScheduleDay({ ...trip, remembered: '2027-02-12', today: '2027-02-11' })).toBe(
			'2027-02-12'
		);
	});

	it('falls back to the server choice when neither day is in the trip', () => {
		expect(openingScheduleDay({ ...trip, remembered: '2027-03-01', today: '2027-02-09' })).toBe(
			null
		);
		expect(
			openingScheduleDay({ start: null, end: null, remembered: '2027-02-11', today: '2027-02-11' })
		).toBe(null);
	});

	it('ignores a remembered day the trip no longer has', () => {
		expect(openingScheduleDay({ ...trip, remembered: '2027-02-13', today: '2027-02-10' })).toBe(
			'2027-02-10'
		);
	});

	it('reads calendar days, not UTC instants', () => {
		expect(localDay(new Date(2027, 1, 10, 23, 30))).toBe('2027-02-10');
		expect(isIsoDay('2027-02-29')).toBe(false);
		expect(isIsoDay('2028-02-29')).toBe(true);
	});
});
