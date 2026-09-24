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
 * All four are here now, and the two call sites are two calls.
 *
 * Nothing here does I/O. It takes rows and a roster as arguments, which is what
 * lets the same code run in the API process and in a browser.
 */

import { isLocatedType, type EventType } from './types';
import {
	guessLeg,
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
export interface PlannableStay extends PlannableRow, StayRange {}

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
 * suggestion cannot be pushed off the end of the day it is on.
 */
export const MIDNIGHT_MIN = 24 * 60;

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
	/** The day's timed blocks. Stays are not among them. */
	events: readonly E[];
	/** Last night's stays: where each group that slept somewhere starts. */
	incoming: readonly S[];
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
 */
export function planDay<E extends PlannableRow, S extends PlannableStay>(
	rows: DayRows<E, S>,
	roster: readonly string[]
): PlannedLeg[] {
	return planLegs(
		rows.events.map((e) => toPlannerEvent(e, roster)),
		rows.incoming.map((s) => toPlannerEvent(s, roster))
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
 * A block with no incoming journey is left alone. That is the first thing of
 * the morning, whose origin is last night's stay and which therefore has
 * nothing to be "after": it is where the day starts rather than where the day
 * has got to.
 *
 * Pure, and returns only what changed, so the server can write the moves and
 * the client can preview them without either owning the rule.
 */
export function reflowAutoTimes(
	events: readonly AutoTimedRow[],
	legs: readonly { toEventId: string; fromEventId: string; resolvedMins: number }[]
): ReflowedTime[] {
	const now = new Map(events.map((e) => [e.id, { start: e.start_min, end: e.end_min }]));
	const arriving = new Map<string, typeof legs>();
	for (const leg of legs) {
		arriving.set(leg.toEventId, [...(arriving.get(leg.toEventId) ?? []), leg]);
	}

	const moved: ReflowedTime[] = [];
	const order = [...events].sort((a, b) => a.start_min - b.start_min || (a.id < b.id ? -1 : 1));
	for (const e of order) {
		if (!e.time_auto) continue;
		let earliest = -1;
		for (const leg of arriving.get(e.id) ?? []) {
			// An origin that is not on the day's clock is last night's stay, which
			// has no end time to leave from.
			const from = now.get(leg.fromEventId);
			if (!from) continue;
			earliest = Math.max(earliest, from.end + leg.resolvedMins);
		}
		if (earliest < 0) continue;

		const at = now.get(e.id)!;
		const length = at.end - at.start;
		const start = Math.max(
			0,
			Math.min(Math.ceil(earliest / SUGGEST_SNAP) * SUGGEST_SNAP, MIDNIGHT_MIN - length)
		);
		if (start === at.start) continue;
		at.start = start;
		at.end = start + length;
		moved.push({ id: e.id, startMin: at.start, endMin: at.end });
	}
	return moved;
}

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

export function suggestStart(events: readonly PlannableRow[]): number {
	const end = events.reduce((last, e) => Math.max(last, e.end_min), -1);
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
