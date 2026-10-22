import { randomUUID } from 'node:crypto';
import { db, backfillDone, markBackfillDone } from '../db';
import {
	DAY_END_MIN,
	isEventType,
	isLocatedType,
	isTransportMode,
	type EventType
} from '@trippy/core/types';
import { legKey, type PlannedLeg } from '@trippy/core/travel';
import {
	daysBetween,
	planDay,
	reflowAutoTimes,
	resolveLeg,
	shiftDay,
	stayBand,
	SUGGEST_SNAP,
	type LegOverride
} from '@trippy/core/plan';
import {
	isMultiDay,
	lastDayOf,
	MAX_SPAN_DAYS,
	normalizeSpan,
	onOneClock,
	crossesZones,
	reclock,
	type SpanRow,
	type ZoneOf
} from '@trippy/core/span';
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
 * Matching is on `leg_key`, which is the pair of events (see `legKey` in core).
 * That is what makes an override survive an unrelated edit: dragging an event
 * by ten minutes, or somebody joining the trip, does not change which two
 * events a journey joins, so the key is unchanged and the ferry time someone
 * typed is still there afterwards. The travellers are stored beside it
 * (`people`) and kept current, but they are not part of the identity: they are
 * the expanded roster wherever an event is on Everyone, and a roster change
 * used to re-key, and so orphan, every such journey on the trip.
 *
 * Reads reconcile too. `legsForDay` inserts a row for any planned journey that
 * has none before answering, so a path that changes the plan without coming
 * through here (a roster change, a place deleted from Discover) can at worst
 * leave a suggested time un-reflowed until the next write, never a day with its
 * travel missing.
 */

/** Drag/resize snap granularity, in minutes. The same five a suggested time rounds to. */
const SNAP = SUGGEST_SNAP;

/** The shortest event the grid can draw with its title. */
export { MIN_EVENT_MINS } from '@trippy/core/types';
import { MIN_EVENT_MINS } from '@trippy/core/types';

/** Where a stay sits on the clock. In core, so the client anchors it the same. */
export { STAY_CHECK_IN } from '@trippy/core/types';

/**
 * Day arithmetic, in core so the board and the API agree about what tomorrow
 * is. Re-exported because `apps/api/src/routes/schedule.ts` reaches for it
 * here, and moving it should not make that route learn a new module.
 */
export { shiftDay } from '@trippy/core/plan';

