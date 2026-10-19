import { describe, expect, it } from 'vitest';
import {
	coversDay,
	crossesZones,
	daysOf,
	isMultiDay,
	lastDayOf,
	segmentOn,
	spanMinutes,
	spanProblem,
	type SpanRow
} from '../src/span';

const zones: Record<string, string> = {
	athens: 'Europe/Athens',
	tokyo: 'Asia/Tokyo',
	tokyo2: 'Asia/Tokyo',
	la: 'America/Los_Angeles'
};
const zoneOf = (id: string | null | undefined) => (id ? zones[id] : null);

function row(over: Partial<SpanRow>): SpanRow {
	return {
		type: 'activity',
		day: '2026-10-10',
		end_day: null,
		start_min: 600,
		end_min: 660,
		city_id: 'athens',
		end_city_id: null,
		...over
	};
}

describe('a one-day event', () => {
	it('is drawn from its start to its end on its own day only', () => {
		const r = row({});
		expect(isMultiDay(r)).toBe(false);
		expect(lastDayOf(r)).toBe('2026-10-10');
		expect(segmentOn(r, '2026-10-10')).toEqual({
			start: 600,
			end: 660,
			startsHere: true,
			endsHere: true
		});
		expect(segmentOn(r, '2026-10-11')).toBeNull();
		expect(spanMinutes(r, zoneOf)).toBe(60);
	});

	it('treats an end day equal to its own day as one day', () => {
		expect(isMultiDay(row({ end_day: '2026-10-10' }))).toBe(false);
	});
});

describe('an event over several days', () => {
	const hike = row({
		day: '2026-10-10',
		end_day: '2026-10-12',
		start_min: 8 * 60,
		end_min: 17 * 60
	});

	it('runs to midnight, through the day between, and from midnight to its end', () => {
		expect(daysOf(hike)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
		expect(segmentOn(hike, '2026-10-10')).toEqual({
			start: 480,
			end: 1440,
			startsHere: true,
			endsHere: false
		});
		expect(segmentOn(hike, '2026-10-11')).toEqual({
			start: 0,
			end: 1440,
			startsHere: false,
			endsHere: false
		});
		expect(segmentOn(hike, '2026-10-12')).toEqual({
			start: 0,
			end: 1020,
			startsHere: false,
			endsHere: true
		});
		expect(coversDay(hike, '2026-10-09')).toBe(false);
		expect(coversDay(hike, '2026-10-13')).toBe(false);
	});

	it('measures its real length across the days', () => {
		expect(spanMinutes(hike, zoneOf)).toBe(2 * 24 * 60 + 9 * 60);
	});

	it('draws a block ending at midnight on the next day as a sliver there', () => {
		const late = row({ end_day: '2026-10-11', start_min: 22 * 60, end_min: 0 });
		expect(segmentOn(late, '2026-10-11')?.end).toBe(15);
	});
});

describe('a journey that lands in another zone', () => {
	const flight = row({
		type: 'travel',
		day: '2026-10-10',
		end_day: '2026-10-11',
		start_min: 22 * 60,
		end_min: 15 * 60,
		city_id: 'athens',
		end_city_id: 'tokyo'
	});

	it('reads its end on the arrival clock', () => {
		// 22:00 Athens (UTC+3) is 19:00 UTC; 15:00 Tokyo (UTC+9) the next day is 06:00 UTC.
		expect(spanMinutes(flight, zoneOf)).toBe(11 * 60);
		expect(crossesZones(flight, zoneOf)).toBe(true);
		expect(segmentOn(flight, '2026-10-11')).toMatchObject({ start: 0, end: 900 });
	});

	it('does not count two cities on one clock as crossing zones', () => {
		expect(crossesZones({ ...flight, end_city_id: 'athens' }, zoneOf)).toBe(false);
		expect(crossesZones({ ...flight, city_id: 'tokyo', end_city_id: 'tokyo2' }, zoneOf)).toBe(
			false
		);
	});

	it('ignores an arrival city on anything but travel', () => {
		expect(crossesZones({ ...flight, type: 'activity' }, zoneOf)).toBe(false);
	});

	it('draws a same-day flight west on the arrival clock, for its real length', () => {
		const west = row({
			type: 'travel',
			start_min: 17 * 60,
			end_min: 11 * 60,
			city_id: 'tokyo',
			end_city_id: 'la'
		});
		// 17:00 Tokyo is 08:00 UTC; 11:00 LA (UTC-7) is 18:00 UTC: ten hours.
		expect(spanMinutes(west, zoneOf)).toBe(10 * 60);
		expect(spanProblem(west, zoneOf)).toBeNull();
		// It lands at 11:00 LA and left ten hours of that clock before: 01:00.
		expect(segmentOn(west, '2026-10-10', zoneOf)).toMatchObject({ start: 60, end: 660 });
		// Leaving 15:00 Tokyo is 23:00 the evening before in LA, so the part of
		// the flight on this day's arrival clock starts at midnight.
		expect(
			segmentOn({ ...west, start_min: 15 * 60, end_min: 5 * 60 }, '2026-10-10', zoneOf)
		).toMatchObject({ start: 0, end: 300 });
	});
});

describe('what a span may not be', () => {
	it('refuses an end before its start, on the clock and across zones', () => {
		expect(spanProblem(row({ start_min: 600, end_min: 600 }), zoneOf)).toBe('end-before-start');
		expect(spanProblem(row({ end_day: '2026-10-09' }), zoneOf)).toBe('end-before-start');
		const eastTooSoon = row({
			type: 'travel',
			start_min: 10 * 60,
			end_min: 4 * 60,
			city_id: 'tokyo',
			end_city_id: 'athens'
		});
		expect(spanProblem(eastTooSoon, zoneOf)).toBe('end-before-start');
	});

	it('refuses a span of more than fourteen days', () => {
		expect(spanProblem(row({ end_day: '2026-10-24' }), zoneOf)).toBeNull();
		expect(spanProblem(row({ end_day: '2026-10-25' }), zoneOf)).toBe('too-long');
	});

	it('never judges a stay, whose end day is a checkout', () => {
		const stay = row({ type: 'stay', end_day: '2026-10-13', start_min: 1260, end_min: 1440 });
		expect(spanProblem(stay, zoneOf)).toBeNull();
		expect(isMultiDay(stay)).toBe(false);
		expect(coversDay(stay, '2026-10-10')).toBe(false);
		expect(segmentOn(stay, '2026-10-10')).toBeNull();
	});
});
