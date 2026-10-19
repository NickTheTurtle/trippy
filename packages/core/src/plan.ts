/**
 * Turning stored rows into a day's plan.
 *
 * `travel.ts` answers "given these travellers and these anchored stops, which
 * journeys exist?". It knows nothing about how an event is stored. This module
 * is the step before it: the projection from a stored row to a `PlannerEvent`,
 * plus the handful of rules about days and nights that have to be applied
 * before the planner is called at all.
 *
 * It exists because that step was written twice, once in
 * `packages/server/src/persistence/schedule.ts` and once in
 * `apps/web/src/pages/schedule/replan.ts`, and the two must agree exactly. The
 * server plans the legs it stores; the client replans the same day while an
 * edit is open, so the reader sees the answer before the write lands. Any
 * disagreement shows up as journeys appearing, moving or vanishing at the
 * moment a dialog closes, which reads as the board being wrong rather than as
 * two functions having drifted. Four rules were copied between them:
 *
 * 1. the field renaming from a stored row to a `PlannerEvent`
 * 2. blanking the coordinates of a type that cannot have a location
 * 3. expanding an empty `people` list to the whole roster
 * 4. which stays are a night of the day, and which of them the board draws
 *
 * A fifth arrived with events that run past their own day: such a block is
 * planned on each day it covers by that day's part of it (`segmentOn` in
 * `span.ts`), and the people still on it at a day's midnight do not start that
 * day from last night's stay. That is the same kind of rule, so it is here too.
 *
 * All of them are here now, and the two call sites are two calls.
 *
 * Nothing here does I/O. It takes rows and a roster as arguments, which is what
 * lets the same code run in the API process and in a browser.
 */

import { DAY_END_MIN, isLocatedType, type EventType } from './types';
import {
	carriesInto,
	crossesZones,
	onOneClock,
	segmentOn,
	type SpanRow,
	type ZoneOf
} from './span';
import { zonedMinutesToUtc } from './tz';
import {
	guessLeg,
	legKey,
	placeLeg,
	planLegs,
	type PlacedLeg,
	type PlannedLeg,
	type PlannerEvent
} from './travel';

/**
 * The stored columns the planner reads off an event.
 *
 * Structural rather than a class, and snake_case because that is what both a
 * SQLite row and the wire shape the client holds actually look like. Neither
 * end has to build an adapter object to call in here.
 */
export interface PlannableRow {
	id: string;
	type: EventType;
	/** Minutes from midnight, in the event's own city's zone. */
	start_min: number;
	/** Minutes from midnight, in the event's own city's zone. */
	end_min: number;
	lat: number | null;
	lng: number | null;
	/** Trip member ids, or empty for the whole group. See `toPlannerEvent`. */
	people: string[];
	/*
	 * Where the row sits in time beyond its own clock. All optional, so a caller
	 * holding bare one-day rows still plans exactly as it always did; a row that
	 * carries `day` is read through `segmentOn` on the day being planned, which
	 * is what lets a block that runs over several days sit on each of them.
	 */
	/** The day the row starts on. */
	day?: string;
	/** For a timed event, the day it ends on (inclusive); for a stay, its checkout. */
	end_day?: string | null;
	/** The city whose zone `start_min` is read in. */
	city_id?: string | null;
	/** A journey's arrival city, whose zone `end_min` is read in. */
	end_city_id?: string | null;
}

/** A stay is a range of nights rather than a point, so it carries both ends. */
export interface StayRange {
	day: string;
	/** The morning of checkout, exclusive. Null means a single night. */
	end_day: string | null;
}

/** What identifies a booking: the same room, held by the same people. */
export interface StayIdentity extends StayRange {
	title: string;
	poi_id: string | null;
	lodging_id: string | null;
	lat: number | null;
	lng: number | null;
	people: string[];
}

/** A stay as the planner sees it: a booking with a range and some travellers. */
export interface PlannableStay extends PlannableRow, StayRange {
	// Restated because the two bases disagree on optionality, and a stay always has both.
	day: string;
	end_day: string | null;
}

/**
 * Shift an ISO day, staying in UTC so a DST boundary cannot move it.
 *
 * A day string is a calendar day, not an instant. Adding 86400000 milliseconds
 * to a local `Date` gets the wrong answer twice a year in every zone that moves
 * its clocks, and a trip spans several zones, so there is no local midnight to
 * be right about anyway. Arithmetic on the UTC parts has no such day.
 */
