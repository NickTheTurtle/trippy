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
 * The minute a stay enters the plan at, as a destination.
 *
 * Midnight rather than a check-in hour: a stay is not on the clock, and nobody
 * can be late to their own bed, so the honest statement is that the journey
 * home leaves when the day finishes. It is the mirror of the morning, where
 * last night's stay is an origin at midnight for the same reason.
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
	/**
	 * Every stay touching the day, the morning of checkout included. Only the
	 * ones that are a night of the day become destinations, so a caller may pass
	 * the band it draws without filtering it first.
	 */
	stays: readonly S[];
	/** Last night's stays: where each group that slept somewhere starts. */
	incoming: readonly S[];
}

/**
 * The journeys a day implies.
 *
 * Tonight's lodging is the last thing reached and last night's is the morning's
 * origin, one per group that slept somewhere of its own. A stay being checked
 * out of this morning is drawn on the day but is not a night of it, so it is an
 * origin only: nobody travels back to a room they have left.
 *
 * The roster is applied to the day's blocks, tonight's stays and last night's
 * origins alike. An incoming stay carries people too, and a stay left on
 * "Everyone" is where the whole group wakes up.
 */
export function planDay<E extends PlannableRow, S extends PlannableStay>(
	rows: DayRows<E, S>,
	roster: readonly string[]
): PlannedLeg[] {
	const tonight = rows.stays
		.filter((s) => isNightOf(s, rows.day))
		.map((s) => ({
			...toPlannerEvent(s, roster),
			startMin: MIDNIGHT_MIN,
			endMin: MIDNIGHT_MIN
		}));
	return planLegs(
		[...rows.events.map((e) => toPlannerEvent(e, roster)), ...tonight],
		rows.incoming.map((s) => toPlannerEvent(s, roster))
	);
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
