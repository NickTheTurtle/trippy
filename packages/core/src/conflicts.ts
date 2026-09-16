/**
 * Is anybody booked to be in two places at once?
 *
 * Events carry people rather than lanes (see `travel.ts` and DESIGN M3.1), so
 * the model can finally represent the mistake the old track model made
 * impossible: one person on two events at the same time, or on two events far
 * enough apart that the gap between them will not cover the journey. Being able
 * to represent it is the reason this module has to detect it.
 *
 * Two kinds, and they are genuinely different claims:
 *
 *  - `overlap`: the same person is on two events whose times intersect. That is
 *    a fact about the day as authored, and needs nothing from a router.
 *  - `travel`: the same person is on two events at different places, and the
 *    gap between the end of the first and the start of the second is shorter
 *    than the journey between them. That is a fact about the day *plus* an
 *    estimate, which is why the estimate is an input rather than something this
 *    module works out for itself (see `ConflictOptions.travelMins`).
 *
 * Everything here is pure: no clock, no I/O, no roster lookup. It is handed
 * events and hands back structure. Wording belongs to the client, so nothing
 * here returns a sentence.
 */

import { haversineKm } from './geo';
import { rangesOverlap } from './layout';
import { SAME_PLACE_KM } from './travel';
import { zonedMinutesToUtc } from './tz';
import type { EventType } from './types';

/**
 * An event as the conflict check needs to see it.
 *
 * It is `PlannerEvent` plus the two fields that make times comparable across a
 * border: the calendar day the wall clock belongs to, and the zone that wall
 * clock is read in. `planLegs` can do without them because it only ever works
 * inside one day of one board; this cannot, because the whole question is
 * whether two events happen at the same instant, and on the day the group flies
 * east the later-looking clock time is the earlier instant.
 */
export interface ConflictEvent {
	id: string;
	type: EventType;
	/** `YYYY-MM-DD`, the calendar day the wall clock below belongs to. */
	day: string;
	/** Minutes from midnight on `day`, local to `tz`. */
	startMin: number;
	/** Minutes from midnight on `day`, local to `tz`. May be 1440 for midnight. */
	endMin: number;
	/**
	 * IANA zone of the event's city, e.g. `Europe/Athens`.
	 *
	 * Absent or null reads as UTC. That is a consistent frame, not a correct
	 * one: a day whose events all lack a zone still compares sanely within
	 * itself, but a caller that knows the zones must pass them, because mixing
	 * a zoned event with an unzoned one silently compares Athens time to UTC.
	 */
	tz?: string | null;
	lat: number | null;
	lng: number | null;
	/**
	 * Exactly the user ids on this event. No id here means nobody, never
	 * everybody.
	 *
	 * This is deliberately the same contract as `PlannerEvent.people`, and for
	 * the same reason. Storage writes "Everyone" as an empty list, because a
	 * stored roster copy stops meaning everyone the moment somebody joins; the
	 * expansion back to the roster happens at the layer that has a roster to
	 * expand against (`toPlanner` in `packages/server/src/persistence/schedule.ts`,
	 * and the board's own attendee resolution before it lays a day out). Core is
	 * pure and has no trip to ask.
	 *
	 * The alternative, reading an empty list here as "everyone", was rejected on
	 * both a design and a practical ground. The design ground: it would put the
	 * "empty means everyone" rule in a second place, and the two copies would be
	 * free to disagree. The practical one is worse. Callers already expand, so
	 * expanding again here would be harmless, but a caller that passed the
	 * stored form straight through would have every unassigned event carrying
	 * the whole trip, and since most events are left on Everyone that produces a
	 * warning on nearly every pair of events on the day. A warning that is
	 * always on is worse than no warning at all, so the failure mode of the rule
	 * chosen here is silence (an unexpanded day reports nothing) rather than
	 * noise.
	 */
	people: string[];
}

/**
 * How long the journey between two events takes, in minutes.
 *
 * Supplied by the caller, never computed here. The board already knows: a
 * planned leg carries `resolvedMins`, which is the user's override, else what
 * the routing provider said, else the straight-line guess. Re-deriving a number
 * inside the detector would mean warning about a journey with one duration
 * while the same board draws it with another, and it would bake in whichever
 * estimator happened to be handy, including a wrong one.
 *
 * `km` is the straight-line distance, passed along so a caller that only wants
 * a rough answer can produce one (`guessLeg(km).mins`) without measuring again.
 *
 * Returning null or undefined means "no estimate", and no travel conflict is
 * reported for that pair. A missing warning is honest; a warning built on a
 * number nobody stands behind is not.
 */
export type TravelMinsFn = (
	from: ConflictEvent,
	to: ConflictEvent,
	km: number
) => number | null | undefined;

