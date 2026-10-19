/**
 * Events that run past their own day: an overnight train, a red-eye, a two-day
 * hike.
 *
 * A timed event used to live on one day, `start_min` to `end_min` on `day`. It
 * may now end on a later day, `end_day`, at `end_min` on that day's clock. The
 * board draws it the way a phone calendar does: on its first day from its
 * start to midnight, on any day in between from midnight to midnight, and on
 * its last day from midnight to its end. Each of those is a segment, and every
 * reader (the server's planner, the web board, the native board, the agenda)
 * asks this module for the segment rather than working it out, so the three
 * cannot disagree about where the block sits.
 *
 * A travel event may also land somewhere with another clock. Its start is read
 * in its own city's zone and its end in the arrival city's (`end_city_id`), so
 * "depart 22:00 Athens, arrive 15:00 Tokyo" is stored exactly as the ticket
 * says it. Comparisons that need the real length (is the end after the start,
 * how long is a same-day flight west) go through the instants. Drawing reads
 * each day of the board on its own local clock, and only asks the instants for
 * the one block that clock alone cannot place: a same-day journey west, drawn
 * on the arrival clock for its real length (see `segmentOn`).
 *
 * A stay is not one of these. Its `end_day` is a checkout morning and it is
 * drawn as a band of nights; `plan.ts` owns that reading. Everything here
 * answers "not a span" for a stay.
 *
 * Pure: no I/O, no `Date.now`, safe in the browser and in React Native.
 */

import { eachDay, localDayMinutes, zonedMinutesToUtc } from './tz';
import { DAY_END_MIN, MIN_EVENT_MINS, type EventType } from './types';

/** The stored fields a span is read from. snake_case, as rows and the wire carry them. */
export interface SpanRow {
	type: EventType;
	day: string;
	/** For a timed event, the day it ends on (inclusive). Null means its own day. */
	end_day: string | null;
	start_min: number;
	end_min: number;
	city_id?: string | null;
	/** A travel event's arrival city, whose zone its end is read in. Null means its own city. */
	end_city_id?: string | null;
}

/** The zone of a city id, or null when it is not known. */
export type ZoneOf = (cityId: string | null | undefined) => string | null | undefined;

/** The longest a timed event may run, in days after the one it starts on. */
export const MAX_SPAN_DAYS = 14;

/** The day a timed event ends on. Its own day unless it runs past it. */
export function lastDayOf(row: SpanRow): string {
	if (row.type === 'stay') return row.day;
	return row.end_day && row.end_day > row.day ? row.end_day : row.day;
}

/** Whether a timed event runs past its own day. Never true of a stay. */
export function isMultiDay(row: SpanRow): boolean {
	return row.type !== 'stay' && !!row.end_day && row.end_day > row.day;
}

/** Whether a timed event is on the board on `day`. A stay never is: see `plan.ts`. */
export function coversDay(row: SpanRow, day: string): boolean {
	return row.type !== 'stay' && row.day <= day && day <= lastDayOf(row);
}

/** The days a timed event is drawn on, first to last. */
export function daysOf(row: SpanRow): string[] {
	if (row.type === 'stay') return [row.day];
	return eachDay(row.day, lastDayOf(row));
}

/** The zone the end is read in: the arrival city's for travel, else the event's own. */
function endZone(row: SpanRow, zoneOf?: ZoneOf): string | null | undefined {
	const arrival = row.type === 'travel' ? row.end_city_id : null;
	return zoneOf?.(arrival || row.city_id);
}

/**
 * The real length of an event in minutes, start to end, across days and zones.
 *
 * With no zones (no `zoneOf`, or cities without one) both ends are read on the
 * same clock, which is what every event without an arrival city has always
 * been. May be zero or negative for an event whose end is not after its start;
 * `spanProblem` is what refuses one.
 */
export function spanMinutes(row: SpanRow, zoneOf?: ZoneOf): number {
	const start = zonedMinutesToUtc(row.day, row.start_min, zoneOf?.(row.city_id));
	const end = zonedMinutesToUtc(lastDayOf(row), row.end_min, endZone(row, zoneOf));
	return Math.round((end - start) / 60000);
}

/** Whether the end is read on another clock from the start. */
export function crossesZones(row: SpanRow, zoneOf?: ZoneOf): boolean {
	if (row.type !== 'travel' || !row.end_city_id || row.end_city_id === row.city_id) return false;
	const from = zoneOf?.(row.city_id);
	const to = zoneOf?.(row.end_city_id);
	return !!from && !!to && from !== to;
}

/** Where a timed event sits on one day's board, in that day's minutes. */
export interface Segment {
	start: number;
	end: number;
	/** The event begins on this day, rather than carrying on from an earlier one. */
	startsHere: boolean;
	/** The event finishes on this day, rather than carrying on into a later one. */
	endsHere: boolean;
}

/**
 * The part of a timed event drawn on `day`, or null when it is not on it.
 *
 * First day: start to midnight. Days between: the whole day. Last day: midnight
 * to the end. A one-day event is its own start to its own end, as always.
 *
 * The one case the clock alone cannot draw is a same-day journey west, which
 * lands at an earlier local time than it left ("17:00 Tokyo, arrives 11:00 Los
 * Angeles"). It is drawn on the ARRIVAL clock: it ends at its arrival and
 * starts its real length before that, held at midnight. The day it is on goes
 * on in the arrival city, so lunch there at 13:00 has to come after the flight
 * on the board and in the planner; drawn from its departure (17:00 to
 * midnight) it sat after that lunch and the day read backwards. The board's
 * clock for the day is a local one either way, and the arrival is the local
 * clock the rest of the day is lived on.
 *
 * With no zones to measure it by, such a row has no real length, and is drawn
 * as the shortest block from its start, as it always was.
 */
