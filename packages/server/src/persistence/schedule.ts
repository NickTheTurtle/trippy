import { randomUUID } from 'node:crypto';
import { db, backfillDone, markBackfillDone } from '../db';
import { isEventType, isLocatedType, isTransportMode, type EventType } from '@trippy/core/types';
import {
	guessLeg,
	planLegs,
	placeLeg,
	type PlannedLeg,
	type PlannerEvent
} from '@trippy/core/travel';
import { publish, publishMany } from '../events';
import { isMember } from './membership';
import { conflict, isStale, missing, written, type WriteResult } from './versioning';

/**
 * The schedule, as events with people on them.
 *
 * Read `packages/core/src/travel.ts` first: it holds the reasoning for why
 * travel is derived from who is at which event rather than from a lane someone
 * drew. This module is the part that has to persist the answer.
 *
 * The awkward requirement is that travel is BOTH derived and editable. It has
 * to be derived, or the organizer maintains it by hand for a group that keeps
 * splitting; it has to be editable, because a routing provider does not know
 * that this particular ferry runs twice a day. So legs are stored, and every
 * write to an event reconciles the stored set against the plan:
 *
 * - a leg the plan still calls for keeps its row, and so keeps any override
 * - a leg the plan no longer calls for is deleted
 * - a leg the plan has newly called for is inserted with no override
 *
 * Matching is on `leg_key`, which is the pair of events plus the sorted people
 * (see `planLegs`). That is what makes an override survive an unrelated edit:
 * dragging an event by ten minutes does not change who is going where, so the
 * key is unchanged and the ferry time someone typed is still there afterwards.
 */

/** Drag/resize snap granularity, in minutes. */
const SNAP = 5;

/** The shortest event the grid can draw with its title. */
export { MIN_EVENT_MINS } from '@trippy/core/types';
import { MIN_EVENT_MINS } from '@trippy/core/types';

/** Where a stay sits on the clock. In core, so the client anchors it the same. */
export { STAY_CHECK_IN } from '@trippy/core/types';

export interface EventRow {
	id: string;
	day: string;
	/** Checkout morning for a stay, exclusive. Null for a block on one day. */
	end_day: string | null;
	title: string;
	type: EventType;
	start_min: number;
	end_min: number;
	poi_id: string | null;
	lodging_id: string | null;
	city_id: string | null;
	lat: number | null;
	lng: number | null;
	notes: string | null;
	travel_mode: string | null;
	people: string[];
	/** Bumped by every edit. Send it back with a PUT to detect a lost update. */
	version: number;
}

export interface LegRow {
	id: string;
	day: string;
	key: string;
	fromEventId: string;
	toEventId: string;
	people: string[];
	/** The name somebody gave this journey, or null for the automatic one. */
	title: string | null;
	/** What the provider said. Null until the first successful lookup. */
	autoMode: string | null;
	autoMins: number | null;
	/** What the user said, which wins when set. */
	mode: string | null;
	mins: number | null;
	/** The two above, resolved. */
	resolvedMode: string;
	resolvedMins: number;
	/** Straight-line distance, so a client can re-estimate for another mode. */
	km: number;
	manual: boolean;
	startMin: number;
	endMin: number;
	tight: boolean;
}