export interface ConflictOptions {
	/** Omit it and only overlaps are reported. */
	travelMins?: TravelMinsFn;
}

/** One person on two events that happen at the same time. */
export interface OverlapConflict {
	kind: 'overlap';
	/** Sorted ids of everyone on both events. */
	people: string[];
	/** The event that starts first. */
	firstEventId: string;
	secondEventId: string;
	/** How many minutes the two share. Always at least 1. */
	overlapMins: number;
}

/** One person who cannot get from the first event to the second in the gap. */
export interface TravelConflict {
	kind: 'travel';
	people: string[];
	firstEventId: string;
	secondEventId: string;
	/** What the caller's estimate says the journey takes. */
	requiredMins: number;
	/** Gap between the end of the first event and the start of the second. */
	availableMins: number;
	/** `requiredMins - availableMins`, always at least 1. */
	shortfallMins: number;
}

export type ScheduleConflict = OverlapConflict | TravelConflict;

/** An event with its wall clock resolved to absolute minutes. */
interface Stamped {
	ev: ConflictEvent;
	start: number;
	end: number;
}

/**
 * Whether an event takes part in the check at all.
 *
 * Only a `stay` is out. It is a range of nights rather than a slot on the
 * clock: the board draws it as a band above the day, and the minute it carries
 * (`STAY_CHECK_IN`) is a drawing anchor, not a promise to be in the room.
 * Counting it would report that last night's hotel collides with every event of
 * the next morning, which is both wrong and unignorable, and the
 * night-versus-day split in `staysCovering` / `staysOnBoard` already says that
 * the band is not a booking on the clock. Dropping it here rather than skipping
 * it inside the walk also means it cannot interrupt a chain it is not part of.
 *
 * `freetime` stays in the list but is excluded from the overlap check below: it
 * is the explicit absence of a plan, so nothing can be double booked against
 * it, but it still ends a travel chain, because nobody has said where the
 * person will be when it finishes.
 *
 * `travel` is in for both. A journey is a real commitment with a real duration,
 * and being on a ferry during a museum booking is exactly the double booking
 * this module exists to find. What a travel event is exempt from is being the
 * far end of a travel check, which is a separate rule below.
 */
function isCommitment(e: ConflictEvent): boolean {
	return e.type !== 'stay';
}

function located(e: ConflictEvent): boolean {
	return e.lat != null && e.lng != null;
}

/** Sorted unique ids, so a conflict reads the same however it was assembled. */
function peopleOf(ids: Iterable<string>): string[] {
	return [...new Set(ids)].sort();
}

/**
 * Every conflict a day's events imply, one entry per pair of events.
 *
 * `events` is everything drawn on the day, in stored form except that `people`
 * must already be the resolved attendee list (see `ConflictEvent.people`).
 * Passing yesterday's stay along is harmless: stays take no part.
 *
 * Results are aggregated by the pair of events rather than emitted per person,
 * so three people late for the same dinner are one warning naming three people,
 * not three warnings. The ordering is total and derived only from the events,
 * so two runs over the same day return the same list in the same order.
 *
 * Tracks do not appear anywhere in here, which is the point. Two events at the
 * same time with different people are a split, the normal way a group spends a
 * day; the conflict is one *person* being on both, so the same rule covers a
 * group of one and a group of twelve without anybody declaring a lane.
 */
