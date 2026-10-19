/**
 * How a block that runs past its own day is worded, on the board and in the
 * agenda.
 *
 * Wording only. Where a block sits on a day, which days it covers and whether
 * its end is on another clock are `@trippy/core/span`'s answers, and this file
 * asks for them rather than working any of them out.
 */
import {
	crossesZones,
	isMultiDay,
	lastDayOf,
	segmentOn,
	type Segment,
	type SpanRow,
	type ZoneOf
} from '@trippy/core/span';
import { daysBetween, shiftDay } from '@trippy/core/plan';
import { DAY_END_MIN } from '@trippy/core/types';
import { zoneAbbr, zonedMinutesToUtc } from '@trippy/core/tz';
import { copy } from '../../copy';
import { clock, clockRange, dayLabel } from './shared';
import type { Cell } from './types';

const cs = copy.schedule;

/** A city id to its zone, built from the payload's cities. */
export function zoneLookup(cities: readonly (Cell | null)[]): ZoneOf {
	const byId = new Map(cities.filter((c): c is Cell => c != null).map((c) => [c.id, c.tz]));
	return (id) => (id ? byId.get(id) : undefined);
}

/**
 * Where a block sits on `day`.
 *
 * `segmentOn`, with the one fallback the board needs: a row the server listed
 * on a day the rule says it is not on (a stale payload mid-reload) is drawn on
 * its own clock rather than dropped, which is what the board did before spans.
 */
export function segmentFor(row: SpanRow, day: string, zoneOf: ZoneOf): Segment {
	return (
		segmentOn(row, day, zoneOf) ?? {
			start: row.start_min,
			end: Math.max(row.end_min, row.start_min),
			startsHere: true,
			endsHere: true
		}
	);
}

/**
 * The arrival zone's abbreviation, or '' when the end is on the start's clock.
 *
 * Read at the arrival instant, so a zone that changes its clocks during the
 * trip names the offset that is true when the journey lands.
 */
export function arrivalZone(row: SpanRow, zoneOf: ZoneOf): string {
	if (!crossesZones(row, zoneOf)) return '';
	const tz = zoneOf(row.end_city_id);
	if (!tz) return '';
	return zoneAbbr(tz, new Date(zonedMinutesToUtc(lastDayOf(row), row.end_min, tz)));
}

/** The departure zone's abbreviation, shown beside it only when the end is on another clock. */
export function departureZone(row: SpanRow, zoneOf: ZoneOf): string {
	if (!crossesZones(row, zoneOf)) return '';
	const tz = zoneOf(row.city_id);
	if (!tz) return '';
	return zoneAbbr(tz, new Date(zonedMinutesToUtc(row.day, row.start_min, tz)));
}

/** The end as written in full: "3:00 PM", or "3:00 PM GMT+9" off the start's clock. */
export function endClock(row: SpanRow, zoneOf: ZoneOf): string {
	const zone = arrivalZone(row, zoneOf);
	return zone ? `${clock(row.end_min)} ${zone}` : clock(row.end_min);
}

/**
 * The time a segment is labelled with, or null for a block that is all on one
 * day, which keeps the label it always had.
 *
 * "From 10:00 PM" where it begins, "Until 3:00 PM" where it ends, "All day" in
 * between. The end carries the arrival zone, since that is the one place it is
 * written out.
 */
export function segmentTime(row: SpanRow, seg: Segment, zoneOf: ZoneOf): string | null {
	if (seg.startsHere && seg.endsHere) return null;
	if (seg.startsHere) return cs.span.from(clock(row.start_min));
	// A last day that runs to its own midnight is a whole day, not one that
	// ends at the 12:00 AM it begins with.
	if (seg.endsHere && row.end_min < DAY_END_MIN) return cs.span.until(endClock(row, zoneOf));
	return cs.span.allDay;
}

/**
 * A day as the end of a range is named: its weekday, "Sun", while the range is
 * inside a week, and the date, "Apr 25", once a weekday alone could mean two
 * days of it. Both are the parts `dayLabel` already writes.
 */
function rangeDay(iso: string, within: boolean): string {
	const [weekday, date] = dayLabel(iso).split(', ');
	return within ? weekday : date;
}

/**
 * The whole span, "10:00 PM Sat to 3:00 PM Sun", for a block that runs past
 * its own day. A block on one day is "10:00 - 11:00 AM" the way it always was,
 * with the arrival zone on the end when the journey changes clocks.
 */
export function spanRange(row: SpanRow, zoneOf: ZoneOf): string {
	if (!isMultiDay(row)) {
		const zone = arrivalZone(row, zoneOf);
		return zone
			? `${clock(row.start_min)} - ${endClock(row, zoneOf)}`
			: clockRange(row.start_min, row.end_min);
	}
	// An end at 24:00 is said the way it is typed and read: 12:00 AM on the
	// morning after.
	const last = row.end_min >= DAY_END_MIN ? shiftDay(lastDayOf(row), 1) : lastDayOf(row);
	const within = daysBetween(row.day, last) < 7;
	return cs.span.range(
		`${clock(row.start_min)} ${rangeDay(row.day, within)}`,
		`${endClock(row, zoneOf)} ${rangeDay(last, within)}`
	);
}