/** Shift an ISO day, staying in UTC so a DST boundary cannot move it. */
export function shiftDay(iso: string, delta: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

const EVENT_COLUMNS = `id, day, end_day, title, type, start_min, end_min, poi_id, lodging_id, city_id, lat, lng, notes, travel_mode, version`;

function attachPeople(rows: EventRow[]): EventRow[] {
	const stmt = db.prepare(`SELECT user_id FROM event_people WHERE event_id = ?`);
	for (const r of rows) {
		r.people = (stmt.all(r.id) as unknown as { user_id: string }[]).map((x) => x.user_id);
	}
	return rows;
}

/**
 * The timed blocks on a day, earliest first, each with its people.
 *
 * Stays are not among them. A stay runs over nights rather than sitting on a
 * clock, so the board draws it as a band above the day rather than as a block
 * inside it, and `staysOnBoard` is what answers for it.
 */
export function eventsForDay(tripId: string, day: string): EventRow[] {
	const rows = db
		.prepare(
			`SELECT ${EVENT_COLUMNS} FROM events
			 WHERE trip_id = ? AND day = ? AND type != 'stay' ORDER BY start_min, id`
		)
		.all(tripId, day) as unknown as EventRow[];
	return attachPeople(rows);
}

/**
 * Where people sleep on the night of `day`, and who is in each.
 *
 * Nights, not days: a stay covers `[day, end_day)`, checked into on its own day
 * and out of on `end_day`, so the last night it covers is the day before
 * checkout. That is the reading `lodging_options.check_in/check_out` has always
 * had, and it is the one the planner wants, because the night is what a journey
 * home ends at.
 *
 * `staysOnBoard` is the wider answer, for what the board draws.
 *
 * Several, because half a group can be in one building and half in another.
 * Ordered so the answer is stable across runs.
 */
export function staysCovering(tripId: string, day: string): EventRow[] {
	const rows = db
		.prepare(
			`SELECT ${EVENT_COLUMNS} FROM events
			 WHERE trip_id = ? AND type = 'stay'
			   AND day <= ? AND ? < COALESCE(end_day, date(day, '+1 day'))
			 ORDER BY day, start_min, id`
		)
		.all(tripId, day, day) as unknown as EventRow[];
	return attachPeople(rows);
}

/**
 * The stays the board shows on `day`, which includes the day of checkout.
 *
 * You are still in the room on the morning you leave, so the checkout day is a
 * day of the stay even though it is not a night of it. Ending the band the
 * evening before left the last morning looking like nobody had anywhere to
 * sleep, on the one day of the stay most likely to be read.
 *
 * Hence two questions and two answers: `staysCovering` for the nights, which is
 * what the planner books journeys against, and this for the days, which is what
 * is drawn.
 *
 * A night checked out of and a night checked into can now land on the same day,
 * which is right when the group is changing hotels and pure noise when it is
 * not: two identical chips saying the same room twice. So a checkout is dropped
 * when the same people are booked back into the same place that night.
 */
export function staysOnBoard(tripId: string, day: string): EventRow[] {
	const rows = db
		.prepare(
			`SELECT ${EVENT_COLUMNS} FROM events
			 WHERE trip_id = ? AND type = 'stay'
			   AND day <= ? AND ? <= COALESCE(end_day, date(day, '+1 day'))
			 ORDER BY day, start_min, id`
		)
		.all(tripId, day, day) as unknown as EventRow[];
	attachPeople(rows);
	const tonight = new Set(rows.filter((r) => !leavesOn(r, day)).map(stayKey));
	return rows.filter((r) => !leavesOn(r, day) || !tonight.has(stayKey(r)));
}

function leavesOn(row: EventRow, day: string): boolean {
	return (row.end_day ?? shiftDay(row.day, 1)) === day;
}

/** What makes two stays the same booking: the same room, held by the same people. */
function stayKey(row: EventRow): string {
	const place = row.lodging_id ?? row.poi_id ?? `${row.title}|${row.lat}|${row.lng}`;
	return `${place}\u0000${[...row.people].sort().join(',')}`;
}

/**
 * Last night's lodging, which is where the morning starts.
 *
 * Not part of the day it is read for: the only thing this day does with it is
 * plan the first journey out of it, one per group that slept somewhere of its
 * own. The board never draws it on this day.
 */
export function incomingStays(tripId: string, day: string): EventRow[] {
	return staysCovering(tripId, shiftDay(day, -1));
}

/** Distinct days carrying anything, ordered. */
export function scheduleDays(tripId: string): string[] {
	const rows = db
		.prepare(`SELECT DISTINCT day FROM events WHERE trip_id = ? ORDER BY day`)
		.all(tripId) as unknown as { day: string }[];
	return rows.map((r) => r.day);
}

/*
 * --- Where the schedule reaches, without listing it ------------------------
 *
 * `scheduleDays` materialises every day that carries something, which is fine
 * for a trip with events on twenty days and useless as a way to answer "how far
 * does this trip reach" or "what is the next day I can step to". A two-year
 * trip has no more rows than a weekend one, but the caller that needed the
 * edges used to walk the calendar to find them, and a walk needs a stopping
 * rule that is always wrong at some trip length.
 *
 * These four answer the same questions in SQL, in constant time, so the reach
 * of a trip no longer depends on anything being listed first.
 */

/** Whether anything starts on `day`. The cheap form of `scheduleDays().includes`. */
export function dayHasEvents(tripId: string, day: string): boolean {
	const row = db
		.prepare(`SELECT 1 AS hit FROM events WHERE trip_id = ? AND day = ? LIMIT 1`)
		.get(tripId, day) as unknown as { hit: number } | undefined;
	return row !== undefined;
}

/** Earliest and latest day carrying anything, or nulls for an empty schedule. */
export function scheduledDayEdges(tripId: string): { first: string | null; last: string | null } {
	const row = db
		.prepare(`SELECT MIN(day) AS first, MAX(day) AS last FROM events WHERE trip_id = ?`)
		.get(tripId) as unknown as { first: string | null; last: string | null } | undefined;
	return { first: row?.first ?? null, last: row?.last ?? null };
}

/** The nearest day before `day` that carries something, or null. */
export function scheduledDayBefore(tripId: string, day: string): string | null {
	const row = db
		.prepare(`SELECT MAX(day) AS d FROM events WHERE trip_id = ? AND day < ?`)
		.get(tripId, day) as unknown as { d: string | null } | undefined;
	return row?.d ?? null;
}

/** The nearest day after `day` that carries something, or null. */
export function scheduledDayAfter(tripId: string, day: string): string | null {
	const row = db
		.prepare(`SELECT MIN(day) AS d FROM events WHERE trip_id = ? AND day > ?`)
		.get(tripId, day) as unknown as { d: string | null } | undefined;
	return row?.d ?? null;
}

/**
 * How many days carry something outside `[start, end]`.
 *
 * The count of days a trip offers is the length of its own range plus these:
 * the days inside the range are already offered whether or not anything is on
 * them, so only the stranded ones add to the total. Counted rather than listed
 * so the total costs the same on a trip of any length.
 */
export function strandedDayCount(tripId: string, start: string, end: string): number {
	const row = db
		.prepare(
			`SELECT COUNT(DISTINCT day) AS n FROM events
			 WHERE trip_id = ? AND (day < ? OR day > ?)`
		)
		.get(tripId, start, end) as unknown as { n: number } | undefined;
	return row?.n ?? 0;
}

/**
 * The trip's roster, sorted, which is what "Everyone" means at this instant.
 *
 * Read on every plan rather than copied onto an event, for the same reason the
 * `everyone` crew is derived rather than stored: a copy starts naming a group
 * that is no longer everyone the moment somebody joins or leaves.
 */
function tripRoster(tripId: string): string[] {
	const rows = db
		.prepare(`SELECT user_id FROM memberships WHERE trip_id = ? ORDER BY user_id`)
		.all(tripId) as unknown as { user_id: string }[];
	return rows.map((r) => r.user_id);
}

/**
 * An event as the planner needs it, with "Everyone" put back.
 *
 * The board stores an event assigned to the whole group as no rows at all in
 * `event_people`, because that is the only form that survives somebody joining.
 * `planLegs` reads a `people` list as the exact set of travellers and an empty
 * one as nobody, so the expansion has to happen somewhere, and this is the only
 * layer that can do it: core is pure and has no way to look a roster up.
 *
 * Doing it here rather than passing the roster into `planLegs` keeps a trip
 * concept out of pure logic. The planner never learns what a trip is; it is
 * handed a set of ids and answers about those ids. The alternative, a roster
 * parameter, would put the "empty means everyone" rule in one place, but that
 * place would be the one module that must stay portable and I/O-free, and it
 * would still leave every other caller of `PlannerEvent` free to disagree.
 *
 * A named list is filtered to the roster on the way through. `event_people`
 * survives a membership being deleted, so a person who has left can still be
 * named on an old event, and planning a journey for somebody who is no longer
 * on the trip puts a stranger in a leg key. A list that names only people who
 * have left therefore empties, and empties to nobody rather than to everybody:
 * somebody chose those names, and the choice was not "the whole group".
 */
function toPlanner(e: EventRow, roster: readonly string[]): PlannerEvent {
	const members = new Set(roster);
	return {
		id: e.id,
		type: e.type,
		startMin: e.start_min,
		endMin: e.end_min,
		// Free time is the one type that is deliberately nowhere. Blanking here
		// rather than refusing to store coordinates means a block can be switched
		// to free time and back without losing the place it was at.
		lat: isLocatedType(e.type) ? e.lat : null,
		lng: isLocatedType(e.type) ? e.lng : null,
		people: e.people.length ? e.people.filter((id) => members.has(id)) : [...roster]
	};
}

/**
 * The day's plan: its blocks, tonight's lodging as the last thing reached, and
 * last night's as the morning's origin.
 *
 * A stay is not on the clock, but a journey to it is a real journey, so it
 * enters the plan as the end of the day. Midnight rather than a check-in hour:
 * it is the mirror of the morning, where last night's stay is an origin at
 * midnight, and `placeLeg` reads it as an arrival with no time to be late for.
 *
 * The roster is read once and applied to blocks, tonight's stays and last
 * night's alike: an incoming stay carries people too, and a stay left on
 * "Everyone" is where the whole group wakes up.
 */
function planFor(tripId: string, day: string): PlannedLeg[] {
	const roster = tripRoster(tripId);
	const events = eventsForDay(tripId, day).map((e) => toPlanner(e, roster));
	const tonight = staysCovering(tripId, day).map((s) => ({
		...toPlanner(s, roster),
		startMin: 24 * 60,
		endMin: 24 * 60
	}));
	return planLegs(
		[...events, ...tonight],
		incomingStays(tripId, day).map((s) => toPlanner(s, roster))
	);
}

/**
 * Reconcile the stored legs for a day against what the events now imply.
 *
 * Called after every event write. Cheap enough to run unconditionally: it is
 * one plan over one day's events and a handful of statements. Working out
 * whether a given edit could possibly have changed the plan is both harder to
 * get right and easy to get subtly wrong in the direction of stale travel.
 */
export function recomputeLegs(tripId: string, day: string): void {
	const planned = planFor(tripId, day);

	const existing = db
		.prepare(`SELECT id, leg_key FROM travel_legs WHERE trip_id = ? AND day = ?`)
		.all(tripId, day) as unknown as { id: string; leg_key: string }[];
	const have = new Map(existing.map((r) => [r.leg_key, r.id]));

	const ins = db.prepare(
		`INSERT INTO travel_legs (id, trip_id, day, leg_key, from_event_id, to_event_id, people)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	);
	const del = db.prepare(`DELETE FROM travel_legs WHERE id = ?`);

	for (const leg of planned) {
		if (have.has(leg.key)) {
			have.delete(leg.key);
			continue;
		}
		ins.run(
			randomUUID(),
			tripId,
			day,
			leg.key,
			leg.fromEventId,
			leg.toEventId,
			leg.people.join(',')
		);
	}
	// Whatever is left was planned once and is not any more.
	for (const id of have.values()) del.run(id);
}

/**
 * Reconcile every day of every trip that carries an event.
 *
 * Reconciliation is otherwise only triggered by a write, which is exactly right
 * while the rules do not move: a day nobody has touched still implies the legs
 * that are stored for it. When the rules do move, every stored day is suddenly
 * a day whose plan changed with no write to notice, and `legsForDay` shows only
 * legs that have a row, so an untouched day would draw no travel until somebody
 * happened to drag something on it.
 *
 * It is the ordinary per-day reconciliation run over the whole database, so it
 * inserts what is newly planned, prunes what is no longer planned, and leaves
 * every row whose key still stands, overrides and all. Nothing is dropped and
 * no table is rebuilt.
 *
 * Returns the number of (trip, day) pairs it visited, which is what the caller
 * logs or a test asserts on.
 */
export function reconcileAllLegs(): number {
	const rows = db
		.prepare(`SELECT DISTINCT trip_id, day FROM events ORDER BY trip_id, day`)
		.all() as unknown as { trip_id: string; day: string }[];
	// The morning after a stay leaves it, so the day after one carrying events
	// can have legs of its own even with nothing scheduled on it.
	const pairs = new Set<string>();
	for (const r of rows) {
		pairs.add(`${r.trip_id}\u0000${r.day}`);
		pairs.add(`${r.trip_id}\u0000${shiftDay(r.day, 1)}`);
	}
	for (const pair of pairs) {
		const [tripId, day] = pair.split('\u0000');
		recomputeLegs(tripId, day);
	}
	return pairs.size;
}

/**
 * The one-time pass for the rule change that made "Everyone" expand.
 *
 * Before it, an event left on the whole group named nobody, so it was on
 * nobody's chain and a trip whose events were all left on the default planned
 * no journeys at all. Every day stored under the old rules therefore has legs
 * missing, and days with a location-less block in them have legs that were
 * planned straight across it and are no longer planned at all.
 *
 * Guarded by a marker row rather than run on every boot: the work is a plan per
 * stored day, which is cheap once and pointless forever after.
 */
const LEGS_BACKFILL = 'travel-legs-everyone-expansion';
if (!backfillDone(LEGS_BACKFILL)) {
	reconcileAllLegs();
	markBackfillDone(LEGS_BACKFILL);
}

/** The straight-line guess, used until a provider has said better. */
function fallbackEstimate(leg: PlannedLeg): { mode: string; mins: number } {
	return guessLeg(leg.km);
}

/**
 * A day's legs, placed on the clock.
 *
 * The plan is recomputed rather than read back structurally, because placement
 * needs the event times and those are here anyway; the stored row contributes
 * only the identity and the override. A leg with no duration yet (never routed,
 * never overridden) falls back to the straight-line estimate, so the day is
 * never drawn with a gap where a journey should be.
 */
export function legsForDay(tripId: string, day: string): LegRow[] {
	const planned = planFor(tripId, day);
	if (!planned.length) return [];

	const rows = db
		.prepare(
			`SELECT id, leg_key, title, auto_mode, auto_mins, mode, mins FROM travel_legs
			 WHERE trip_id = ? AND day = ?`
		)
		.all(tripId, day) as unknown as {
		id: string;
		leg_key: string;
		title: string | null;
		auto_mode: string | null;
		auto_mins: number | null;
		mode: string | null;
		mins: number | null;
	}[];
	const stored = new Map(rows.map((r) => [r.leg_key, r]));

	const out: LegRow[] = [];
	for (const leg of planned) {
		const row = stored.get(leg.key);
		// A plan that has not been reconciled yet (a read racing a write) simply
		// shows one fewer journey rather than inventing a row id the client would
		// then try to edit.
		if (!row) continue;
		const fallback = fallbackEstimate(leg);
		const resolvedMode = row.mode ?? row.auto_mode ?? fallback.mode;
		const resolvedMins = row.mins ?? row.auto_mins ?? fallback.mins;
		out.push({
			id: row.id,
			day,
			key: leg.key,
			fromEventId: leg.fromEventId,
			toEventId: leg.toEventId,
			people: leg.people,
			title: row.title,
			autoMode: row.auto_mode,
			autoMins: row.auto_mins,
			mode: row.mode,
			mins: row.mins,
			resolvedMode,
			resolvedMins,
			km: leg.km,
			manual: row.mode != null || row.mins != null,
			...placeLeg(leg, resolvedMins)
		});
	}
	return out;
}

/** The planned legs of a day, for a caller that wants to route them. */
export function plannedLegsForDay(tripId: string, day: string): PlannedLeg[] {
	return planFor(tripId, day);
}

/** Record what the routing provider said. Never touches a user's own override. */
export function saveAutoLeg(
	tripId: string,
	day: string,
	legKey: string,
	mode: string,
	mins: number
): void {
	db.prepare(
		`UPDATE travel_legs SET auto_mode = ?, auto_mins = ? WHERE trip_id = ? AND day = ? AND leg_key = ?`
	).run(mode, Math.max(1, Math.round(mins)), tripId, day, legKey);
}

// --- Events -----------------------------------------------------------------

export interface NewEvent {
	day: string;
	/** Checkout morning, for a stay. Ignored for anything else. */
	endDay?: string | null;
	title: string;
	type: EventType;
	startMin: number;
	endMin: number;
	poiId?: string | null;
	lodgingId?: string | null;
	cityId?: string | null;
	lat?: number | null;
	lng?: number | null;
	notes?: string | null;
	travelMode?: string | null;
	people?: string[];
}

/** Members of the trip, used to validate who an event can be assigned to. */
function tripMemberIds(tripId: string): Set<string> {
	return new Set(tripRoster(tripId));
}

function writePeople(eventId: string, tripId: string, userIds: string[]): void {
	const members = tripMemberIds(tripId);
	const clean = [...new Set(userIds)].filter((id) => members.has(id));
	db.prepare(`DELETE FROM event_people WHERE event_id = ?`).run(eventId);
	const ins = db.prepare(`INSERT INTO event_people (event_id, user_id) VALUES (?, ?)`);
	for (const id of clean) ins.run(eventId, id);
}

/** The trip that owns an event, or null. */
export function eventTrip(eventId: string): string | null {
	if (!eventId) return null;
	const row = db.prepare(`SELECT trip_id FROM events WHERE id = ?`).get(eventId) as
		{ trip_id: string } | undefined;
	return row?.trip_id ?? null;
}

/**
 * True when this user may mutate this event, and which day it is on.
 *
 * `tripId` is required and is checked against the event's owner before
 * membership is looked up, so someone on both trip A and trip B cannot reach a
 * B event through an A request. Same rule the old item mutations enforced; the
 * reasoning did not change with the table.
 */
function mayEdit(
	eventId: string,
	userId: string,
	tripId: string
): { day: string; end_day: string | null } | null {
	const row = db.prepare(`SELECT trip_id, day, end_day FROM events WHERE id = ?`).get(eventId) as
		{ trip_id: string; day: string; end_day: string | null } | undefined;
	if (!row || row.trip_id !== tripId) return null;
	if (!isMember(tripId, userId)) return null;
	return { day: row.day, end_day: row.end_day };
}

/**
 * Recompute after a write.
 *
 * Always the day itself and always the day after, because a stay is the
 * previous night for the morning that follows it and the planner reads it from
 * there. Doing it unconditionally rather than only for stays costs one plan
 * over a usually-empty day and removes a class of bug where an event changes
 * type into a stay and the following morning is never told.
 *
 * A stay covers a range, so every night in it is a day whose plan may have
 * changed, and an edit that moves one has to cover where it was as well as
 * where it now is. Callers pass the widest span they touched; a block on one
 * day passes nothing and gets the two days it always got.
 */
function touched(tripId: string, day: string, ...alsoNulls: (string | null | undefined)[]): void {
	const days = [day, ...alsoNulls.filter((d): d is string => !!d)].sort();
	const last = days[days.length - 1];
	// One past the end, because the morning after a stay leaves it.
	for (let d = days[0]; d <= shiftDay(last, 1); d = shiftDay(d, 1)) recomputeLegs(tripId, d);
	publish(tripId, 'schedule');
}

/** The checkout a stay is stored with: what was asked for, or the morning after. */
function stayEnd(type: EventType, day: string, endDay?: string | null): string | null {
	if (type !== 'stay') return null;
	// A checkout on or before the arrival is not a stay anybody had; one night is
	// the shortest thing the word describes, so that is what it settles on.
	return endDay && endDay > day ? endDay : shiftDay(day, 1);
}

export function createEvent(tripId: string, userId: string, e: NewEvent): string | null {
	if (!isMember(tripId, userId)) return null;
	const type: EventType = isEventType(e.type) ? e.type : 'activity';
	const located = isLocatedType(type);
	const start = Math.max(0, Math.min(Math.round(e.startMin), 24 * 60 - MIN_EVENT_MINS));
	const end = Math.max(start + MIN_EVENT_MINS, Math.min(Math.round(e.endMin), 24 * 60));
	const endDay = stayEnd(type, e.day, e.endDay);

	const id = randomUUID();
	db.prepare(
		`INSERT INTO events
		 (id, trip_id, day, end_day, title, type, start_min, end_min, poi_id, lodging_id, city_id, lat, lng, notes, travel_mode, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		tripId,
		e.day,
		endDay,
		e.title,
		type,
		start,
		end,
		located ? (e.poiId ?? null) : null,
		type === 'stay' ? (e.lodgingId ?? null) : null,
		e.cityId ?? null,
		located ? (e.lat ?? null) : null,
		located ? (e.lng ?? null) : null,
		e.notes?.trim() || null,
		type === 'travel' && e.travelMode && isTransportMode(e.travelMode) ? e.travelMode : null,
		Date.now()
	);
	if (e.people?.length) writePeople(id, tripId, e.people);
	touched(tripId, e.day, endDay);
	return id;
}

export function deleteEvent(eventId: string, userId: string, tripId: string): boolean {
	const where = mayEdit(eventId, userId, tripId);
	if (!where) return false;
	db.prepare(`DELETE FROM events WHERE id = ?`).run(eventId);
	touched(tripId, where.day, where.end_day);
	return true;
}

/** Move an event to a new start, keeping its length. Snaps and clamps to the day. */
export function moveEvent(
	eventId: string,
	userId: string,
	startMin: number,
	tripId: string,
	toDay?: string
): boolean {
	const where = mayEdit(eventId, userId, tripId);
	if (!where) return false;
	const ev = db.prepare(`SELECT start_min, end_min FROM events WHERE id = ?`).get(eventId) as
		{ start_min: number; end_min: number } | undefined;
	if (!ev) return false;

	const snapped = Math.round(startMin / SNAP) * SNAP;
	const duration = ev.end_min - ev.start_min;
	const clamped = Math.max(0, Math.min(snapped, 24 * 60 - duration));
	// A stay is not dragged: it is a band rather than a block, and its length is
	// in nights. A move that lands on another day still has to carry the
	// checkout with it, or the range would invert.
	const movedEnd = where.end_day && toDay ? shiftDay(toDay, nights(where)) : where.end_day;
	db.prepare(
		`UPDATE events SET start_min = ?, end_min = ?, day = COALESCE(?, day), end_day = ? WHERE id = ?`
	).run(clamped, clamped + duration, toDay ?? null, movedEnd, eventId);
	touched(tripId, where.day, where.end_day, toDay, movedEnd);
	return true;
}

/** How many nights a stay runs for, which a move has to preserve. */
function nights(where: { day: string; end_day: string | null }): number {
	if (!where.end_day) return 1;
	const at = (iso: string) => {
		const [y, m, d] = iso.split('-').map(Number);
		return Date.UTC(y, m - 1, d);
	};
	return Math.max(1, Math.round((at(where.end_day) - at(where.day)) / 86400000));
}

/** Resize an event by moving its end. Snaps and clamps to the day. */
export function resizeEvent(
	eventId: string,
	userId: string,
	endMin: number,
	tripId: string
): boolean {
	const where = mayEdit(eventId, userId, tripId);
	if (!where) return false;
	const ev = db.prepare(`SELECT start_min FROM events WHERE id = ?`).get(eventId) as
		{ start_min: number } | undefined;
	if (!ev) return false;
	const snapped = Math.round(endMin / SNAP) * SNAP;
	const clamped = Math.max(ev.start_min + MIN_EVENT_MINS, Math.min(snapped, 24 * 60));
	db.prepare(`UPDATE events SET end_min = ? WHERE id = ?`).run(clamped, eventId);
	touched(tripId, where.day, where.end_day);
	return true;
}

export interface EventEdit {
	title?: string;
	type?: string;
	notes?: string | null;
	travelMode?: string | null;
	startMin?: number;
	endMin?: number;
	/**
	 * When a stay is checked into and out of.
	 *
	 * A stay is the one block that is not on a clock: it is a range of nights,
	 * so this is how it is moved and lengthened, and `startMin`/`endMin` do not
	 * apply to it. Absent leaves the range alone.
	 */
	day?: string;
	endDay?: string;
	/**
	 * The saved place this event happens at, already resolved by the caller.
	 *
	 * Absent leaves the link alone, null unlinks it. The coordinates travel with
	 * the link rather than being looked up here, because the chain is planned off
	 * the event's own lat/lng: a link without them would put the event nowhere
	 * while claiming a place.
	 */
	place?: {
		poiId?: string;
		lodgingId?: string;
		lat: number | null;
		lng: number | null;
	} | null;
}

/** The type an event is stored as, for an edit that does not restate it. */
export function currentType(eventId: string): string {
	const row = db.prepare(`SELECT type FROM events WHERE id = ?`).get(eventId) as
		{ type: string } | undefined;
	return row?.type ?? '';
}

/**
 * Apply an edit to an event.
 *
 * `expectedVersion` is the version the editor had on screen. A stale one is
 * refused rather than applied, because the caller's copy of every field it did
 * not touch is stale too, and writing those back silently restores whatever the
 * other editor just changed. Omitting it keeps the old unchecked behaviour, so
 * a script or an older client is not locked out.
 */
export function editEvent(
	eventId: string,
	userId: string,
	edit: EventEdit,
	tripId: string,
	expectedVersion?: number | null
): WriteResult {
	const where = mayEdit(eventId, userId, tripId);
	if (!where) return missing;
	const current = db.prepare(`SELECT version FROM events WHERE id = ?`).get(eventId) as
		| { version: number }
		| undefined;
	if (!current) return missing;
	if (isStale(expectedVersion, current.version)) return conflict;
	const sets: string[] = [];
	const args: (string | number | null)[] = [];

	const title = edit.title?.trim();
	if (title) {
		sets.push('title = ?');
		args.push(title);
	}
	if (edit.type && isEventType(edit.type)) {
		sets.push('type = ?');
		args.push(edit.type);
		// Free time is not anywhere at all. Its place is cleared rather than kept,
		// because a block claiming coordinates it does not honour is what made the
		// old chain plan journeys nobody was making.
		if (edit.type === 'freetime') {
			sets.push('lat = NULL', 'lng = NULL', 'poi_id = NULL', 'lodging_id = NULL');
		}
	}
	if (edit.notes !== undefined) {
		sets.push('notes = ?');
		args.push(edit.notes?.trim() || null);
	}
	// Free time has just cleared its place above, and re-setting one here would
	// undo that in the same statement.
	if (edit.place !== undefined && edit.type !== 'freetime') {
		// Both columns are always written, because the two links are exclusive:
		// re-typing a block from an activity to a stay has to release the museum
		// as it takes the hotel, or the Discover card would keep counting it.
		if (edit.place) {
			sets.push('poi_id = ?', 'lodging_id = ?', 'lat = ?', 'lng = ?');
			args.push(edit.place.poiId ?? null, edit.place.lodgingId ?? null);
			args.push(edit.place.lat, edit.place.lng);
		} else {
			sets.push('poi_id = NULL', 'lodging_id = NULL', 'lat = NULL', 'lng = NULL');
		}
	}
	if (edit.travelMode !== undefined) {
		sets.push('travel_mode = ?');
		args.push(edit.travelMode && isTransportMode(edit.travelMode) ? edit.travelMode : null);
	}
	// Both ends move together, because an event has to occupy real time on its
	// own day: a stay used to be exempt, and is not any more. Whichever end the
	// caller left out is read back from the row so a lone edit still cannot
	// invert it.
	if (
		(edit.startMin !== undefined && Number.isFinite(edit.startMin)) ||
		(edit.endMin !== undefined && Number.isFinite(edit.endMin))
	) {
		const cur = db.prepare(`SELECT start_min, end_min FROM events WHERE id = ?`).get(eventId) as
			{ start_min: number; end_min: number } | undefined;
		if (!cur) return missing;
		const wanted = Number.isFinite(edit.startMin as number)
			? (edit.startMin as number)
			: cur.start_min;
		const start = Math.max(0, Math.min(Math.round(wanted), 24 * 60 - MIN_EVENT_MINS));
		const wantedEnd = Number.isFinite(edit.endMin as number)
			? (edit.endMin as number)
			: cur.end_min;
		const end = Math.max(start + MIN_EVENT_MINS, Math.min(Math.round(wantedEnd), 24 * 60));
		sets.push('start_min = ?', 'end_min = ?');
		args.push(start, end);
	}
	// A stay is moved by its dates rather than by its clock. Both ends are
	// written together so a range can never invert: a checkout on or before the
	// arrival becomes the morning after it, which is the shortest real stay.
	let movedTo: string | null = null;
	let movedEnd: string | null = null;
	const staying = (edit.type ?? currentType(eventId)) === 'stay';
	if (staying && (edit.day || edit.endDay)) {
		movedTo = edit.day || where.day;
		movedEnd = stayEnd('stay', movedTo, edit.endDay ?? where.end_day) as string;
		sets.push('day = ?', 'end_day = ?');
		args.push(movedTo, movedEnd);
	} else if (edit.type && edit.type !== 'stay') {
		// Leaving the type behind leaves the range behind with it: a block that is
		// no longer a stay occupies its own day like everything else.
		sets.push('end_day = NULL');
	} else if (edit.type === 'stay' && !where.end_day) {
		sets.push('end_day = ?');
		args.push(shiftDay(where.day, 1));
	}

	if (!sets.length) return missing;

	const next = current.version + 1;
	sets.push('version = ?');
	args.push(next);

	args.push(eventId);
	db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...args);
	touched(tripId, where.day, where.end_day, movedTo, movedEnd);
	return written(next);
}

/** Replace who is on an event. This is what makes the group split, or rejoin. */
export function setEventPeople(
	eventId: string,
	tripId: string,
	userId: string,
	people: string[]
): boolean {
	const where = mayEdit(eventId, userId, tripId);
	if (!where) return false;
	writePeople(eventId, tripId, people);
	touched(tripId, where.day, where.end_day);
	return true;
}

// --- Travel overrides -------------------------------------------------------

/**
 * Pin a leg's name, mode and duration by hand.
 *
 * Passing null for the mode and the minutes clears the override and hands the
 * leg back to the provider, which is how someone undoes a guess without having
 * to remember what the automatic answer was. The name is separate and survives
 * that reset: what you call a journey is not an estimate of anything.
 */
export function editLeg(
	legId: string,
	tripId: string,
	userId: string,
	mode: string | null,
	mins: number | null,
	title?: string | null
): boolean {
	if (!isMember(tripId, userId)) return false;
	const row = db.prepare(`SELECT trip_id FROM travel_legs WHERE id = ?`).get(legId) as
		{ trip_id: string } | undefined;
	if (!row || row.trip_id !== tripId) return false;
	db.prepare(`UPDATE travel_legs SET mode = ?, mins = ? WHERE id = ?`).run(
		mode && isTransportMode(mode) ? mode : null,
		mins != null && Number.isFinite(mins) && mins > 0 ? Math.min(Math.round(mins), 48 * 60) : null,
		legId
	);
	if (title !== undefined) {
		db.prepare(`UPDATE travel_legs SET title = ? WHERE id = ?`).run(title?.trim() || null, legId);
	}
	publish(tripId, 'schedule');
	return true;
}

// --- Crews ------------------------------------------------------------------

const CREW_COLORS = ['#2f6d5e', '#b4682a', '#4a6d8c', '#8c5a86', '#6d7a2f'];

/**
 * The id of the crew that is every member of the trip.
 *
 * Fixed rather than a uuid because the crew is not a row: it is derived on
 * every read, so there is nothing to allocate an id for, and a constant is what
 * both ends can recognise it by.
 */
export const EVERYONE_CREW_ID = 'everyone';

export interface Crew {
	id: string;
	name: string;
	color: string;
	members: string[];
	/** Derived from the roster, so it cannot be renamed, emptied or deleted. */
	locked: boolean;
}

/**
 * A crew is a saved group of people, and nothing else.
 *
 * The old "party" owned a schedule, a city and a time-segmented membership, so
 * putting two people in a group was a scheduling decision with consequences a
 * week long. A crew is only a shortcut for the people picker: choosing one
 * selects its members and then gets out of the way. Nothing reads a crew while
 * drawing a day, which is why one can be renamed or deleted at any time without
 * the schedule moving underneath anybody.
 *
 * Every trip has one crew it did not make: everybody. It is the group asked for
 * most often, and a group nobody should have to assemble by hand or keep up to
 * date as people join and leave.
 *
 * It is derived here rather than stored as a row, because a stored one would
 * have to be written by every path that touches the roster: joining, being
 * added, being removed, leaving, and merging a placeholder into a real account.
 * Each of those is a chance for it to fall behind and start naming a group that
 * is no longer everyone, which is the one thing it exists to be. Derived, it
 * cannot drift, needs no migration for the trips that already exist, and cannot
 * be deleted by somebody tidying up.
 *
 * Two topics on every write: crews are managed on the People page and read by
 * the board's people picker, so both have to hear about one.
 */
export function crewsForTrip(tripId: string): Crew[] {
	const rows = db
		.prepare(`SELECT id, name, color FROM crews WHERE trip_id = ? ORDER BY sort, name`)
		.all(tripId) as unknown as { id: string; name: string; color: string }[];
	const stmt = db.prepare(`SELECT user_id FROM crew_members WHERE crew_id = ?`);
	return [
		{
			id: EVERYONE_CREW_ID,
			name: 'Everyone',
			color: CREW_COLORS[0],
			members: rosterInOrder(tripId),
			locked: true
		},
		...rows.map((r) => ({
			...r,
			members: (stmt.all(r.id) as unknown as { user_id: string }[]).map((x) => x.user_id),
			locked: false
		}))
	];
}

/** The roster by name, which is the order every picker lists people in. */
function rosterInOrder(tripId: string): string[] {
	const rows = db
		.prepare(
			`SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
			 WHERE m.trip_id = ? ORDER BY u.name, u.id`
		)
		.all(tripId) as unknown as { user_id: string }[];
	return rows.map((r) => r.user_id);
}

function writeCrewMembers(crewId: string, tripId: string, members: string[]): void {
	const roster = tripMemberIds(tripId);
	const clean = [...new Set(members)].filter((id) => roster.has(id));
	db.prepare(`DELETE FROM crew_members WHERE crew_id = ?`).run(crewId);
	const ins = db.prepare(`INSERT INTO crew_members (crew_id, user_id) VALUES (?, ?)`);
	for (const id of clean) ins.run(crewId, id);
}

export function createCrew(
	tripId: string,
	userId: string,
	name: string,
	members: string[]
): string | null {
	if (!isMember(tripId, userId)) return null;
	const count =
		(
			db.prepare(`SELECT COUNT(*) AS n FROM crews WHERE trip_id = ?`).get(tripId) as
				{ n: number } | undefined
		)?.n ?? 0;
	const id = randomUUID();
	db.prepare(`INSERT INTO crews (id, trip_id, name, color, sort) VALUES (?, ?, ?, ?, ?)`).run(
		id,
		tripId,
		name,
		CREW_COLORS[count % CREW_COLORS.length],
		count
	);
	writeCrewMembers(id, tripId, members);
	publishMany(tripId, ['schedule', 'members']);
	return id;
}

export function editCrew(
	crewId: string,
	tripId: string,
	userId: string,
	name: string | undefined,
	members: string[] | undefined
): boolean {
	if (!isMember(tripId, userId)) return false;
	if (crewId === EVERYONE_CREW_ID) return false;
	if (!db.prepare(`SELECT 1 FROM crews WHERE id = ? AND trip_id = ?`).get(crewId, tripId)) {
		return false;
	}
	if (!name && !members) return false;
	if (name) db.prepare(`UPDATE crews SET name = ? WHERE id = ?`).run(name, crewId);
	if (members) writeCrewMembers(crewId, tripId, members);
	publishMany(tripId, ['schedule', 'members']);
	return true;
}

export function deleteCrew(crewId: string, tripId: string, userId: string): boolean {
	if (!isMember(tripId, userId)) return false;
	if (crewId === EVERYONE_CREW_ID) return false;
	const res = db.prepare(`DELETE FROM crews WHERE id = ? AND trip_id = ?`).run(crewId, tripId);
	if (res.changes > 0) publishMany(tripId, ['schedule', 'members']);
	return res.changes > 0;
}