export function segmentOn(row: SpanRow, day: string, zoneOf?: ZoneOf): Segment | null {
	if (!coversDay(row, day)) return null;
	const startsHere = day === row.day;
	const endsHere = day === lastDayOf(row);
	if (startsHere && endsHere) {
		if (row.end_min <= row.start_min) {
			const real = spanMinutes(row, zoneOf);
			if (real >= MIN_EVENT_MINS) {
				const start = Math.max(0, row.end_min - real);
				return {
					start,
					end: Math.max(row.end_min, start + MIN_EVENT_MINS),
					startsHere,
					endsHere
				};
			}
		}
		const end = Math.min(DAY_END_MIN, Math.max(row.end_min, row.start_min + MIN_EVENT_MINS));
		return { start: row.start_min, end, startsHere, endsHere };
	}
	return {
		start: startsHere ? row.start_min : 0,
		end: endsHere ? Math.max(row.end_min, MIN_EVENT_MINS) : DAY_END_MIN,
		startsHere,
		endsHere
	};
}

/**
 * What is wrong with an event's span, or null when nothing is.
 *
 * The end must come after the start by at least the shortest drawable block,
 * measured as instants so an arrival in another zone is judged by when it
 * really happens; and a span may run at most `MAX_SPAN_DAYS` past its start.
 * Stays are judged by their nights elsewhere and always pass here.
 */
export function spanProblem(row: SpanRow, zoneOf?: ZoneOf): 'end-before-start' | 'too-long' | null {
	if (row.type === 'stay') return null;
	if (row.end_day && row.end_day < row.day) return 'end-before-start';
	if (eachDay(row.day, lastDayOf(row)).length > MAX_SPAN_DAYS + 1) return 'too-long';
	if (spanMinutes(row, zoneOf) < MIN_EVENT_MINS) return 'end-before-start';
	return null;
}

/**
 * Whether both ends of a timed event are read on one clock on one day.
 *
 * That is the only shape the older rules were written for: an end after its
 * start on the same day, a drag that keeps the block inside its day, a resize
 * from the bottom edge, a start the board may suggest and later move. Each of
 * them is a statement about one day's minutes, and none of them means anything
 * for a block whose end is on another day or another clock, so each asks this
 * before it applies.
 */
export function onOneClock(row: SpanRow, zoneOf?: ZoneOf): boolean {
	return !isMultiDay(row) && !crossesZones(row, zoneOf);
}

/**
 * Whether a timed event began on an earlier day and is still going at `day`'s
 * midnight.
 *
 * The people on it did not wake up anywhere that morning: they are on the
 * train, or on the mountain. The planner reads this to keep last night's stay
 * from being their origin for the day.
 */
export function carriesInto(row: SpanRow, day: string): boolean {
	return row.day < day && coversDay(row, day);
}

/** The columns of a span as they are stored, once `normalizeSpan` has settled them. */
export interface StoredSpan {
	end_day: string | null;
	end_city_id: string | null;
	end_min: number;
}

/**
 * The one stored form of a span, so equal spans are equal rows.
 *
 * Several writes can describe the same block, and letting each be stored as it
 * came would leave readers to treat them as equal. So:
 *
 * - an end day on or before the start day is no end day (one day; an end day
 *   before the start is refused by `spanProblem` before anything is written)
 * - an arrival city is only a journey's, and the departure city named again is
 *   no arrival city
 * - 00:00 on a later day, on the same clock, is 24:00 on the day before it, so
 *   a block that runs to midnight ends on the last day it actually fills
 *   rather than leaving a fifteen-minute sliver on the next one (and, with it,
 *   a day in the day list and a person "still aboard" at that day's midnight).
 *   For a two-day span that makes it a one-day block ending at 24:00.
 *
 * A stay is left as it is apart from losing any arrival city: its `end_day` is a
 * checkout and has rules of its own.
 */
export function normalizeSpan(row: SpanRow, zoneOf?: ZoneOf): StoredSpan {
	const end_city_id =
		row.type === 'travel' && row.end_city_id && row.end_city_id !== row.city_id
			? row.end_city_id
			: null;
	if (row.type === 'stay') return { end_day: row.end_day, end_city_id: null, end_min: row.end_min };
	const end_day = row.end_day && row.end_day > row.day ? row.end_day : null;
	const settled = { ...row, end_day, end_city_id };
	if (end_day && row.end_min === 0 && !crossesZones(settled, zoneOf)) {
		const before = shiftIso(end_day, -1);
		return { end_day: before > row.day ? before : null, end_city_id, end_min: DAY_END_MIN };
	}
	return { end_day, end_city_id, end_min: row.end_min };
}

/** An ISO day moved by whole days, on UTC parts so no zone's DST can move it. */
function shiftIso(iso: string, delta: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/**
 * A wall clock read on another clock at the same instant: `minutes` past
 * midnight on `day` in `from`, as a day and minutes in `to`. A missing zone is
 * read as UTC, as everywhere else in the span rules.
 *
 * What lets a row stay true when one of its clocks goes away: a journey whose
 * arrival city is deleted is re-read on its departure clock rather than left
 * with an arrival time that now means a different instant.
 */
export function reclock(
	day: string,
	minutes: number,
	from: string | null | undefined,
	to: string | null | undefined
): { day: string; minutes: number } {
	const at = new Date(zonedMinutesToUtc(day, minutes, from));
	const local = localDayMinutes(to || 'UTC', at);
	return local.day
		? local
		: { day: at.toISOString().slice(0, 10), minutes: at.getUTCHours() * 60 + at.getUTCMinutes() };
}
