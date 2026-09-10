import { describe, expect, it } from 'vitest';
import {
	eachDay,
	formatDayRange,
	isDayString,
	localDayMinutes,
	localTime,
	normalizeDay,
	offsetFromHome,
	tzOffsetMinutes,
	zoneAbbr
} from '@trippy/core/tz';

const supportsTimeZone = (tz: string) => {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
		return true;
	} catch {
		return false;
	}
};

describe('isDayString', () => {
	it('accepts real calendar days and rejects impossible dates', () => {
		expect(isDayString('2026-02-28')).toBe(true);
		expect(isDayString('2026-02-31')).toBe(false);
		expect(isDayString('2026-13-01')).toBe(false);
		expect(isDayString('2026-2-01')).toBe(false);
	});
});

describe('normalizeDay', () => {
	it('returns null for empty, whitespace and invalid input', () => {
		expect(normalizeDay('')).toBeNull();
		expect(normalizeDay('   ')).toBeNull();
		expect(normalizeDay('2026-02-31')).toBeNull();
		expect(normalizeDay(null)).toBeNull();
	});

	it('trims and returns a valid day', () => {
		expect(normalizeDay(' 2026-04-16 ')).toBe('2026-04-16');
	});
});

describe('eachDay', () => {
	it('returns inclusive days for a valid range', () => {
		expect(eachDay('2026-04-16', '2026-04-18')).toEqual(['2026-04-16', '2026-04-17', '2026-04-18']);
	});

	it('returns an empty array for invalid or inverted ranges', () => {
		expect(eachDay('2026-02-31', '2026-03-01')).toEqual([]);
		expect(eachDay('2026-04-18', '2026-04-16')).toEqual([]);
	});
});

describe('formatDayRange', () => {
	it('formats same month, cross month and cross year ranges', () => {
		expect(formatDayRange('2026-04-16', '2026-04-20')).toBe('Apr 16 \u2013 20, 2026');
		expect(formatDayRange('2026-04-28', '2026-05-03')).toBe('Apr 28 \u2013 May 3, 2026');
		expect(formatDayRange('2026-12-30', '2027-01-02')).toBe('Dec 30, 2026 \u2013 Jan 2, 2027');
	});

	it('collapses a same-day range to a single date', () => {
		expect(formatDayRange('2028-01-02', '2028-01-02')).toBe('Jan 2, 2028');
		expect(formatDayRange('2026-04-16', '2026-04-16')).toBe('Apr 16, 2026');
	});

	it('keeps adjacent days as a range', () => {
		expect(formatDayRange('2026-04-16', '2026-04-17')).toBe('Apr 16 \u2013 17, 2026');
		expect(formatDayRange('2026-04-30', '2026-05-01')).toBe('Apr 30 \u2013 May 1, 2026');
		expect(formatDayRange('2026-12-31', '2027-01-01')).toBe('Dec 31, 2026 \u2013 Jan 1, 2027');
	});

	it('shows both years when the same month falls in different years', () => {
		expect(formatDayRange('2026-01-30', '2027-01-02')).toBe('Jan 30, 2026 \u2013 Jan 2, 2027');
	});

	it('passes a malformed date through unchanged', () => {
		expect(formatDayRange('not-a-day', 'not-a-day')).toBe('not-a-day');
	});
});