export function findConflicts(
	events: readonly ConflictEvent[],
	options: ConflictOptions = {}
): ScheduleConflict[] {
	const stamped: Stamped[] = [];
	for (const ev of events) {
		if (!isCommitment(ev)) continue;
		if (ev.people.length === 0) continue;
		stamped.push({
			ev,
			start: zonedMinutesToUtc(ev.day, ev.startMin, ev.tz) / 60000,
			end: zonedMinutesToUtc(ev.day, ev.endMin, ev.tz) / 60000
		});
	}
	// One total order for everybody: start, then end, then id, so a tie can
	// never swap between runs and flip which event is reported as "first".
	stamped.sort((a, b) => a.start - b.start || a.end - b.end || (a.ev.id < b.ev.id ? -1 : 1));

	const byPerson = new Map<string, Stamped[]>();
	for (const s of stamped) {
		for (const person of new Set(s.ev.people)) {
			const list = byPerson.get(person);
			if (list) list.push(s);
			else byPerson.set(person, [s]);
		}
	}

	// Keyed on the pair of events, which is what collapses "the same clash, for
	// four people" into one warning that names four people.
	const found = new Map<string, { conflict: ScheduleConflict; people: Set<string>; at: number }>();
	const record = (key: string, conflict: ScheduleConflict, person: string, at: number) => {
		const existing = found.get(key);
		if (existing) existing.people.add(person);
		else found.set(key, { conflict, people: new Set([person]), at });
	};

	for (const [person, mine] of byPerson) {
		// Already in start order: `stamped` was sorted once and each person's list
		// is a filter over it.
		for (let i = 0; i < mine.length; i++) {
			const a = mine[i];
			// Free time is in the list only so it can end a travel chain; it is not
			// a commitment, so nothing collides with it.
			if (a.ev.type === 'freetime') continue;
			// Sorted by start, so anything overlapping `a` must begin before `a`
			// ends; the scan can stop at the first event that does not.
			for (let j = i + 1; j < mine.length && mine[j].start < a.end; j++) {
				const b = mine[j];
				if (b.ev.type === 'freetime') continue;
				if (!rangesOverlap(a.start, a.end, b.start, b.end)) continue;
				record(
					`overlap\u0000${a.ev.id}\u0000${b.ev.id}`,
					{
						kind: 'overlap',
						people: [],
						firstEventId: a.ev.id,
						secondEventId: b.ev.id,
						overlapMins: Math.round(Math.min(a.end, b.end) - Math.max(a.start, b.start))
					},
					person,
					a.start
				);
			}
		}

		if (!options.travelMins) continue;

		/* The travel chain, walked the same way `planLegs` walks it, because a
		   warning about a journey that the board does not draw as a journey would
		   be a warning about nothing the reader can see.

		   - A `travel` event IS the journey. Nothing is ever checked *into* one:
		     the walk to the airport is inside the flight block by convention, and
		     asking whether you can reach the middle of your own flight in time is
		     not a question. Where it lands is different: after the ferry you are
		     on the island, so a located travel event starts the next chain, and
		     the hop from it to the next stop is checked like any other.
		   - Free time breaks the chain outright. Nobody has said where the person
		     will be when it ends, so a journey measured across it would be
		     inventing a fact.
		   - A block with no coordinates is passed over rather than treated as a
		     break, matching `planLegs`: it says when somebody is busy, not where
		     they are, so it does not unsay where they were. The gap either side of
		     it is still the real gap.
		   - A stay is skipped without breaking the chain. It is not on the clock,
		     so it neither ends a journey nor interrupts one. */
		let prev: Stamped | null = null;
		for (const s of mine) {
			const e = s.ev;
			if (e.type === 'travel') {
				prev = located(e) ? s : null;
				continue;
			}
			if (e.type === 'freetime') {
				prev = null;
				continue;
			}
			if (!located(e)) continue;
			if (prev) {
				const from = prev.ev;
				// An overlap is already reported as an overlap. Reporting the same
				// pair again as an impossible journey would be two warnings about one
				// mistake, and the second would be the less useful of the two.
				if (!rangesOverlap(prev.start, prev.end, s.start, s.end)) {
					const km = haversineKm(
						from.lat as number,
						from.lng as number,
						e.lat as number,
						e.lng as number
					);
					// Two stops inside 30 m are the same place, so there is no journey
					// to be short of time for. Same threshold as `planLegs`, so the
					// pairs it declines to draw a leg for are exactly the pairs this
					// declines to warn about, and back-to-back events in one building
					// stay silent however the estimator rounds.
					if (km >= SAME_PLACE_KM) {
						const mins = options.travelMins(from, e, km);
						if (mins != null && Number.isFinite(mins)) {
							const required = Math.round(mins);
							const available = Math.round(s.start - prev.end);
							// Strictly greater: arriving exactly on time is arriving on
							// time, and zero gap between two events in the same place is
							// not a conflict either (that pair never reaches here).
							if (required > available) {
								record(
									`travel\u0000${from.id}\u0000${e.id}`,
									{
										kind: 'travel',
										people: [],
										firstEventId: from.id,
										secondEventId: e.id,
										requiredMins: required,
										availableMins: available,
										shortfallMins: required - available
									},
									person,
									prev.start
								);
							}
						}
					}
				}
			}
			prev = s;
		}
	}

	const out = [...found.values()]
		.sort(
			(a, b) =>
				a.at - b.at ||
				(a.conflict.kind < b.conflict.kind ? -1 : a.conflict.kind > b.conflict.kind ? 1 : 0) ||
				(a.conflict.firstEventId < b.conflict.firstEventId ? -1 : 1)
		)
		.map(({ conflict, people }) => ({ ...conflict, people: peopleOf(people) }) as ScheduleConflict);
	return out;
}

/**
 * The conflicts touching one event, for a board that warns on the block itself.
 *
 * A convenience over `findConflicts`, not a second rule: the detector answers
 * about pairs, and a badge on a block needs the pairs that block is in.
 */
export function conflictsForEvent(
	conflicts: readonly ScheduleConflict[],
	eventId: string
): ScheduleConflict[] {
	return conflicts.filter((c) => c.firstEventId === eventId || c.secondEventId === eventId);
}