export function shiftDay(iso: string, delta: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/**
 * Whole calendar days from `from` to `to`, negative when `to` is earlier.
 *
 * The inverse of `shiftDay`, and on UTC parts for the same reason: a DST
 * boundary between two local midnights is 23 or 25 hours, and rounding that
 * back to a day is a trap the three hand-written copies of this each stepped
 * around slightly differently. The number of nights in a stay is
 * `daysBetween(day, end_day)`; the days in an inclusive range are one more.
 */
export function daysBetween(from: string, to: string): number {
	const at = (iso: string) => {
		const [y, m, d] = iso.split('-').map(Number);
		return Date.UTC(y, m - 1, d);
	};
	return Math.round((at(to) - at(from)) / 86400000);
}

/** The day a stay is checked out of, which is one day past its last night. */
export function stayEndOf(row: StayRange): string {
	return row.end_day ?? shiftDay(row.day, 1);
}

/**
 * Whether a stay is slept in on the night of `day`, as opposed to left that
 * morning. This is the reading the planner wants: the journey home ends at a
 * night, and nobody travels back to a room they have already checked out of.
 */
export function isNightOf(row: StayRange, day: string): boolean {
	return row.day <= day && day < stayEndOf(row);
}

/**
 * Whether a stay is drawn on `day`, which includes the morning of checkout.
 *
 * You are still in the room on the morning you leave, so the checkout day is a
 * day of the stay even though it is not a night of it. Ending the band the
 * evening before left the last morning looking like nobody had anywhere to
 * sleep, on the one day of a stay most likely to be read.
 */
export function isDayOf(row: StayRange, day: string): boolean {
	return row.day <= day && day <= stayEndOf(row);
}

/**
 * The stays a day should actually draw, given every stay that touches it.
 *
 * Because a checkout day is drawn, a night checked out of and a night checked
 * into can land on the same day. That is right when the group is changing
 * hotels and pure noise when it is not: two identical chips saying the same
 * room twice. So a checkout is dropped when the same people are booked back
 * into the same place that night.
 *
 * Input order is preserved rather than imposed. The two callers order their
 * bands differently on purpose (the server by the stay's own start day, the
 * client by the minute it is drawn at) and the ordering is not the rule that
 * was duplicated; this filter is.
 */
export function stayBand<T extends StayIdentity>(rows: readonly T[], day: string): T[] {
	const tonight = new Set(rows.filter((r) => isNightOf(r, day)).map(stayKey));
	return rows.filter((r) => isNightOf(r, day) || !tonight.has(stayKey(r)));
}

function stayKey(row: StayIdentity): string {
	const place = row.lodging_id ?? row.poi_id ?? `${row.title}|${row.lat}|${row.lng}`;
	return `${place}\u0000${[...row.people].sort().join(',')}`;
}

/**
 * The end of a day, in minutes from its own midnight.
 *
 * The board's last minute, and the ceiling a reflowed block is held under so a
 * suggestion cannot be pushed off the end of the day it is on. The same number
 * as `DAY_END_MIN` in `types.ts`, and defined as it so the two cannot drift;
 * both names stay exported because both have readers.
 */
export const MIDNIGHT_MIN = DAY_END_MIN;

/**
 * A stored event as the planner needs it, with "Everyone" put back.
 *
 * **An empty `people` list means everyone**, and it is stored as zero rows. A
 * copy of the roster written onto the event would start naming a group that is
 * no longer everyone the moment somebody joined, so the empty list is the only
 * form that survives a person joining later. "Nobody" is deliberately not
 * representable: an event nobody is at is not a thing the board can express,
 * and the empty list is already spoken for.
 *
 * `planLegs`, on the other side, reads a `people` list as exactly the set of
 * travellers, and an empty one as nobody. That is the right contract for pure
 * logic, which has no roster and cannot get one without doing I/O. So the
 * expansion has to happen in between, and this is the between. Passing the
 * stored form straight through puts every Everyone event on nobody's chain and
 * the day plans no journeys at all.
 *
 * It used to happen at each call site, which meant the rule was stated three
 * times: here, in the client's replan, and again in the client's wire types.
 * Three statements of one rule is two chances to disagree about what an empty
 * list means, and the disagreement is invisible until a day silently has no
 * travel on it.
 *
 * A named list is filtered to the roster on the way through. `event_people`
 * survives a membership being deleted, so somebody who has left can still be
 * named on an old event, and planning a journey for them would put a stranger
 * in a leg key. A list naming only people who have left therefore empties, and
 * empties to nobody rather than to everybody: somebody chose those names, and
 * the choice was not "the whole group". An empty roster expands to nobody too,
 * so a trip with no members plans nothing rather than throwing.
 */
export function toPlannerEvent(row: PlannableRow, roster: readonly string[]): PlannerEvent {
	const members = new Set(roster);
	return {
		id: row.id,
		type: row.type,
		startMin: row.start_min,
		endMin: row.end_min,
		// Free time is the one type that is deliberately nowhere. Blanking here
		// rather than refusing to store coordinates means a block can be switched
		// to free time and back without losing the place it was at.
		lat: isLocatedType(row.type) ? row.lat : null,
		lng: isLocatedType(row.type) ? row.lng : null,
		people: row.people.length ? row.people.filter((id) => members.has(id)) : [...roster]
	};
}

/** Everything a day needs before it can be planned. */
export interface DayRows<E extends PlannableRow, S extends PlannableStay> {
	day: string;
	/**
	 * The timed blocks on the day. Stays are not among them. A block that runs
	 * over several days is listed on each day it covers, as the board lists it.
	 */
	events: readonly E[];
	/** Last night's stays: where each group that slept somewhere starts. */
	incoming: readonly S[];
	/**
	 * The zone of a city id, from the trip's cities.
	 *
	 * Optional, and only ever consulted for a same-day journey that lands on
	 * another clock, whose part of the day is its real length rather than its
	 * two clock readings. Without it such a journey is planned as the shortest
	 * block, so both ends should pass it to agree about that one case.
	 */
	zoneOf?: ZoneOf;
}

/** A row's span fields, when the caller supplied them. */
function spanOf(row: PlannableRow): SpanRow | null {
	if (!row.day) return null;
	return {
		type: row.type,
		day: row.day,
		end_day: row.end_day ?? null,
		start_min: row.start_min,
		end_min: row.end_min,
		city_id: row.city_id ?? null,
		end_city_id: row.end_city_id ?? null
	};
}

/**
 * A row as it sits on `day`: its start and end replaced by that day's part of it.
 *
 * Everything that reads a day's minutes (the planner's order, a journey's
 * departure, the reflow's "after whatever comes before") wants this rather
 * than the stored pair, which for a block that runs over several days are two
 * readings on two different days. `segmentOn` decides the part; this only
 * writes it onto a copy. A row with no `day`, or one not on `day` at all, is
 * returned as it came.
 */
export function rowOnDay<T extends PlannableRow>(row: T, day: string, zoneOf?: ZoneOf): T {
	const span = spanOf(row);
	if (!span || row.type === 'stay') return row;
	const seg = segmentOn(span, day, zoneOf);
	if (!seg || (seg.start === row.start_min && seg.end === row.end_min)) return row;
	return { ...row, start_min: seg.start, end_min: seg.end };
}

/**
 * The journeys a day implies.
 *
 * Last night's lodging is the morning's origin, one per group that slept
 * somewhere of its own, so the first thing of the day carries the walk out of
 * the room it was slept in.
 *
 * Nothing is planned *to* a stay. A night is not an appointment: there is no
 * time to be late for, the group goes back when it goes back, and a board that
 * drew the way home put a journey on the day that nobody had to make. It also
 * read as the stay itself having a travel time, which is not a thing a stay
 * has. So a stay is an origin only, at both ends of the night: it starts the
 * morning and it ends nothing.
 *
 * The roster is applied to the day's blocks and to last night's origins alike.
 * An incoming stay carries people too, and a stay left on "Everyone" is where
 * the whole group wakes up.
 *
 * A block that runs over several days is planned by its part of this day: from
 * its start to midnight on its first, all day in between, and from midnight to
 * its end on its last. On its last day it is therefore the first thing its
 * people do, and the day goes on from it: a journey that lands is where the
 * next leg leaves from (the `landsAt` rule in `travel.ts`), and a two-day hike
 * is where the walk to dinner starts.
 *
 * The people on such a block when the day begins are not at last night's stay,
 * whoever booked them into one: they spent the night on the train. So they are
 * taken off this morning's origins, and a stay nobody is left on starts nothing.
 * Without that, the overnight train's last day opened with a walk from a hotel
 * its passengers never reached.
 */
export function planDay<E extends PlannableRow, S extends PlannableStay>(
	rows: DayRows<E, S>,
	roster: readonly string[]
): PlannedLeg[] {
	const events = rows.events.map((e) => toPlannerEvent(rowOnDay(e, rows.day, rows.zoneOf), roster));
	const aboard = new Set<string>();
	rows.events.forEach((e, i) => {
		const span = spanOf(e);
		if (span && carriesInto(span, rows.day)) for (const p of events[i].people) aboard.add(p);
	});
	const incoming = rows.incoming
		.map((s) => toPlannerEvent(s, roster))
		.map((o) => (aboard.size ? { ...o, people: o.people.filter((p) => !aboard.has(p)) } : o))
		.filter((o) => o.people.length > 0);
	return planLegs(events, incoming, dayInstants(rows));
}

/**
 * The order a day's blocks happen in, as instants, when the day is on two
 * clocks; undefined when it is on one, so the planner walks the clock minutes
 * exactly as it always has.
 *
 * A day with a journey between two clocks on it cannot be put in order by any
 * one clock. The board draws a same-day flight west on its arrival clock (see
 * `segmentOn`), which places it right against the afternoon in the city it
 * lands in, but the morning in the city it left is on the other clock: a
 * museum at 12:00 in Tokyo before a 17:00 flight that lands in Los Angeles at
 * 11:00 drew at 12:00, after the flight's 01:00 to 11:00, and the planner
 * walking those minutes planned a journey from the airport back to the museum.
 * So on such a day each block is placed by when it really starts: a block
 * starting on the day at its start, read in its own city's zone (for the
 * flight, its departure); a block carried in from yesterday at this day's
 * midnight on the clock it is drawn on (a journey's arrival clock). Ties fall
 * back to the id, as on any day. A block's city is only as good as the row's
 * `city_id`: the server stores a linked place's own city for anything but a
 * journey, and the day's city for a block with no saved place, which on such
 * a day is the departure city (DESIGN 5.0.15, "A journey between two clocks").
 *
 * Only a day that has such a journey is ordered this way. A day on one clock
 * keeps the minute order even where its blocks name different cities: rows
 * created before the start city was the day's city carry the trip's first
 * city, and reading each in its own zone would scramble a day that reads
 * correctly on the board.
 */
function dayInstants<E extends PlannableRow, S extends PlannableStay>(
	rows: DayRows<E, S>
): Map<string, number> | undefined {
	const zoneOf = rows.zoneOf;
	if (!zoneOf) return undefined;
	const spans = rows.events.map(spanOf);
	if (!spans.some((s) => s && crossesZones(s, zoneOf))) return undefined;
	return new Map(
		rows.events.map((e, i): [string, number] => {
			const span = spans[i];
			if (!span) return [e.id, zonedMinutesToUtc(rows.day, e.start_min, zoneOf(e.city_id))];
			if (span.day >= rows.day) {
				return [e.id, zonedMinutesToUtc(span.day, span.start_min, zoneOf(span.city_id))];
			}
			const drawnIn = span.type === 'travel' && span.end_city_id ? span.end_city_id : span.city_id;
			return [e.id, zonedMinutesToUtc(rows.day, 0, zoneOf(drawnIn))];
		})
	);
}

/**
 * The clock-time snap the board works in, shared with the server's `SNAP`.
 *
 * A suggested start that landed on 10:37 would be a time nobody chose and
 * nobody can drag back to, so a reflowed block rounds up to the same five
 * minutes a drag snaps to. Up rather than to-nearest, because rounding down
 * would suggest leaving before the journey finishes.
 */
export const SUGGEST_SNAP = 5;

/** A stored event plus whether its time is still the board's suggestion. */
export interface AutoTimedRow extends PlannableRow {
	/**
	 * True while nobody has chosen this block's start.
	 *
	 * Set when a block is added without pointing at a time, and cleared the
	 * first time somebody drags it or types a start. It is the difference
	 * between "put this after whatever comes before it" and "this is at 14:00",
	 * and only the first of those should move when the day changes around it.
	 */
	time_auto: boolean;
}

/** A block that the reflow moved, and where it moved it to. */
export interface ReflowedTime {
	id: string;
	startMin: number;
	endMin: number;
}

/**
 * Re-place the blocks whose start is still a suggestion.
 *
 * Adding an event, or lengthening one, used to leave everything after it
 * exactly where it was, so a day built by accepting the suggested times drifted
 * out of order the moment anything before it changed: a museum added at 10:00
 * left lunch at 12:00 even after the museum was stretched to 15:00.
 *
 * A block follows the journey that arrives at it, which is already planned and
 * already carries a duration, so the suggestion is simply "leave when you get
 * there": the end of whatever comes before, plus the travel between them. Where
 * several journeys arrive (the group rejoining) the latest one wins, because
 * the block cannot start before everybody is there.
 *
 * Only `time_auto` blocks move, and they keep their length: the reflow is about
 * where a block sits, never how long it lasts. Blocks are walked in clock order
 * so a run of suggested blocks cascades in one pass, each one following the
 * block this pass has just placed.
 *
 * A block with no incoming journey follows the end of whatever each of its
 * people was doing just before it, with no travel added. That covers the two
 * ways a chain can have a predecessor and still plan no journey: the block
 * before is at the same place (inside `SAME_PLACE_KM`), or it says nowhere at
 * all (free time, or a block with no location), which breaks the travel chain
 * but still ends at a time. Leaving such a block where it was made a day of
 * accepted suggestions drift out of order as soon as it contained either.
 *
 * The first thing of the morning still stays where it is: its only origin is
 * last night's stay, which is not a block on this day and has no end to follow,
 * so it is where the day starts rather than where the day has got to.
 *
 * "Its people" needs Everyone put back, so `roster` is the trip's members, the
 * same list `planDay` takes. Without one, everybody named anywhere on the day
 * plus a single stand-in for everybody else gives the same chains, because an
 * Everyone block is on all of them and a named block only on its names.
 *
 * Pure, and returns only what changed, so the server can write the moves and
 * the client can preview them without either owning the rule.
 *
 * `on` names the day being reflowed. With it, every row is read as its part of
 * that day (`rowOnDay`), so a block carried in from yesterday is "before"
 * everything and ends where it ends today rather than where its stored pair
 * says. A block that runs over several days, or lands on another clock, is
 * never moved, whatever its flag says: its start is a ticket, not a
 * suggestion, and the one-day arithmetic below has no meaning for it. Without
 * `on`, rows are read as stored, which is what every caller before spans did.
 */
export function reflowAutoTimes(
	events: readonly AutoTimedRow[],
	legs: readonly { toEventId: string; fromEventId: string; resolvedMins: number }[],
	roster?: readonly string[],
	on?: { day: string; zoneOf?: ZoneOf }
): ReflowedTime[] {
	const fixed = new Set(
		events
			.filter((e) => {
				const span = spanOf(e);
				return span !== null && !onOneClock(span, on?.zoneOf);
			})
			.map((e) => e.id)
	);
	const rows = on ? events.map((e) => rowOnDay(e, on.day, on.zoneOf)) : events;
	const now = new Map(rows.map((e) => [e.id, { start: e.start_min, end: e.end_min }]));
	const arriving = new Map<string, typeof legs>();
	const legMins = new Map<string, number>();
	for (const leg of legs) {
		arriving.set(leg.toEventId, [...(arriving.get(leg.toEventId) ?? []), leg]);
		legMins.set(legKey(leg.fromEventId, leg.toEventId), leg.resolvedMins);
	}

	const members = roster ?? [...new Set(events.flatMap((e) => e.people)), EVERYONE_ELSE];
	/** The person's latest block so far in the walk, which is what they are coming from. */
	const lastOf = new Map<string, string>();

	const moved: ReflowedTime[] = [];
	const order = [...rows].sort((a, b) => a.start_min - b.start_min || (a.id < b.id ? -1 : 1));
	for (const e of order) {
		const people = toPlannerEvent(e, members).people;
		if (e.time_auto && !fixed.has(e.id)) {
			let earliest = -1;
			for (const leg of arriving.get(e.id) ?? []) {
				// An origin that is not on the day's clock is last night's stay, which
				// has no end time to leave from.
				const from = now.get(leg.fromEventId);
				if (!from) continue;
				earliest = Math.max(earliest, from.end + leg.resolvedMins);
			}
			for (const person of people) {
				const prevId = lastOf.get(person);
				if (!prevId) continue;
				const prev = now.get(prevId)!;
				// A planned journey from that block has already been counted above;
				// with none, the same place or an unknown one both mean no travel.
				earliest = Math.max(earliest, prev.end + (legMins.get(legKey(prevId, e.id)) ?? 0));
			}
			if (earliest >= 0) {
				const at = now.get(e.id)!;
				const length = at.end - at.start;
				const start = Math.max(
					0,
					Math.min(Math.ceil(earliest / SUGGEST_SNAP) * SUGGEST_SNAP, MIDNIGHT_MIN - length)
				);
				if (start !== at.start) {
					at.start = start;
					at.end = start + length;
					moved.push({ id: e.id, startMin: at.start, endMin: at.end });
				}
			}
		}
		for (const person of people) lastOf.set(person, e.id);
	}
	return moved;
}

/** The roster stand-in `reflowAutoTimes` uses for everybody nobody named. */
const EVERYONE_ELSE = '\u0000everyone-else';

/**
 * What a block added without pointing at a time should start at.
 *
 * The old default was 09:00 whatever else the day held, so adding a third thing
 * to an afternoon put it back in the morning underneath the first two. The
 * honest suggestion is the end of the day so far, and 09:00 survives only as
 * the answer for a day with nothing on it yet.
 *
 * Travel is deliberately not added here. The client does not know what the
 * journey to a place costs until a place has been picked, and the server
 * reflows the block the moment it is saved, so guessing a gap now would only
 * show a number that is about to be replaced by a real one.
 */
export const DAY_START_MIN = 9 * 60;

/**
 * `day` is the day the block is being added to. With it, each row is read as
 * its part of that day (`rowOnDay`), so a block that runs on past midnight
 * counts as filling the day to its end, and one carried in from yesterday
 * counts only up to where it stops today. Without it rows are read as stored,
 * which is right for a day of one-day blocks and what every caller did before.
 */
export function suggestStart(
	events: readonly PlannableRow[],
	day?: string,
	zoneOf?: ZoneOf
): number {
	const end = events.reduce(
		(last, e) => Math.max(last, (day ? rowOnDay(e, day, zoneOf) : e).end_min),
		-1
	);
	return end < 0 ? DAY_START_MIN : Math.min(end, MIDNIGHT_MIN - SUGGEST_SNAP);
}

/**
 * What a stored leg row contributes to a planned journey.
 *
 * Camel-cased, unlike the event rows above, because this is not a column list:
 * the server's row is `auto_mode` / `auto_mins` and the client's is already
 * `autoMode` / `autoMins`, so neither shape is the shared one and the shared
 * one may as well read the way the answer does.
 */
export interface LegOverride {
	/** What somebody called this journey. Null means the board names it. */
	title: string | null;
	/** What the routing provider said. Null until it has answered once. */
	autoMode: string | null;
	autoMins: number | null;
	/** What a person pinned by hand, which wins when set. */
	mode: string | null;
	mins: number | null;
}

/** A planned journey with its duration settled and its place on the clock. */
export interface ResolvedLeg extends LegOverride, PlacedLeg {
	key: string;
	fromEventId: string;
	toEventId: string;
	people: string[];
	resolvedMode: string;
	resolvedMins: number;
	/** Straight-line distance, which is what a re-estimate for another mode uses. */
	km: number;
	manual: boolean;
}

/**
 * The routing ladder, applied to one leg, and the leg placed on the clock.
 *
 * In order: what a person pinned, then what the provider said, then the
 * straight-line guess. A leg with no stored row at all (a journey that only an
 * unsaved edit implies) resolves to the guess, which is exactly what it will
 * get from the server a moment after the edit is saved.
 *
 * Both ends ran this ladder themselves. It is four `??` and a `Math.max`, which
 * is precisely the size of thing that gets copied and then corrected on one
 * side only, and the symptom of correcting one side is a pinned ferry time that
 * the dialog honours and the board does not.
 */
export function resolveLeg(leg: PlannedLeg, stored: LegOverride | null | undefined): ResolvedLeg {
	const guess = guessLeg(leg.km);
	const resolvedMode = stored?.mode ?? stored?.autoMode ?? guess.mode;
	const resolvedMins = stored?.mins ?? stored?.autoMins ?? guess.mins;
	return {
		key: leg.key,
		fromEventId: leg.fromEventId,
		toEventId: leg.toEventId,
		people: leg.people,
		title: stored?.title ?? null,
		autoMode: stored?.autoMode ?? null,
		autoMins: stored?.autoMins ?? null,
		mode: stored?.mode ?? null,
		mins: stored?.mins ?? null,
		resolvedMode,
		resolvedMins,
		km: leg.km,
		manual: stored?.mode != null || stored?.mins != null,
		...placeLeg(leg, resolvedMins)
	};
}