describe('localDayMinutes', () => {
	it('reflects a daylight saving time spring-forward jump', () => {
		expect(localDayMinutes('America/Los_Angeles', new Date('2026-03-08T09:30:00Z'))).toEqual({
			day: '2026-03-08',
			minutes: 90
		});
		expect(localDayMinutes('America/Los_Angeles', new Date('2026-03-08T10:30:00Z'))).toEqual({
			day: '2026-03-08',
			minutes: 210
		});
	});

	it('reflects a daylight saving time fall-back repeat hour', () => {
		expect(localDayMinutes('America/Los_Angeles', new Date('2026-11-01T08:30:00Z'))).toEqual({
			day: '2026-11-01',
			minutes: 90
		});
		expect(localDayMinutes('America/Los_Angeles', new Date('2026-11-01T09:30:00Z'))).toEqual({
			day: '2026-11-01',
			minutes: 90
		});
	});

	it('handles European daylight saving time spring-forward and fall-back boundaries', () => {
		expect(localDayMinutes('Europe/Athens', new Date('2026-03-29T00:30:00Z'))).toEqual({
			day: '2026-03-29',
			minutes: 150
		});
		expect(localDayMinutes('Europe/Athens', new Date('2026-03-29T01:30:00Z'))).toEqual({
			day: '2026-03-29',
			minutes: 270
		});
		expect(localDayMinutes('Europe/Athens', new Date('2026-10-25T00:30:00Z'))).toEqual({
			day: '2026-10-25',
			minutes: 210
		});
		expect(localDayMinutes('Europe/Athens', new Date('2026-10-25T01:30:00Z'))).toEqual({
			day: '2026-10-25',
			minutes: 210
		});
	});

	it('handles non-hour offsets', () => {
		expect(localDayMinutes('Asia/Kolkata', new Date('2026-01-01T00:00:00Z'))).toEqual({
			day: '2026-01-01',
			minutes: 330
		});
	});

	it('handles southern hemisphere daylight saving time', () => {
		expect(localDayMinutes('Australia/Sydney', new Date('2026-01-01T00:00:00Z'))).toEqual({
			day: '2026-01-01',
			minutes: 660
		});
		expect(localDayMinutes('Australia/Sydney', new Date('2026-07-01T00:00:00Z'))).toEqual({
			day: '2026-07-01',
			minutes: 600
		});
	});

	it('distinguishes zones on opposite sides of the international date line at the same instant', () => {
		const at = new Date('2026-01-01T10:15:00Z');
		expect(localDayMinutes('Pacific/Auckland', at)).toEqual({
			day: '2026-01-01',
			minutes: 1395
		});
		expect(localDayMinutes('America/Los_Angeles', at)).toEqual({
			day: '2026-01-01',
			minutes: 135
		});
	});

	it('returns the local day across the international date line', () => {
		expect(localDayMinutes('Pacific/Kiritimati', new Date('2026-01-01T10:15:00Z'))).toEqual({
			day: '2026-01-02',
			minutes: 15
		});
	});

	it('returns an empty day and zero minutes for an unknown time zone', () => {
		expect(localDayMinutes('Not/AZone', new Date('2026-01-01T00:00:00Z'))).toEqual({ day: '', minutes: 0 });
	});
});

describe('tzOffsetMinutes', () => {
	it('returns offsets including DST and half-hour zones', () => {
		expect(tzOffsetMinutes('America/Los_Angeles', new Date('2026-01-01T12:00:00Z'))).toBe(-480);
		expect(tzOffsetMinutes('America/Los_Angeles', new Date('2026-07-01T12:00:00Z'))).toBe(-420);
		expect(tzOffsetMinutes('Asia/Kolkata', new Date('2026-01-01T12:00:00Z'))).toBe(330);
	});

	it('returns zero for an unknown time zone', () => {
		expect(tzOffsetMinutes('Not/AZone', new Date('2026-01-01T00:00:00Z'))).toBe(0);
	});
});

describe('localTime', () => {
	it('formats local clock time in the requested zone', () => {
		expect(localTime('Europe/Athens', new Date('2026-04-16T09:30:00Z'))).toBe('12:30 PM');
		expect(localTime('Asia/Kolkata', new Date('2026-04-16T09:30:00Z'))).toBe('3:00 PM');
	});

	it('returns an empty string for an unknown time zone', () => {
		expect(localTime('Not/AZone', new Date('2026-01-01T00:00:00Z'))).toBe('');
	});
});

describe('zoneAbbr', () => {
	it('returns a non-empty abbreviation for real zones', () => {
		expect(zoneAbbr('America/Los_Angeles', new Date('2026-07-01T12:00:00Z'))).not.toBe('');
		expect(zoneAbbr('Europe/Athens', new Date('2026-01-01T12:00:00Z'))).not.toBe('');
	});

	it('returns an empty string for an unknown time zone', () => {
		expect(zoneAbbr('Not/AZone', new Date('2026-01-01T00:00:00Z'))).toBe('');
	});
});

describe('offsetFromHome', () => {
	it('describes ahead, behind and same-time offsets', () => {
		const at = new Date('2026-01-01T12:00:00Z');
		expect(offsetFromHome('Europe/Athens', 'America/Los_Angeles', at)).toBe('10h ahead');
		expect(offsetFromHome('America/Los_Angeles', 'Europe/Athens', at)).toBe('10h behind');
		expect(offsetFromHome('America/Los_Angeles', 'America/Los_Angeles', at)).toBe('same time');
		expect(offsetFromHome('America/Los_Angeles', '', at)).toBe('same time');
	});

	it('includes minute offsets for half-hour zones', () => {
		expect(offsetFromHome('Asia/Kolkata', 'Europe/Athens', new Date('2026-01-01T12:00:00Z'))).toBe(
			'3h 30m ahead'
		);
		expect(offsetFromHome('Australia/Adelaide', 'Australia/Sydney', new Date('2026-01-01T12:00:00Z'))).toBe(
			'30m behind'
		);
	});

	it('falls back to same time when both unknown zones resolve to zero offset', () => {
		expect(supportsTimeZone('Not/AZone')).toBe(false);
		expect(offsetFromHome('Not/AZone', 'Also/NotAZone', new Date('2026-01-01T12:00:00Z'))).toBe('same time');
	});
});