export interface EventRow {
	id: string;
	day: string;
	/**
	 * For a stay, the checkout morning, exclusive. For anything else, the day
	 * the block ends on, inclusive, or null when it ends on its own day. See
	 * `packages/core/src/span.ts`, which every reader of the second meaning uses.
	 */
	end_day: string | null;
	title: string;
	type: EventType;
	start_min: number;
	end_min: number;
	poi_id: string | null;
	lodging_id: string | null;
	/** A location typed by hand. Exclusive with the two links, and never mapped. */
	place_text: string | null;
	city_id: string | null;
	/** A journey's arrival city, whose zone `end_min` is read in. Null for anything else. */
	end_city_id: string | null;
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

const EVENT_COLUMNS = `id, day, end_day, title, type, start_min, end_min, poi_id, lodging_id, place_text, city_id, end_city_id, lat, lng, notes, travel_mode, version`;

/**
 * The last day a row is on, in SQL, for the questions that walk days.
 *
 * A timed block that runs past its own day is on every day to its `end_day`.
 * A stay is not: its `end_day` is a checkout, and the day lists and arrows
 * have always counted a stay by the day it is checked into, which this keeps.
 * The `> day` guard reads a stray end day on or before the start as the start,
 * which is what `lastDayOf` in core does.
 */
const LAST_DAY_SQL = `CASE WHEN type != 'stay' AND end_day > day THEN end_day ELSE day END`;

/**
 * How far back a row can start and still reach a given day, as a SQLite date
 * modifier. A span runs at most `MAX_SPAN_DAYS` past its start (the route
 * refuses anything longer), so the rows that can cover day D all start in
 * `[D - MAX_SPAN_DAYS, D]`, and a query for D reads that window off the
 * `(trip_id, day)` index rather than every row of the trip before D.
 */
const SPAN_REACH = `'-${MAX_SPAN_DAYS} days'`;

/**
 * Every day a trip's rows are on, as a recursive walk from each row's first day
 * to its last. A span is at most fifteen days (`MAX_SPAN_DAYS` in core), so the
 * walk is bounded by the rows rather than by the calendar.
 */
const COVERED_DAYS_SQL = `
	WITH RECURSIVE covered(d, last) AS (
		SELECT day, ${LAST_DAY_SQL} FROM events WHERE trip_id = ?
		UNION
		SELECT date(d, '+1 day'), last FROM covered WHERE d < last
	)`;

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
 *
 * A block that runs over several days is on each day it covers, as the same
 * row: the client asks `segmentOn` in core where it sits on the day, so the
 * row is never cut into per-day copies that could disagree. "Earliest" is by
 * that segment's start, which for a block carried in from yesterday is
 * midnight, so it leads the day the way the board draws it.
 */
export function eventsForDay(tripId: string, day: string): EventRow[] {
	const rows = db
		.prepare(
			`SELECT ${EVENT_COLUMNS} FROM events
			 WHERE trip_id = ? AND day <= ? AND day >= date(?, ${SPAN_REACH})
			   AND type != 'stay' AND ? <= ${LAST_DAY_SQL}
			 ORDER BY CASE WHEN day < ? THEN 0 ELSE start_min END, day, start_min, id`
		)
		.all(tripId, day, day, day, day) as unknown as EventRow[];
	return attachPeople(rows);
}

/**
 * Where people sleep on the night of `day`, and who is in each.
 *
 * Nights, not days: a stay covers `[day, end_day)`, checked into on its own day
 * and out of on `end_day`, so the last night it covers is the day before
 * checkout. That is the reading the planner wants, because the night is what
 * the next morning's first journey leaves from.
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
 * what the next morning's first journey leaves from, and this for the days,
 * which is what is drawn.
 *
 * The de-duplication a drawn checkout day needs is `stayBand` in core, because
 * the client draws the same band from the same rows while a dialog is open and
 * the two must agree about which chips a day has.
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
	return stayBand(attachPeople(rows), day);
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

/**
 * The city a day is spent in, as far as the schedule says, or null when it
 * does not say.
 *
 * Cities are dateless (DESIGN 5.0.8), so this does not slice the trip across
 * them. It reads the one booking that does say where somebody is on a date: a
 * stay at a lodging option, which belongs to a city. The earliest stay drawn on
 * the day wins, which is the one woken up in when there is one (its checkout
 * morning is a day of it) and tonight's otherwise. Waking up is the reading a
 * day's first clock needs: a flight out of Tokyo on the morning the group
 * leaves the Tokyo hotel departs on Tokyo's clock, whatever city it lands in.
 *
 * The board answers `BoardDay.city` with this, and `POST /events` stores it as
 * the city of a block created without one, so the zone a start is read in is
 * the one the board showed the day in. The caller falls back to the trip's
 * first city, as both did before.
 */
export function dayCity(tripId: string, day: string): string | null {
	const row = db
		.prepare(
			`SELECT l.city_id AS city_id
			   FROM events e JOIN lodging_options l ON l.id = e.lodging_id
			  WHERE e.trip_id = ? AND e.type = 'stay'
			    AND e.day <= ? AND ? <= COALESCE(e.end_day, date(e.day, '+1 day'))
			  ORDER BY e.day, e.start_min, e.id
			  LIMIT 1`
		)
		.get(tripId, day, day) as unknown as { city_id: string } | undefined;
	return row?.city_id ?? null;
}

/**
 * Distinct days carrying anything, ordered.
 *
 * A block that runs over several days carries each of them, so the strip and
 * the arrows reach its middle and its last day even when nothing else is on
 * them. A stay still counts by the day it is checked into, as it always has.
 */
export function scheduleDays(tripId: string): string[] {
	const rows = db
		.prepare(`${COVERED_DAYS_SQL} SELECT DISTINCT d AS day FROM covered ORDER BY d`)
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
 * These four answer the same questions in SQL without walking the calendar,
 * so the reach of a trip no longer depends on anything being listed first.
 *
 * Each reads a row as covering `day` through its last day (`LAST_DAY_SQL`), so
 * a block that runs over several days carries every one of them, and a stay
 * still carries only its own. A span reaches at most `MAX_SPAN_DAYS` past its
 * start, so each question about one day reads a window that wide off the
 * `(trip_id, day)` index (`SPAN_REACH`) rather than every row before it.
 */

/** Whether anything is on `day`. The cheap form of `scheduleDays().includes`. */
export function dayHasEvents(tripId: string, day: string): boolean {
	const row = db
		.prepare(
			`SELECT 1 AS hit FROM events
			  WHERE trip_id = ? AND day <= ? AND day >= date(?, ${SPAN_REACH})
			    AND ? <= ${LAST_DAY_SQL} LIMIT 1`
		)
		.get(tripId, day, day, day) as unknown as { hit: number } | undefined;
	return row !== undefined;
}

/**
 * Earliest and latest day carrying anything, or nulls for an empty schedule.
 *
 * The latest is the indexed `MAX(day)` or the end of a span starting at most
 * `MAX_SPAN_DAYS` before it, whichever is later: a span that ends past every
 * start has to start within that reach of the last one.
 */
export function scheduledDayEdges(tripId: string): { first: string | null; last: string | null } {
	const edge = db
		.prepare(`SELECT MIN(day) AS first, MAX(day) AS last FROM events WHERE trip_id = ?`)
		.get(tripId) as unknown as { first: string | null; last: string | null } | undefined;
	if (!edge?.first || !edge.last) return { first: null, last: null };
	const reach = db
		.prepare(
			`SELECT MAX(${LAST_DAY_SQL}) AS last FROM events
			  WHERE trip_id = ? AND day >= date(?, ${SPAN_REACH})`
		)
		.get(tripId, edge.last) as unknown as { last: string | null } | undefined;
	const last = reach?.last && reach.last > edge.last ? reach.last : edge.last;
	return { first: edge.first, last };
}

/**
 * The nearest day before `day` that carries something, or null.
 *
 * A row that starts before `day` carries the day before it if it is still
 * going then, and otherwise its own last day, so the answer per row is the
 * earlier of the two, and the nearest is the latest of those.
 *
 * The latest start before `day` (indexed) is always a candidate, and a row can
 * only beat it by ending after it, which means starting at most
 * `MAX_SPAN_DAYS` before it. So only that window is read for the rest.
 */
export function scheduledDayBefore(tripId: string, day: string): string | null {
	const latest = db
		.prepare(`SELECT MAX(day) AS d FROM events WHERE trip_id = ? AND day < ?`)
		.get(tripId, day) as unknown as { d: string | null } | undefined;
	if (!latest?.d) return null;
	const row = db
		.prepare(
			`SELECT MAX(MIN(${LAST_DAY_SQL}, date(?, '-1 day'))) AS d
			   FROM events WHERE trip_id = ? AND day < ? AND day >= date(?, ${SPAN_REACH})`
		)
		.get(day, tripId, day, latest.d) as unknown as { d: string | null } | undefined;
	return row?.d && row.d > latest.d ? row.d : latest.d;
}

/**
 * The nearest day after `day` that carries something, or null.
 *
 * A span still going past `day` makes the answer the very next day, and such a
 * span started at most `MAX_SPAN_DAYS` before `day`; otherwise it is the
 * earliest start after `day`, which the index answers.
 */
export function scheduledDayAfter(tripId: string, day: string): string | null {
	const row = db
		.prepare(
			`SELECT CASE
			   WHEN EXISTS (
			     SELECT 1 FROM events
			      WHERE trip_id = ? AND day <= ? AND day >= date(?, ${SPAN_REACH})
			        AND ${LAST_DAY_SQL} > ?
			   ) THEN date(?, '+1 day')
			   ELSE (SELECT MIN(day) FROM events WHERE trip_id = ? AND day > ?)
			 END AS d`
		)
		.get(tripId, day, day, day, day, tripId, day) as unknown as { d: string | null } | undefined;
	return row?.d ?? null;
}

/**
 * How many days carry something outside `[start, end]`.
 *
 * The count of days a trip offers is the length of its own range plus these:
 * the days inside the range are already offered whether or not anything is on
 * them, so only the stranded ones add to the total. Counted rather than listed
 * so the total costs the same on a trip of any length; the walk over a span's
 * days is bounded by the longest span, not by the trip.
 */
export function strandedDayCount(tripId: string, start: string, end: string): number {
	const row = db
		.prepare(
			`${COVERED_DAYS_SQL}
			 SELECT COUNT(DISTINCT d) AS n FROM covered WHERE d < ? OR d > ?`
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
 * The zone of each of the trip's cities, which is what a span's two ends are
 * read in. One small read per plan, for the same reason the roster is read
 * rather than copied: a city added or removed is in the next answer.
 */
export function tripZones(tripId: string): ZoneOf {
	const rows = db.prepare(`SELECT id, tz FROM cities WHERE trip_id = ?`).all(tripId) as unknown as {
		id: string;
		tz: string;
	}[];
	const zones = new Map(rows.map((r) => [r.id, r.tz]));
	return (cityId) => (cityId ? zones.get(cityId) : null);
}

/**
 * The day's plan: its blocks, with last night's lodging as the morning's
 * origin.
 *
 * All this layer does is read what a day is made of and hand it to `planDay` in
 * core, which owns every rule about what it means: the projection to a
 * `PlannerEvent`, "Everyone", the midnight origin the morning leaves from, and
 * where a block that runs over several days sits on this one. The client
 * replans the same day from the same function while a dialog is open, so the
 * two answers cannot differ.
 */
function planFor(tripId: string, day: string): PlannedLeg[] {
	return planDay(
		{
			day,
			events: eventsForDay(tripId, day),
			incoming: incomingStays(tripId, day),
			zoneOf: tripZones(tripId)
		},
		tripRoster(tripId)
	);
}

/**
 * Move the day's suggested blocks to follow what now comes before them.
 *
 * Runs after `recomputeLegs`, because the rule is "the end of the block before,
 * plus the journey between them", and the journeys are what that write has just
 * settled. `reflowAutoTimes` in core owns the rule itself.
 *
 * The write is deliberately narrow: only `start_min` and `end_min`, only for
 * the ids core returned. `version` is bumped, though nobody chose the move: a
 * dialog opened on the block before it moved still holds the old clock, and
 * saving it would silently put the block back. Bumping makes that save a 409
 * the reader can reload from instead. It used to be left alone on the grounds
 * that a reflow is not somebody editing the block, which is true, and is also
 * exactly the kind of write a stale dialog reverts without anyone noticing.
 *
 * Returns whether anything moved, so the caller can re-plan. Moving a block
 * changes the order the chain is walked in, which can change which journeys
 * exist at all, and the stored legs would otherwise describe the day as it was
 * a moment ago.
 */
function reflowDay(tripId: string, day: string): boolean {
	const events = eventsForDay(tripId, day);
	if (!events.length) return false;

	const auto = new Set(
		(
			db
				.prepare(
					`SELECT id FROM events WHERE trip_id = ? AND day = ? AND type != 'stay' AND time_auto = 1`
				)
				.all(tripId, day) as unknown as { id: string }[]
		).map((r) => r.id)
	);
	if (!auto.size) return false;

	// Read as their part of this day, so a block carried in from yesterday is
	// what the morning follows; `reflowAutoTimes` never moves one of those.
	const moved = reflowAutoTimes(
		events.map((e) => ({ ...e, time_auto: auto.has(e.id) })),
		legsForDay(tripId, day),
		tripRoster(tripId),
		{ day, zoneOf: tripZones(tripId) }
	);
	if (!moved.length) return false;

	const upd = db.prepare(
		`UPDATE events SET start_min = ?, end_min = ?, version = version + 1 WHERE id = ?`
	);
	for (const m of moved) upd.run(m.startMin, m.endMin, m.id);
	return true;
}

/**
 * Reconcile the stored legs for a day against what the events now imply.
 *
 * Called after every event write. Cheap enough to run unconditionally: it is
 * one plan over one day's events and a handful of statements. Working out
 * whether a given edit could possibly have changed the plan is both harder to
 * get right and easy to get subtly wrong in the direction of stale travel.
 *
 * A journey is identified by its key, which is the two events and who is going,
 * so the same two events on another day are the same journey: dragging a block
 * to the next day does not change how you get there, and neither should the
 * mode the reader pinned on it. A row is therefore never thrown away for having
 * stopped being planned. It is moved to whichever day plans it next, and until
 * some day does it simply sits there unread, because `legsForDay` only returns
 * rows the plan asked for. The row dies with either of its two events, which is
 * the only moment the journey it describes can no longer happen.
 *
 * That also means a routed answer is looked up once per pair of places rather
 * than once per day they land on, which matters because routing costs money.
 */
export function recomputeLegs(tripId: string, day: string): void {
	reconcileLegs(tripId, day, planFor(tripId, day));
}

/**
 * The body of `recomputeLegs`, against a plan the caller already has.
 *
 * Insert-only as far as the day's rows go: a planned journey with no row gets
 * one (claimed from another day if the pair has one, so its pin comes along),
 * and a row whose travellers have changed has its `people` brought up to date.
 * Nothing is deleted. That is what makes it safe to run from a read.
 */
function reconcileLegs(tripId: string, day: string, planned: readonly PlannedLeg[]): void {
	if (!planned.length) return;
	const existing = db
		.prepare(`SELECT id, leg_key, people FROM travel_legs WHERE trip_id = ? AND day = ?`)
		.all(tripId, day) as unknown as { id: string; leg_key: string; people: string }[];
	const have = new Map(existing.map((r) => [r.leg_key, r]));

	const prior = db.prepare(
		`SELECT id FROM travel_legs
		 WHERE trip_id = ? AND leg_key = ? AND day <> ? ORDER BY day LIMIT 1`
	);
	const claim = db.prepare(
		`UPDATE travel_legs
		    SET day = ?, from_event_id = ?, to_event_id = ?, people = ?
		  WHERE id = ?`
	);
	const ins = db.prepare(
		`INSERT INTO travel_legs
		   (id, trip_id, day, leg_key, from_event_id, to_event_id, people)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	);
	const retell = db.prepare(`UPDATE travel_legs SET people = ? WHERE id = ?`);

	for (const leg of planned) {
		const people = leg.people.join(',');
		const row = have.get(leg.key);
		if (row) {
			if (row.people !== people) retell.run(people, row.id);
			continue;
		}
		const kept = prior.get(tripId, leg.key, day) as unknown as { id: string } | undefined;
		if (kept) claim.run(day, leg.fromEventId, leg.toEventId, people, kept.id);
		else ins.run(randomUUID(), tripId, day, leg.key, leg.fromEventId, leg.toEventId, people);
	}
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
 * inserts what is newly planned and leaves every row whose key still stands,
 * overrides and all. Nothing is dropped and no table is rebuilt.
 *
 * Returns the number of (trip, day) pairs it visited, which is what the caller
 * logs or a test asserts on.
 */
export function reconcileAllLegs(): number {
	const rows = db
		.prepare(
			`SELECT DISTINCT trip_id, day, ${LAST_DAY_SQL} AS last FROM events ORDER BY trip_id, day`
		)
		.all() as unknown as { trip_id: string; day: string; last: string }[];
	// The morning after a stay leaves it, so the day after one carrying events
	// can have legs of its own even with nothing scheduled on it. A block that
	// runs over several days is planned on each of them, and the morning after
	// its last is planned from it in the same way.
	const pairs = new Set<string>();
	for (const r of rows) {
		for (let d = r.day; d <= r.last; d = shiftDay(d, 1)) pairs.add(`${r.trip_id}\u0000${d}`);
		pairs.add(`${r.trip_id}\u0000${shiftDay(r.last, 1)}`);
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
/*
 * The pair-key re-keying runs before the Everyone reconciliation below. On a
 * database that has neither marker, the reconciliation would otherwise insert a
 * fresh, unpinned `from>to` row for every pair first, and the re-key would then
 * find the key taken and leave the pinned legacy row behind. The re-key also
 * merges into such a row if one exists anyway (see `rekeyLegacyLegs`), so the
 * order is belt and braces rather than the only guard.
 */
const PAIR_KEY_BACKFILL = 'travel-legs-pair-key';
const pairKeyPending = !backfillDone(PAIR_KEY_BACKFILL);
if (pairKeyPending) rekeyLegacyLegs();

const LEGS_BACKFILL = 'travel-legs-everyone-expansion';
if (!backfillDone(LEGS_BACKFILL)) {
	reconcileAllLegs();
	markBackfillDone(LEGS_BACKFILL);
}

/**
 * The one-time pass for the key that stopped carrying the travellers.
 *
 * Rows written before it are keyed `from>to>people`. Each pair of events keeps
 * one of its rows and has that row re-keyed to `from>to`: the one somebody
 * pinned or named if any was, else one the router has answered for, else the
 * newest. Duplicates exist because every roster change re-keyed the pair and
 * the next write inserted a fresh row beside the pinned one, and picking the
 * pinned row is what gives the reader their ferry back.
 *
 * The rows not picked are left exactly as they are, under their old key. No
 * plan asks for that key any more, so nothing reads them, and they go with
 * their events like every other row. Deleting them would be tidier and is not
 * worth making the migration destructive for.
 *
 * Then the ordinary reconciliation over every stored day, so a day whose pair
 * had no row at all is given one now rather than on its first read. (The
 * re-key itself ran above, ahead of the Everyone reconciliation.)
 */
if (pairKeyPending) {
	reconcileAllLegs();
	markBackfillDone(PAIR_KEY_BACKFILL);
}

/**
 * The re-keying half of `PAIR_KEY_BACKFILL`, exported so a test can run it
 * against rows it wrote in the old shape. Returns how many pairs it settled.
 *
 * If a pair already has a row under the new key (written by a reconciliation
 * that ran first), the legacy row is not re-keyed, since the unique key is
 * taken, but what it carries is merged into that row: the reader's name, mode
 * and minutes, and the router's answer, each only where the new row has none.
 * Nothing is deleted either way.
 */
export function rekeyLegacyLegs(): number {
	const old = db
		.prepare(
			`SELECT id, trip_id, from_event_id, to_event_id FROM travel_legs
			  WHERE leg_key LIKE '%>%>%'
			  ORDER BY (title IS NOT NULL OR mode IS NOT NULL OR mins IS NOT NULL) DESC,
			           (auto_mins IS NOT NULL) DESC,
			           rowid DESC`
		)
		.all() as unknown as {
		id: string;
		trip_id: string;
		from_event_id: string;
		to_event_id: string;
	}[];
	const rekey = db.prepare(`UPDATE travel_legs SET leg_key = ? WHERE id = ?`);
	const current = db.prepare(`SELECT id FROM travel_legs WHERE trip_id = ? AND leg_key = ?`);
	// Only the reader's three fields move together, and only onto a row with none
	// of its own: half of one pin laid over half of another is nobody's pin.
	const mergePin = db.prepare(
		`UPDATE travel_legs
		    SET title = src.title, mode = src.mode, mins = src.mins
		   FROM (SELECT title, mode, mins FROM travel_legs WHERE id = ?) AS src
		  WHERE travel_legs.id = ?
		    AND travel_legs.title IS NULL AND travel_legs.mode IS NULL AND travel_legs.mins IS NULL`
	);
	const mergeAuto = db.prepare(
		`UPDATE travel_legs
		    SET auto_mode = src.auto_mode, auto_mins = src.auto_mins, auto_routed = src.auto_routed,
		        auto_key = src.auto_key
		   FROM (SELECT auto_mode, auto_mins, auto_routed, auto_key FROM travel_legs WHERE id = ?) AS src
		  WHERE travel_legs.id = ? AND travel_legs.auto_mins IS NULL AND src.auto_mins IS NOT NULL`
	);
	const picked = new Set<string>();
	db.exec('BEGIN');
	try {
		for (const row of old) {
			const key = legKey(row.from_event_id, row.to_event_id);
			const pair = `${row.trip_id}\u0000${key}`;
			if (picked.has(pair)) continue;
			picked.add(pair);
			const taken = current.all(row.trip_id, key) as unknown as { id: string }[];
			if (!taken.length) {
				rekey.run(key, row.id);
				continue;
			}
			for (const t of taken) {
				mergePin.run(row.id, t.id);
				mergeAuto.run(row.id, t.id);
			}
		}
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	return picked.size;
}

interface StoredLeg {
	id: string;
	leg_key: string;
	title: string | null;
	auto_mode: string | null;
	auto_mins: number | null;
	auto_routed: number;
	auto_key: string | null;
	mode: string | null;
	mins: number | null;
}

function storedLegs(tripId: string, day: string): Map<string, StoredLeg> {
	const rows = db
		.prepare(
			`SELECT id, leg_key, title, auto_mode, auto_mins, auto_routed, auto_key, mode, mins
			   FROM travel_legs
			 WHERE trip_id = ? AND day = ?`
		)
		.all(tripId, day) as unknown as StoredLeg[];
	return new Map(rows.map((r) => [r.leg_key, r]));
}

/**
 * A day's legs, placed on the clock.
 *
 * The plan is recomputed rather than read back structurally, because placement
 * needs the event times and those are here anyway; the stored row contributes
 * only the identity and the override. `resolveLeg` in core runs the routing
 * ladder (pinned, then routed, then the straight-line guess) and places the
 * journey, so a leg with no duration yet is still drawn and the client's
 * preview of the same leg resolves it the same way.
 *
 * A planned journey with no row is given one here before answering. Dropping
 * it instead, which is what this did, turned every path that changes the plan
 * without an event write (a roster change, a place or stay deleted from
 * Discover, a city removed) into travel silently vanishing from the board until
 * somebody happened to drag something on that day. The reconciliation is
 * insert-only and one plan over one day, so it is cheap enough to run on a read.
 *
 * The only thing left here is the column renaming, because the stored row is
 * snake_case and the answer is not.
 */
export function legsForDay(tripId: string, day: string): LegRow[] {
	const planned = planFor(tripId, day);
	if (!planned.length) return [];

	let stored = storedLegs(tripId, day);
	if (planned.some((leg) => !stored.has(leg.key))) {
		reconcileLegs(tripId, day, planned);
		stored = storedLegs(tripId, day);
	}

	const out: LegRow[] = [];
	for (const leg of planned) {
		const row = stored.get(leg.key);
		// Only reachable if the insert above lost a race with a delete of one of
		// the two events; showing one fewer journey beats inventing a row id the
		// client would then try to edit.
		if (!row) continue;
		// `resolveLeg` drops a routed answer whose `auto_key` no longer matches
		// the journey's two points; the key is sent on so a client previewing a
		// move applies the same rule.
		const override: LegOverride = {
			title: row.title,
			autoMode: row.auto_mode,
			autoMins: row.auto_mins,
			autoKey: row.auto_key,
			mode: row.mode,
			mins: row.mins
		};
		out.push({ id: row.id, day, ...resolveLeg(leg, override) });
	}
	return out;
}

/** The planned legs of a day, for a caller that wants to route them. */
export function plannedLegsForDay(tripId: string, day: string): PlannedLeg[] {
	return planFor(tripId, day);
}

/**
 * What the router has already answered for a day's journeys, by leg key.
 *
 * `routed` is false when the stored minutes are the straight-line estimate the
 * routing ladder fell back to, so a caller deciding whether to route again can
 * skip only the answers a real provider gave. `routeKey` is what the answer
 * was an answer to: the mode and both endpoints' coordinates, as
 * `routeKey()` in `providers/routing.ts` builds it. See `saveAutoLeg`.
 */
export function storedAutoLegs(
	tripId: string,
	day: string
): Map<
	string,
	{ autoMode: string | null; autoMins: number | null; routed: boolean; routeKey: string | null }
> {
	const out = new Map<
		string,
		{ autoMode: string | null; autoMins: number | null; routed: boolean; routeKey: string | null }
	>();
	for (const [key, r] of storedLegs(tripId, day)) {
		out.set(key, {
			autoMode: r.auto_mode,
			autoMins: r.auto_mins,
			routed: !!r.auto_routed,
			routeKey: r.auto_key
		});
	}
	return out;
}

/**
 * Record what the routing provider said. Never touches a user's own override.
 *
 * `routed` says whether a provider actually answered or the ladder fell back to
 * the straight-line estimate. It is stored so the next board load can skip a
 * journey whose real route is already known, which is what stops every load
 * re-buying every leg, while still retrying one that only has a guess.
 *
 * `routeKey` is the question the answer belongs to (mode plus both endpoints'
 * coordinates). The leg key is only the pair of events, and an event can move
 * without changing its id, so without this a 20-minute drive stayed 20 minutes
 * after one end was moved 200 km away. A row whose stored key no longer matches
 * is routed again.
 */
export function saveAutoLeg(
	tripId: string,
	day: string,
	key: string,
	mode: string,
	mins: number,
	routed = true,
	routeKey: string | null = null
): void {
	db.prepare(
		`UPDATE travel_legs SET auto_mode = ?, auto_mins = ?, auto_routed = ?, auto_key = ?
		  WHERE trip_id = ? AND day = ? AND leg_key = ?`
	).run(mode, Math.max(1, Math.round(mins)), routed ? 1 : 0, routeKey, tripId, day, key);
}

// --- Events -----------------------------------------------------------------

export interface NewEvent {
	day: string;
	/**
	 * For a stay, the checkout morning. For anything else, the day it ends on
	 * (inclusive), or null/absent for its own day.
	 */
	endDay?: string | null;
	/** A journey's arrival city, whose zone `endMin` is read in. Ignored for anything else. */
	endCityId?: string | null;
	title: string;
	type: EventType;
	startMin: number;
	/** On the last day's clock, in the arrival city's zone for a journey that names one. */
	endMin: number;
	poiId?: string | null;
	lodgingId?: string | null;
	/** A location typed by hand, used only when neither link is set. */
	placeText?: string | null;
	cityId?: string | null;
	lat?: number | null;
	lng?: number | null;
	notes?: string | null;
	travelMode?: string | null;
	people?: string[];
	/**
	 * Whether the start is the board's suggestion rather than somebody's choice.
	 *
	 * Set by an add that never pointed at a time. Everything else leaves it
	 * false, which is the safe reading: a time nobody chose is the exception.
	 */
	timeAuto?: boolean;
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
 * Where a stay would check out if it were dragged to `toDay`, or null when the
 * event is not a stay (or does not exist).
 *
 * A drag keeps the stay's length in nights, so the checkout it lands on is not
 * in the request at all: the route has to work it out to refuse a drag that
 * would carry the checkout past the end of the trip. Uses the same `nights`
 * rule `moveEvent` does, so the two cannot disagree.
 */
export function movedStayCheckout(eventId: string, toDay: string): string | null {
	const row = db.prepare(`SELECT type, day, end_day FROM events WHERE id = ?`).get(eventId) as
		{ type: string; day: string; end_day: string | null } | undefined;
	if (!row || row.type !== 'stay') return null;
	return shiftDay(toDay, nights(row));
}

/** An event's span as stored, with the trip it belongs to. */
function storedSpan(eventId: string): (SpanRow & { trip_id: string }) | null {
	const row = db
		.prepare(
			`SELECT trip_id, type, day, end_day, start_min, end_min, city_id, end_city_id
			   FROM events WHERE id = ?`
		)
		.get(eventId) as unknown as (SpanRow & { trip_id: string }) | undefined;
	return row ?? null;
}

/**
 * The stored form of a timed event's span: clamped to the clock, then put in
 * the one form `normalizeSpan` in core defines.
 *
 * Only a block on one clock on one day is held to "the end comes at least the
 * shortest block after the start", by pushing the end out, as it always was.
 * Anything else has its end on another day or another clock, where comparing
 * the two minutes means nothing; the route refuses a span that ends before it
 * starts (`spanProblem`) before it gets here, so nothing is clamped into a
 * shape somebody did not ask for.
 */
function fitSpan(
	row: SpanRow,
	zoneOf: ZoneOf
): { start_min: number; end_min: number; end_day: string | null; end_city_id: string | null } {
	const start = Math.max(0, Math.min(Math.round(row.start_min), DAY_END_MIN - MIN_EVENT_MINS));
	const raw = Math.max(0, Math.min(Math.round(row.end_min), DAY_END_MIN));
	const span = normalizeSpan({ ...row, start_min: start, end_min: raw }, zoneOf);
	const settled: SpanRow = { ...row, start_min: start, ...span };
	const end = onOneClock(settled, zoneOf)
		? Math.max(start + MIN_EVENT_MINS, Math.min(span.end_min, DAY_END_MIN))
		: span.end_min;
	return { start_min: start, end_min: end, end_day: span.end_day, end_city_id: span.end_city_id };
}

/**
 * Where a drag would put a timed event, before it is stored. Null for a stay,
 * which moves by nights (`movedStayCheckout`), or an event that does not exist.
 *
 * A block on one clock on one day keeps its length inside the day, clamped so
 * it cannot be dragged off the end, exactly as before. A block whose end is on
 * another day is moved as a whole instead: both ends shift by the same
 * minutes, so a drag across days moves `end_day` by the same number of days
 * and a drag along the clock keeps the real length, the way a phone calendar
 * moves an overnight event. A journey whose ends are on two clocks is not
 * dragged at all (`movable`). The route checks the answer against the
 * trip and `spanProblem` before `moveEvent` writes it; both call this, so the
 * check and the write cannot disagree.
 */
export function movedSpan(eventId: string, startMin: number, toDay?: string): SpanRow | null {
	const row = storedSpan(eventId);
	if (!row || row.type === 'stay') return null;
	const zoneOf = tripZones(row.trip_id);
	const day = toDay ?? row.day;
	const snapped = Math.round(startMin / SNAP) * SNAP;
	if (onOneClock(row, zoneOf)) {
		const duration = row.end_min - row.start_min;
		const start = Math.max(0, Math.min(snapped, DAY_END_MIN - duration));
		return { ...row, day, end_day: null, start_min: start, end_min: start + duration };
	}
	const start = Math.max(0, Math.min(snapped, DAY_END_MIN - MIN_EVENT_MINS));
	// Minutes from the old first day's midnight, so one sum carries both the
	// day and the clock: the end lands wherever the start's shift takes it.
	const shift = daysBetween(row.day, day) * DAY_END_MIN + (start - row.start_min);
	const endAt = daysBetween(row.day, lastDayOf(row)) * DAY_END_MIN + row.end_min + shift;
	const endIndex = Math.floor(endAt / DAY_END_MIN);
	return {
		...row,
		day,
		start_min: start,
		end_day: shiftDay(row.day, endIndex),
		end_min: endAt - endIndex * DAY_END_MIN
	};
}

/** The fields of an edit that bear on where an event sits in time. */
export interface SpanChange {
	type?: string;
	day?: string;
	endDay?: string | null;
	startMin?: number;
	endMin?: number;
	/** The city whose zone the start is read in. Absent keeps the stored one. */
	cityId?: string;
	endCityId?: string | null;
}

/**
 * The span an edit would leave an event with, before it is clamped or stored.
 * Null when the event does not exist.
 *
 * The route judges this (`spanProblem`, the trip's dates) and `editEvent`
 * stores it, so both read the edit the same way. Absent fields keep what is
 * stored, as everywhere in an edit, with two rules that are about the span:
 *
 * - A day change with no `endDay` carries the end day with it, so a two-day
 *   hike moved to Friday still ends on Saturday rather than collapsing.
 * - Leaving a stay leaves its checkout behind: a block that is no longer a
 *   stay ends on its own day unless the edit says otherwise.
 *
 * `endDay: null` is "its own day". `endCityId` is only a journey's, and any
 * other type has none whatever was sent.
 */
export function editedSpan(eventId: string, change: SpanChange): SpanRow | null {
	const cur = storedSpan(eventId);
	if (!cur) return null;
	const type: EventType = change.type && isEventType(change.type) ? change.type : cur.type;
	const day = change.day ?? cur.day;
	const start_min = Number.isFinite(change.startMin) ? (change.startMin as number) : cur.start_min;
	const end_min = Number.isFinite(change.endMin) ? (change.endMin as number) : cur.end_min;
	const base = { type, day, start_min, end_min, city_id: change.cityId ?? cur.city_id ?? null };
	// A stay's dates have rules of their own (`editEvent`); span checks pass it.
	if (type === 'stay') return { ...base, end_day: cur.end_day, end_city_id: null };
	let end_day: string | null;
	if (change.endDay !== undefined) end_day = change.endDay;
	else if (cur.type === 'stay') end_day = null;
	else if (isMultiDay(cur)) end_day = shiftDay(cur.end_day!, daysBetween(cur.day, day));
	else end_day = null;
	const end_city_id =
		type !== 'travel'
			? null
			: change.endCityId !== undefined
				? change.endCityId
				: (cur.end_city_id ?? null);
	return { ...base, end_day, end_city_id };
}

/**
 * Whether an event can be resized from its bottom edge, or null when it does
 * not exist.
 *
 * Only a block on one clock on one day can. The edge under the pointer is a
 * minute on the day being looked at, and for a block that ends on another day
 * or on another city's clock that minute is not the stored end; turning one
 * into the other from a drag is a guess, so the board does not offer the
 * handle and the route refuses it. Such a block is changed in its dialog.
 */
export function resizable(eventId: string): boolean | null {
	const row = storedSpan(eventId);
	if (!row) return null;
	return onOneClock(row, tripZones(row.trip_id));
}

/**
 * Whether an event can be dragged, or null when it does not exist.
 *
 * Everything can but a journey whose two ends are on different clocks. Its
 * departure is a minute on one city's clock and the board draws it on the
 * arrival's (see `segmentOn`), so the minute a drag lands on is a reading of
 * neither end; and shifting both ends by the same wall-clock minutes across a
 * DST change in only one of the zones would change how long the flight is. A
 * span on one clock (the two-day hike) still moves as a whole. Such a journey
 * is changed in its dialog, as its end is.
 */
export function movable(eventId: string): boolean | null {
	const row = storedSpan(eventId);
	if (!row) return null;
	return !crossesZones(row, tripZones(row.trip_id));
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
 * where it now is. A block that runs over several days is planned on each of
 * them and the morning after its last, so it is the same: callers pass its old
 * and new `end_day` too. A block on one day passes nothing and gets the two
 * days it always got.
 */
function touched(tripId: string, day: string, ...alsoNulls: (string | null | undefined)[]): void {
	settleDays(tripId, [day, ...alsoNulls.filter((d): d is string => !!d)]);
	publish(tripId, 'schedule');
}

/**
 * Re-plan and reflow every day from the earliest of `days` to one past the
 * latest. The shared body of `touched` and the two exported entry points below.
 */
function settleDays(tripId: string, days: string[]): void {
	if (!days.length) return;
	const sorted = [...days].sort();
	const last = sorted[sorted.length - 1];
	const range: string[] = [];
	// One past the end, because the morning after a stay leaves it.
	for (let d = sorted[0]; d <= shiftDay(last, 1); d = shiftDay(d, 1)) range.push(d);
	settleEach(tripId, range);
}

/** Re-plan and reflow each of `days` once, in order. */
function settleEach(tripId: string, days: readonly string[]): void {
	for (const d of days) {
		recomputeLegs(tripId, d);
		// A suggested block follows the journey that arrives at it, so it can only
		// be placed once the journeys are settled; moving it then changes the
		// chain, so the journeys are settled again afterwards.
		if (reflowDay(tripId, d)) recomputeLegs(tripId, d);
	}
}

/**
 * Every day a set of event spans can have changed the plan of, each once.
 *
 * A span covers its own day through its checkout, plus the morning after,
 * which planned its first journey from the night. A timed block's `end_day` is
 * its last day rather than a checkout, and it is settled the same way: every
 * day it is on, plus the morning after, whose people start from where it left
 * them. Spans overlap (every block on a day is a span of that day and the
 * next), so settling span by span did most days two or three times over; this
 * is the union, sorted.
 */
function daysOfSpans(spans: readonly { day: string; end_day: string | null }[]): string[] {
	const days = new Set<string>();
	for (const s of spans) {
		const last = shiftDay(s.end_day && s.end_day > s.day ? s.end_day : s.day, 1);
		for (let d = s.day; d <= last; d = shiftDay(d, 1)) days.add(d);
	}
	return [...days].sort();
}

/**
 * Settle days after a write that has already committed, without letting the
 * settle fail that write.
 *
 * The callers (a roster change, a delete from Discover, a stay learning where
 * it is) have finished their own work before this runs, and the member who
 * made the request should not be told it failed because a re-plan behind it
 * did. So the whole settle is one unit, a SAVEPOINT (which nests inside a
 * transaction a caller may hold, and is a transaction of its own otherwise),
 * rolled back on any error and logged rather than thrown. Nothing is lost by
 * that: `legsForDay` reconciles on read, so the worst case is a suggested time
 * that waits for the next write to reflow.
 */
function settleQuietly(tripId: string, days: readonly string[], why: string): void {
	if (!days.length) return;
	db.exec('SAVEPOINT settle_schedule');
	try {
		settleEach(tripId, days);
		db.exec('RELEASE settle_schedule');
	} catch (err) {
		try {
			db.exec('ROLLBACK TO settle_schedule');
			db.exec('RELEASE settle_schedule');
		} catch {
			/* the savepoint is already gone; nothing left to undo */
		}
		console.error(
			`[schedule] settling ${days.length} day(s) after ${why} failed for trip ${tripId}; reads will reconcile`,
			err
		);
	}
}

/**
 * Settle the days some events covered, for a write that changed them outside
 * this module: a place or stay deleted from Discover takes its events with it,
 * and a stay given coordinates it did not have starts planning journeys.
 *
 * Only the days the spans touch are settled, each once, rather than one range
 * from the earliest day to the latest, because the events a place had can be
 * months apart and the days between them did not change. Never throws; see
 * `settleQuietly`. Does not publish: the caller already publishes the topics
 * its write touched, `schedule` among them.
 */
export function settleEventSpans(
	tripId: string,
	spans: readonly { day: string; end_day: string | null }[]
): void {
	settleQuietly(tripId, daysOfSpans(spans), 'an event change');
}

/**
 * Settle every day of a trip that carries an event, for a roster change.
 *
 * Joining, leaving, being removed and being merged into a real account all
 * change who "Everyone" is, and so which journeys exist and when a suggested
 * block can start, on every day at once. None of them is an event write, so
 * nothing else would notice until somebody dragged something. Each day is
 * settled once, in one savepoint, and a failure is logged rather than failing
 * the roster change, which has already committed (see `settleQuietly`).
 *
 * Does not publish, for the same reason as `settleEventSpans`.
 */
export function settleTrip(tripId: string): void {
	const spans = db
		.prepare(`SELECT DISTINCT day, end_day FROM events WHERE trip_id = ?`)
		.all(tripId) as unknown as { day: string; end_day: string | null }[];
	settleQuietly(tripId, daysOfSpans(spans), 'a roster change');
}

/**
 * The spans of the events a delete is about to take, read before it runs.
 *
 * For a caller that removes events by something other than their id (a place,
 * a stay option, a city), so it can hand the answer to `settleEventSpans` once
 * the rows are gone.
 */
export function eventSpansWhere(
	tripId: string,
	column: 'poi_id' | 'lodging_id',
	ids: readonly string[]
): { day: string; end_day: string | null }[] {
	if (!ids.length) return [];
	return db
		.prepare(
			`SELECT DISTINCT day, end_day FROM events
			  WHERE trip_id = ? AND ${column} IN (${ids.map(() => '?').join(',')})`
		)
		.all(tripId, ...ids) as unknown as { day: string; end_day: string | null }[];
}

/**
 * Before a city is deleted: keep every journey it was a clock of true, and
 * return the spans of every event that names it, for `settleEventSpans` once
 * the city is gone. Call it inside the delete's transaction, while the city's
 * zone can still be read.
 *
 * The delete nulls `city_id` and `end_city_id` (ON DELETE SET NULL), and a
 * null city is read as UTC. For most blocks that changes nothing anybody sees:
 * both ends were on one clock and still are. A journey whose ends were on two
 * clocks is different: its stored minutes would silently become a different
 * instant, and "depart 22:00 Athens, arrive 15:00 Tokyo" with Tokyo gone would
 * read as a flight landing six hours later than the ticket says. So such a
 * journey is re-read at the same instants onto the clock that remains:
 *
 * - arrival city deleted: the end is re-read on the departure clock (15:00
 *   Tokyo becomes 09:00 Athens), and the journey is on one clock from then on
 * - departure city deleted: the start is re-read on the arrival clock and the
 *   arrival city becomes its city, which can move its `day` when the two
 *   clocks are on different dates at that instant
 *
 * Either way the row stays readable and every check it passed still holds, and
 * the version is bumped so a dialog opened before the delete cannot write the
 * old clock back.
 */
export function releaseCity(
	tripId: string,
	cityId: string
): { day: string; end_day: string | null }[] {
	const rows = db
		.prepare(
			`SELECT id, type, day, end_day, start_min, end_min, city_id, end_city_id FROM events
			  WHERE trip_id = ? AND (city_id = ? OR end_city_id = ?)`
		)
		.all(tripId, cityId, cityId) as unknown as (SpanRow & { id: string })[];
	const zoneOf = tripZones(tripId);
	const spans: { day: string; end_day: string | null }[] = rows.map((r) => ({
		day: r.day,
		end_day: r.end_day
	}));
	const write = db.prepare(
		`UPDATE events SET day = ?, end_day = ?, start_min = ?, end_min = ?, city_id = ?,
		        end_city_id = NULL, time_auto = 0, version = version + 1
		  WHERE id = ?`
	);
	for (const row of rows) {
		if (row.type !== 'travel' || !crossesZones(row, zoneOf)) continue;
		const from = zoneOf(row.city_id);
		const to = zoneOf(row.end_city_id);
		let next: SpanRow;
		if (row.end_city_id === cityId) {
			const end = reclock(lastDayOf(row), row.end_min, to, from);
			next = { ...row, end_day: end.day, end_min: end.minutes, end_city_id: null };
		} else {
			const start = reclock(row.day, row.start_min, from, to);
			next = {
				...row,
				day: start.day,
				start_min: start.minutes,
				city_id: row.end_city_id,
				end_city_id: null
			};
		}
		const span = normalizeSpan(next, zoneOf);
		write.run(next.day, span.end_day, next.start_min, span.end_min, next.city_id ?? null, row.id);
		spans.push({ day: next.day, end_day: span.end_day });
	}
	return spans;
}

/** An event's current version, or null when it does not exist. */
export function eventVersion(eventId: string): number | null {
	const row = db.prepare(`SELECT version FROM events WHERE id = ?`).get(eventId) as
		{ version: number } | undefined;
	return row?.version ?? null;
}

/**
 * The city a block linked to a place is in: the place's own, or null when it
 * has no link (or is a journey, or free time).
 *
 * A block's `city_id` is the zone its start is read in, and the planner reads
 * it to put a day on two clocks in real order (`dayInstants` in core). The day's
 * city is a guess about the whole day; a saved place belongs to one city for
 * certain. So a lunch linked to a Los Angeles place on the day a flight leaves
 * Tokyo is in Los Angeles, whatever the dialog sent, and is walked after the
 * flight rather than before it. A stay's link is its lodging option, anything
 * else's its saved place.
 *
 * A journey keeps the city it is given: its place is where it lands, and its
 * city is where it departs, which is the one thing a link cannot say.
 */
function linkedCity(
	type: EventType,
	poiId: string | null | undefined,
	lodgingId: string | null | undefined
): string | null {
	if (type === 'travel' || type === 'freetime') return null;
	const row =
		type === 'stay'
			? lodgingId
				? db.prepare(`SELECT city_id FROM lodging_options WHERE id = ?`).get(lodgingId)
				: undefined
			: poiId
				? db.prepare(`SELECT city_id FROM pois WHERE id = ?`).get(poiId)
				: undefined;
	return (row as { city_id: string } | undefined)?.city_id ?? null;
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
	// The place's city wins over whatever city was sent, for anything but a
	// journey: see `linkedCity`.
	const cityId =
		linkedCity(
			type,
			located ? (e.poiId ?? null) : null,
			type === 'stay' ? (e.lodgingId ?? null) : null
		) ??
		e.cityId ??
		null;
	let start = Math.max(0, Math.min(Math.round(e.startMin), DAY_END_MIN - MIN_EVENT_MINS));
	let end = Math.max(start + MIN_EVENT_MINS, Math.min(Math.round(e.endMin), DAY_END_MIN));
	let endDay = stayEnd(type, e.day, e.endDay);
	let endCity: string | null = null;
	// Whether the start can be the board's suggestion: only on one clock on one
	// day, because the reflow that moves a suggestion only speaks one day.
	let oneClock = type !== 'stay';
	if (type !== 'stay') {
		const zoneOf = tripZones(tripId);
		const row: SpanRow = {
			type,
			day: e.day,
			end_day: e.endDay ?? null,
			start_min: e.startMin,
			end_min: e.endMin,
			city_id: cityId,
			end_city_id: e.endCityId ?? null
		};
		const fit = fitSpan(row, zoneOf);
		start = fit.start_min;
		end = fit.end_min;
		endDay = fit.end_day;
		endCity = fit.end_city_id;
		oneClock = onOneClock({ ...row, ...fit }, zoneOf);
	}

	const id = randomUUID();
	// A typed location is only ever the answer when nothing was picked: a link
	// carries coordinates and a typed name does not, so keeping both would leave
	// the row saying two different things about where the event is.
	const linked = located && (e.poiId || (type === 'stay' && e.lodgingId));
	db.prepare(
		`INSERT INTO events
		 (id, trip_id, day, end_day, title, type, start_min, end_min, poi_id, lodging_id, place_text, city_id, end_city_id, lat, lng, notes, travel_mode, time_auto, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
		located && !linked ? e.placeText?.trim() || null : null,
		cityId,
		endCity,
		located ? (e.lat ?? null) : null,
		located ? (e.lng ?? null) : null,
		e.notes?.trim() || null,
		type === 'travel' && e.travelMode && isTransportMode(e.travelMode) ? e.travelMode : null,
		// A stay is not on a clock, so there is no suggested start to follow; nor
		// is a block that ends on another day or another clock, whose start is
		// the one fact about it nobody would want the board to move.
		e.timeAuto && oneClock ? 1 : 0,
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

/**
 * Move an event to a new start, keeping its length. Snaps and clamps to the day.
 *
 * Dragging a block is somebody choosing where it goes, so it stops being a
 * suggestion and stops following the day. A block that runs over several days
 * moves as a whole, its end day and end clock carried by the same shift; see
 * `movedSpan`, which is also what the route checked.
 *
 * The version is bumped but never checked. A drag carries one field, so there
 * is nothing stale riding along for it to overwrite and no reason to refuse it;
 * but a dialog opened on the block before the drag carries the old clock, and
 * without the bump its save would put the block back where it was with nobody
 * the wiser. `eventVersion` reads the new number for a caller that wants it.
 */
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

	if (!movable(eventId)) return false;
	const span = movedSpan(eventId, startMin, toDay);
	if (span) {
		const fit = fitSpan(span, tripZones(tripId));
		db.prepare(
			`UPDATE events SET start_min = ?, end_min = ?, day = ?, end_day = ?, time_auto = 0,
			        version = version + 1 WHERE id = ?`
		).run(fit.start_min, fit.end_min, span.day, fit.end_day, eventId);
		touched(tripId, where.day, where.end_day, span.day, fit.end_day);
		return true;
	}

	const snapped = Math.round(startMin / SNAP) * SNAP;
	const duration = ev.end_min - ev.start_min;
	const clamped = Math.max(0, Math.min(snapped, DAY_END_MIN - duration));
	// A stay is not dragged: it is a band rather than a block, and its length is
	// in nights. A move that lands on another day still has to carry the
	// checkout with it, or the range would invert.
	const movedEnd = where.end_day && toDay ? shiftDay(toDay, nights(where)) : where.end_day;
	db.prepare(
		`UPDATE events SET start_min = ?, end_min = ?, day = COALESCE(?, day), end_day = ?, time_auto = 0,
		        version = version + 1 WHERE id = ?`
	).run(clamped, clamped + duration, toDay ?? null, movedEnd, eventId);
	touched(tripId, where.day, where.end_day, toDay, movedEnd);
	return true;
}

/** How many nights a stay runs for, which a move has to preserve. */
function nights(where: { day: string; end_day: string | null }): number {
	if (!where.end_day) return 1;
	return Math.max(1, daysBetween(where.day, where.end_day));
}

/**
 * Resize an event by moving its end. Snaps and clamps to the day.
 *
 * Refused (false) for a block that is not on one clock on one day: see
 * `resizable`, which the route asks first so it can say why.
 *
 * Bumps the version without checking it, for the reason `moveEvent` gives.
 */
export function resizeEvent(
	eventId: string,
	userId: string,
	endMin: number,
	tripId: string
): boolean {
	const where = mayEdit(eventId, userId, tripId);
	if (!where) return false;
	if (!resizable(eventId)) return false;
	const ev = db.prepare(`SELECT start_min FROM events WHERE id = ?`).get(eventId) as
		{ start_min: number } | undefined;
	if (!ev) return false;
	const snapped = Math.round(endMin / SNAP) * SNAP;
	const clamped = Math.max(ev.start_min + MIN_EVENT_MINS, Math.min(snapped, DAY_END_MIN));
	db.prepare(`UPDATE events SET end_min = ?, version = version + 1 WHERE id = ?`).run(
		clamped,
		eventId
	);
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
	 * The day the block sits on, and for a stay the morning it is left.
	 *
	 * A stay is the one block that is not on a clock: it is a range of nights,
	 * so this pair is how it is moved and lengthened, and `startMin`/`endMin` do
	 * not apply to it. Everything else starts on `day`, and a new `day` moves it
	 * there without touching its clock, carrying its end day by the same number
	 * of days. Absent leaves the date alone.
	 *
	 * For anything but a stay, `endDay` is the day it ends on (inclusive), null
	 * for its own day, and absent to keep the end day it has (moved with `day`).
	 */
	day?: string;
	endDay?: string | null;
	/**
	 * A journey's arrival city. Absent leaves it alone, null clears it, and any
	 * other type has none whatever is sent.
	 */
	endCityId?: string | null;
	/**
	 * The city the block starts in, whose zone `startMin` is read in: for a
	 * journey, where it departs from. Absent leaves it alone. The route checks
	 * it is one of the trip's cities.
	 */
	cityId?: string;
	/**
	 * Where this event happens, already resolved by the caller.
	 *
	 * Absent leaves it alone, null clears it. A resolved saved place carries its
	 * coordinates, because the chain is planned off the event's own lat/lng and a
	 * link without them would put the event nowhere while claiming a place. A
	 * location that was typed instead carries `text` and no coordinates, which is
	 * the honest record of a name nobody has geocoded.
	 */
	place?: {
		poiId?: string;
		lodgingId?: string;
		text?: string;
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
 * The name of the place an event is linked to, for an edit that leaves the link
 * alone.
 *
 * Deriving a name needs the place, and the dialog only sends `poiId` when the
 * picker actually moved, so for every other save the route has no place to
 * derive from and would fall through to the notes or the type's noun. Clearing
 * a label on an event that sits at a saved place would then rename it off that
 * place, which is the one thing clearing it is meant to restore.
 */
export function currentPlaceName(eventId: string): string {
	const row = db
		.prepare(
			`SELECT COALESCE(p.name, l.name, e.place_text, '') AS name
			   FROM events e
			   LEFT JOIN pois p ON p.id = e.poi_id
			   LEFT JOIN lodging_options l ON l.id = e.lodging_id
			  WHERE e.id = ?`
		)
		.get(eventId) as { name: string } | undefined;
	return row?.name ?? '';
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
		{ version: number } | undefined;
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
			sets.push(
				'lat = NULL',
				'lng = NULL',
				'poi_id = NULL',
				'lodging_id = NULL',
				'place_text = NULL'
			);
		}
	}
	if (edit.notes !== undefined) {
		sets.push('notes = ?');
		args.push(edit.notes?.trim() || null);
	}
	// Free time has just cleared its place above, and re-setting one here would
	// undo that in the same statement.
	if (edit.place !== undefined && edit.type !== 'freetime') {
		// All four are always written, because an event is somewhere for exactly
		// one reason: the two links are exclusive of each other, and a typed name
		// is exclusive of both. Re-typing a block from an activity to a stay has
		// to release the museum as it takes the hotel, or the Discover card would
		// keep counting it, and picking a saved place has to drop the name that
		// was typed before it.
		if (edit.place) {
			sets.push('poi_id = ?', 'lodging_id = ?', 'place_text = ?', 'lat = ?', 'lng = ?');
			args.push(edit.place.poiId ?? null, edit.place.lodgingId ?? null);
			args.push(edit.place.text?.trim() || null);
			args.push(edit.place.lat, edit.place.lng);
		} else {
			sets.push(
				'poi_id = NULL',
				'lodging_id = NULL',
				'place_text = NULL',
				'lat = NULL',
				'lng = NULL'
			);
		}
	}
	if (edit.travelMode !== undefined) {
		sets.push('travel_mode = ?');
		args.push(edit.travelMode && isTransportMode(edit.travelMode) ? edit.travelMode : null);
	}
	const storedType = currentType(eventId);
	const nextType: EventType =
		edit.type && isEventType(edit.type)
			? edit.type
			: isEventType(storedType)
				? storedType
				: 'activity';
	// The city the block starts in. Every block made before the start city was
	// the day's city carries the trip's first one, so a flight out of Tokyo can
	// be stored as leaving Los Angeles, and its arrival in Los Angeles then reads
	// as no arrival at all. This is how that is corrected; the span below is
	// settled against the new city, so the arrival it is sent with survives.
	//
	// A block that is not a journey and is linked to a place is in that place's
	// city instead, whatever was sent (`linkedCity`), and is re-derived whenever
	// the edit touches the link or the type: relinking a lunch to a place in
	// another city moves the clock its start is read on with it.
	let cityId = edit.cityId;
	if (edit.place !== undefined || edit.type !== undefined || edit.cityId !== undefined) {
		const link =
			edit.place !== undefined
				? { poi: edit.place?.poiId ?? null, lodging: edit.place?.lodgingId ?? null }
				: (() => {
						const row = db
							.prepare(`SELECT poi_id, lodging_id FROM events WHERE id = ?`)
							.get(eventId) as { poi_id: string | null; lodging_id: string | null } | undefined;
						return { poi: row?.poi_id ?? null, lodging: row?.lodging_id ?? null };
					})();
		cityId = linkedCity(nextType, link.poi, link.lodging) ?? cityId;
	}
	if (cityId !== undefined) {
		sets.push('city_id = ?');
		args.push(cityId);
	}
	let movedTo: string | null = null;
	let movedEnd: string | null = null;
	const timeSent =
		(edit.startMin !== undefined && Number.isFinite(edit.startMin)) ||
		(edit.endMin !== undefined && Number.isFinite(edit.endMin));
	if (nextType === 'stay') {
		// Both ends move together, because an event has to occupy real time on its
		// own day: a stay used to be exempt, and is not any more. Whichever end the
		// caller left out is read back from the row so a lone edit still cannot
		// invert it.
		if (timeSent) {
			const cur = db.prepare(`SELECT start_min, end_min FROM events WHERE id = ?`).get(eventId) as
				{ start_min: number; end_min: number } | undefined;
			if (!cur) return missing;
			const wanted = Number.isFinite(edit.startMin as number)
				? (edit.startMin as number)
				: cur.start_min;
			const start = Math.max(0, Math.min(Math.round(wanted), DAY_END_MIN - MIN_EVENT_MINS));
			const wantedEnd = Number.isFinite(edit.endMin as number)
				? (edit.endMin as number)
				: cur.end_min;
			const end = Math.max(start + MIN_EVENT_MINS, Math.min(Math.round(wantedEnd), DAY_END_MIN));
			sets.push('start_min = ?', 'end_min = ?');
			args.push(start, end);
			if (start !== cur.start_min) sets.push('time_auto = 0');
		}
		// A stay is moved by its dates rather than by its clock. Both ends are
		// written together so a range can never invert: a checkout on or before the
		// arrival becomes the morning after it, which is the shortest real stay.
		if (edit.day || edit.endDay) {
			movedTo = edit.day || where.day;
			movedEnd = stayEnd('stay', movedTo, edit.endDay ?? where.end_day) as string;
			sets.push('day = ?', 'end_day = ?');
			args.push(movedTo, movedEnd);
		} else if (edit.type === 'stay' && !where.end_day) {
			sets.push('end_day = ?');
			args.push(shiftDay(where.day, 1));
		}
		// A block that becomes a stay keeps an end day it had as its checkout: a
		// hike over Friday to Sunday becomes a stay drawn on the same three days,
		// two nights, which is the nearest thing to what was on the board. Only
		// a journey has an arrival city.
		if (edit.type === 'stay') sets.push('end_city_id = NULL');
	} else if (
		timeSent ||
		edit.type !== undefined ||
		edit.day !== undefined ||
		edit.endDay !== undefined ||
		edit.endCityId !== undefined ||
		cityId !== undefined
	) {
		/* Every other block is a span: a start on its day, an end on its end day,
		   read on its own clock and, for a journey, the arrival city's. The edit
		   is merged with the row by `editedSpan` (which the route has already
		   judged) and settled into the one stored form, all five columns at once
		   so they can never describe two different spans. */
		const cur = storedSpan(eventId);
		const span = editedSpan(eventId, {
			type: edit.type,
			day: edit.day,
			endDay: edit.endDay,
			startMin: edit.startMin,
			endMin: edit.endMin,
			cityId,
			endCityId: edit.endCityId
		});
		if (!cur || !span) return missing;
		const zoneOf = tripZones(tripId);
		const fit = fitSpan(span, zoneOf);
		sets.push('day = ?', 'end_day = ?', 'end_city_id = ?', 'start_min = ?', 'end_min = ?');
		args.push(span.day, fit.end_day, fit.end_city_id, fit.start_min, fit.end_min);
		// Typing a time is choosing one, so the block stops following the day.
		// Compared against the stored start rather than merely being present,
		// because the edit dialog restates every field it shows: saving a change
		// of place would otherwise pin a time the reader never looked at. Choosing
		// a date is not choosing a time either, so a block still following its day
		// goes on following the day it has moved to. A block that now ends on
		// another day or another clock is never a suggestion.
		if (fit.start_min !== cur.start_min || !onOneClock({ ...span, ...fit }, zoneOf)) {
			sets.push('time_auto = 0');
		}
		if (span.day !== where.day) movedTo = span.day;
		movedEnd = fit.end_day;
	}

	if (!sets.length) return missing;

	const next = current.version + 1;
	sets.push('version = ?');
	args.push(next);

	args.push(eventId);
	db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...args);
	touched(tripId, where.day, where.end_day, movedTo, movedEnd);
	// Read back rather than `next`: settling the day can reflow this very block
	// (it is still a suggestion when the edit did not change its start), and a
	// reflow bumps the version too. Handing back `next` would leave the dialog
	// holding a number its own next save is refused against.
	return written(eventVersion(eventId) ?? next);
}

/**
 * Replace who is on an event. This is what makes the group split, or rejoin.
 *
 * Bumps the version without checking it. The people picker saves on its own
 * request, after the dialog's edit, so checking would have the dialog refuse
 * its own second write; not bumping would let a dialog opened before the change
 * write back a record that no longer matches who is on the block. The caller
 * reads the new number with `eventVersion`.
 */
export function setEventPeople(
	eventId: string,
	tripId: string,
	userId: string,
	people: string[]
): boolean {
	const where = mayEdit(eventId, userId, tripId);
	if (!where) return false;
	writePeople(eventId, tripId, people);
	db.prepare(`UPDATE events SET version = version + 1 WHERE id = ?`).run(eventId);
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
