/**
 * Working out which journeys a day implies.
 *
 * The schedule used to put people in "tracks": named lanes you dropped events
 * into, with travel computed down each lane. That made the lane the unit of
 * planning, so the same person could only ever be in one lane at a time, and
 * the travel between two events was a property of the lane rather than of the
 * people actually moving. Splitting the group meant inventing a second lane and
 * remembering to keep both in step by hand.
 *
 * Events now carry the people, and travel is derived from them. The question
 * this module answers is the only one that matters:
 *
 *   for each person, where do they have to be next, and who is going with them?
 *
 * Two people travelling from the same event to the same next event are making
 * one journey, so they share one leg. Two people leaving the same event for
 * different places are making two, and get two. That falls out of keying legs
 * on the pair of events rather than on any lane, and it is why the group can
 * split and rejoin without anyone declaring that it has.
 *
 * Nothing here does I/O or knows what a minute costs. Durations arrive from the
 * routing provider on the server; this decides only which legs exist, and where
 * on the clock each one sits once its duration is known.
 */

import { haversineKm } from './geo';
import { layoutDay, type Layout, type LayoutEvent } from './layout';
import type { EventType, TransportMode } from './types';

/** An event as the planner needs to see it. */
export interface PlannerEvent {
	id: string;
	type: EventType;
	/** Minutes from midnight, on the event's own day. */
	startMin: number;
	/** Minutes from midnight, on the event's own day. */
	endMin: number;
	lat: number | null;
	lng: number | null;
	/** User ids assigned to the event. */
	people: string[];
}

/** A journey the day requires, before anyone has said how long it takes. */
export interface PlannedLeg {
	/** Stable across recomputes, so a manual override can be matched back to its leg. */
	key: string;
	fromEventId: string;
	toEventId: string;
	/** Sorted, so the key is stable whatever order the assignees were written in. */
	people: string[];
	fromLat: number;
	fromLng: number;
	toLat: number;
	toLng: number;
	/** Straight-line distance, so a caller can pick a provider before asking it. */
	km: number;
	/** The event this leg leaves from ends here. */
	afterMin: number;
	/** The event this leg arrives at starts here. */
	beforeMin: number;
	/**
	 * True when the arrival is a date rather than an hour, which is a stay.
	 *
	 * Nobody can be late to their own bed, so there is no time to work back
	 * from: the walk home leaves when the last thing on the day finishes. It is
	 * the mirror of the morning, where the journey out of last night's stay is
	 * anchored at midnight for the same reason.
	 */
	openEnded: boolean;
}

/**
 * Two stops closer together than this are the same place as far as a traveller
 * is concerned, so no journey is planned between them. Roughly 30 metres, which
 * is inside the error of a geocoded street address and well inside the width of
 * a hotel.
 */
export const SAME_PLACE_KM = 0.03;

/** The people key half of a leg key: sorted ids, so it does not depend on write order. */
export function peopleKey(people: readonly string[]): string {
	return [...new Set(people)].sort().join(',');
}

/**
 * The same journey against the id its destination ended up with.
 *
 * A block being added is planned under a draft id and saved under a real one,
 * so what the reader said about its journeys has to survive the swap. Keys are
 * built here, so they are rewritten here too, and anything that is not a key is
 * handed back untouched rather than turned into one that matches nothing.
 */
export function rekeyLeg(key: string, toEventId: string): string {
	const parts = key.split('>');
	if (parts.length !== 3) return key;
	return `${parts[0]}>${toEventId}>${parts[2]}`;
}

/**
 * What a journey of a given length takes, by mode, before a provider answers.
 *
 * Straight-line distance understates every real route, so it is scaled once
 * here rather than at each call. The rest is a pace, a fixed overhead for the
 * parts that are not movement (waiting for the bus, parking, standing in an
 * airport) and a floor, because no journey worth drawing takes a minute.
 *
 * It lives in core, not on the server, because both ends need it and they must
 * agree: the server uses it for a leg no provider has answered for, and the
 * dialog uses it to answer "and how long if we walk instead", which is a
 * question about the same distance rather than a new route to buy.
 */
const ROUTE_FACTOR = 1.3;

const PACE: Record<TransportMode, { kmh: number; fixed: number; floor: number }> = {
	walk: { kmh: 4.8, fixed: 0, floor: 3 },
	cycle: { kmh: 15, fixed: 0, floor: 4 },
	transit: { kmh: 16, fixed: 6, floor: 8 },
	drive: { kmh: 60, fixed: 5, floor: 10 },
	ferry: { kmh: 35, fixed: 30, floor: 20 },
	flight: { kmh: 700, fixed: 120, floor: 90 }
};

export function minsByMode(km: number, mode: string): number {
	const pace = PACE[mode as TransportMode] ?? PACE.transit;
	return Math.max(pace.floor, Math.round(((km * ROUTE_FACTOR) / pace.kmh) * 60) + pace.fixed);
}

/**
 * The mode and the duration a journey of this length is most likely made by.
 *
 * Past a few hundred kilometres nobody is driving, and an eight-hour block
 * across the middle of a day is a worse lie than a flight with its airport time
 * included.
 */
export function guessLeg(km: number): { mode: TransportMode; mins: number } {
	const dist = km * ROUTE_FACTOR;
	const mode: TransportMode =
		dist < 1.1 ? 'walk' : dist < 8 ? 'transit' : dist < 500 ? 'drive' : 'flight';
	return { mode, mins: minsByMode(km, mode) };
}

/**
 * Whether an event can be an end of a journey.
 *
 * Free time is the interesting exclusion. It is not that free time has no
 * location; it is that nobody has promised to be anywhere, so planning a
 * journey out of it would be inventing a fact. It therefore breaks the chain on
 * both sides, and the next journey starts from whatever the person is committed
 * to after it.
 *
 * A `travel` event is excluded here for a different reason, and only on this
 * side: it IS a journey, entered by hand, so planning a second journey *to* it
 * would be planning how to get to the middle of the flight you are already on.
 * Where it ends is a different question, answered by `landsAt` below.
 */
function isAnchor(e: PlannerEvent): boolean {
	if (e.type === 'freetime' || e.type === 'travel') return false;
	return e.lat != null && e.lng != null;
}

/**
 * Where a hand-entered journey puts a person once it is over, if it says.
 *
 * A journey has two ends and the event records the far one, because that is
 * the one the rest of the day depends on: after the ferry you are on the
 * island, and the walk to dinner starts from the port rather than from
 * wherever you were this morning. A travel event with no location still breaks
 * the chain, which is what it did before this existed: nobody can say where
 * the person ends up, so nothing is invented.
 */
function landsAt(e: PlannerEvent): boolean {
	return e.type === 'travel' && e.lat != null && e.lng != null;
}

/**
 * The legs a day requires.
 *
 * `events` is everything scheduled on the day. `incoming` is last night's
 * lodging: where everyone assigned to it starts the morning. Pass null for the
 * first day of a trip, or when nobody has booked anywhere.
 *
 * It is a list because a group does not have to sleep in one building. Each
 * person starts from the stay they are on, and somebody on none of them simply
 * starts the day at their first anchored event. A stay is an event on
 * yesterday, so its own times say nothing about this morning: the journey out
 * of it is treated as leaving at midnight, which is the honest statement that
 * you can set off whenever you like.
 *
 * The result is ordered by arrival time, then by key, so two runs over the same
 * day produce the same list in the same order and a diff against what is stored
 * is a set comparison rather than a merge.
 */
export function planLegs(
	events: readonly PlannerEvent[],
	incoming: PlannerEvent | readonly PlannerEvent[] | null = null
): PlannedLeg[] {
	// Sorting once here rather than per person keeps the per-person walk a filter
	// over an already-ordered list. Ties are broken on id so the order is total:
	// two events starting at the same minute must not swap between runs, or the
	// legs either side of them would churn.
	const ordered = [...events].sort((a, b) => a.startMin - b.startMin || (a.id < b.id ? -1 : 1));

	// Yesterday's stay is an origin, not a block on this day, and its own end is
	// a time on the day before. Anchoring the journey out of it to midnight is
	// what says the only true thing about it: you can set off when you like.
	const origins = (
		incoming == null ? [] : Array.isArray(incoming) ? incoming : [incoming as PlannerEvent]
	).map((o: PlannerEvent) => ({ ...o, startMin: 0, endMin: 0 }));

	const everyone = new Set<string>();
	for (const e of ordered) for (const p of e.people) everyone.add(p);
	for (const o of origins) for (const p of o.people) everyone.add(p);

	// Keyed on the pair of events, which is what makes a shared journey one leg:
	// everyone moving from A to B lands in the same bucket regardless of how many
	// people it turns out to be.
	const byPair = new Map<string, { from: PlannerEvent; to: PlannerEvent; people: Set<string> }>();

	for (const person of everyone) {
		const mine: PlannerEvent[] = [];
		// Last night's stay is the origin, so it goes in front of the day. Only
		// the one this person actually slept in: two halves of a group waking in
		// different hotels are two different mornings.
		const origin = origins.find((o) => o.people.includes(person));
		if (origin) mine.push(origin);
		for (const e of ordered) if (e.people.includes(person)) mine.push(e);

		let prev: PlannerEvent | null = null;
		for (const e of mine) {
			// A hand-entered journey is one-way as an anchor: nothing is planned to
			// it, but where it lands is where the person then is, so it starts the
			// next leg. One that does not say where it lands breaks the chain.
			if (e.type === 'travel') {
				prev = landsAt(e) ? e : null;
				continue;
			}
			if (!isAnchor(e)) {
				// Free time ends the current chain: nobody has promised to be
				// anywhere, so the next journey is planned from whatever comes after
				// it rather than across it.
				//
				// A block with no location is different, and is passed over rather
				// than treated as a break. It says when someone is busy, not where
				// they are, so it does not unsay where they were: the journey from
				// the last known place to the next one is still real, and breaking
				// on it would mean adding a nameless placeholder to a day silently
				// deleted the travel times around it.
				if (e.type === 'freetime') prev = null;
				continue;
			}
			if (prev) {
				const pairKey = `${prev.id}>${e.id}`;
				const bucket = byPair.get(pairKey);
				if (bucket) bucket.people.add(person);
				else byPair.set(pairKey, { from: prev, to: e, people: new Set([person]) });
			}
			prev = e;
		}
	}

	const legs: PlannedLeg[] = [];
	for (const { from, to, people } of byPair.values()) {
		const fromLat = from.lat as number;
		const fromLng = from.lng as number;
		const toLat = to.lat as number;
		const toLng = to.lng as number;
		const km = haversineKm(fromLat, fromLng, toLat, toLng);
		// Two events at the same address are one place. Walking zero metres is not
		// a journey, and drawing it as one would put a block on the day for every
		// pair of events in the same building.
		if (km < SAME_PLACE_KM) continue;
		const sorted = [...people].sort();
		legs.push({
			key: `${from.id}>${to.id}>${peopleKey(sorted)}`,
			fromEventId: from.id,
			toEventId: to.id,
			people: sorted,
			fromLat,
			fromLng,
			toLat,
			toLng,
			km,
			// An event is left when it finishes; yesterday's stay was rewritten to
			// end at midnight above, so this is the same field for both.
			afterMin: from.endMin,
			beforeMin: to.startMin,
			openEnded: to.type === 'stay'
		});
	}

	legs.sort((a, b) => a.beforeMin - b.beforeMin || (a.key < b.key ? -1 : 1));
	return legs;
}

export interface PlacedLeg {
	startMin: number;
	endMin: number;
	/**
	 * True when the journey does not fit in the gap it has to cross, so the day
	 * as planned is not achievable. The block is drawn at the gap anyway, because
	 * shrinking it would hide the problem rather than show it.
	 */
	tight: boolean;
}

/**
 * Where a journey of a known length sits on the clock.
 *
 * It is anchored to its arrival rather than its departure, because the fixed
 * point is the thing you are trying not to be late for: a table booked at seven
 * means leaving at half six, not arriving whenever an hour after the last stop
 * happens to fall.
 *
 * A journey home to a stay has no such point, so it is the one that is anchored
 * to its departure: you leave when the day finishes and you arrive when you
 * arrive. It can never be tight, because there is no gap to overrun.
 */
export function placeLeg(leg: PlannedLeg, mins: number): PlacedLeg {
	const gap = leg.beforeMin - leg.afterMin;
	const dur = Math.max(1, Math.round(mins));
	if (leg.openEnded) return { startMin: leg.afterMin, endMin: leg.afterMin + dur, tight: false };
	if (dur > gap) return { startMin: leg.afterMin, endMin: leg.beforeMin, tight: true };
	return { startMin: leg.beforeMin - dur, endMin: leg.beforeMin, tight: false };
}

/** A leg once its duration is known and it has been placed on the clock. */
export interface TimedLeg {
	key: string;
	startMin: number;
	endMin: number;
	people: string[];
}

/** A leg the board has to place: it knows which two events it joins. */
export interface BoardLeg extends TimedLeg {
	fromEventId: string;
	toEventId: string;
}

/** Legs and events share one id space, so a journey's key cannot shadow an event's. */
const LEG_PREFIX = 'leg:';

export function legLaneId(leg: { key: string }): string {
	return `${LEG_PREFIX}${leg.key}`;
}

export interface BoardLayout<T extends BoardLeg> {
	layout: Layout;
	/** Every journey the board can draw, each with the box it occupies. */
	bars: LegBar<T>[];
}

/** A journey and the slice of the board it is drawn in, as fractions 0..1. */
export interface LegBar<T extends BoardLeg> {
	leg: T;
	left: number;
	width: number;
}

/**
 * Lay out a day's events, then hang each journey under the event it arrives at.
 *
 * A journey means "this is how these people get into this event". Drawing it
 * anywhere else makes the reader work out which event it belongs to, which is
 * the job a connector used to do badly. Anchored to its arrival, a journey is
 * under the event it leads into by construction, so there is nothing left for a
 * line to explain and the board needs no lines at all.
 *
 * The arrival rather than the departure, for two reasons. It is the anchor the
 * clock already uses: `placeLeg` ends every journey exactly when its arrival
 * starts, because the fixed point is the thing you are trying not to be late
 * for. And it is the end that is actually there: a journey out of the lodging
 * on the first morning has no departure event on the day, so a rule anchored to
 * departures cannot draw it.
 *
 * Journeys are not packed. They take no column of their own, so events lay out
 * exactly as if journeys did not exist, which is the widest they can ever be.
 *
 * Where several journeys land on the same event they share its width, ordered
 * by the column they came from. The fan then carries positionally what the
 * crossing arrows used to: the leftmost bar is the group from the leftmost
 * column.
 */
export function layoutBoard<T extends BoardLeg>(
	events: readonly LayoutEvent[],
	legs: readonly T[]
): BoardLayout<T> {
	const layout = layoutDay([...events]);

	const byArrival = new Map<string, T[]>();
	for (const leg of legs) {
		// A journey whose arrival is not on this day has nothing to hang under.
		if (!layout.placed.has(leg.toEventId)) continue;
		const list = byArrival.get(leg.toEventId);
		if (list) list.push(leg);
		else byArrival.set(leg.toEventId, [leg]);
	}

	const bars: LegBar<T>[] = [];
	for (const [arrivalId, fan] of byArrival) {
		const to = layout.placed.get(arrivalId);
		if (!to) continue;
		// A departure that is not on the board sorts to its arrival's own
		// position, so it keeps its place in the fan instead of jumping to one end.
		const originOf = (l: T) => layout.placed.get(l.fromEventId)?.left ?? to.left;
		// Sorted on the leg itself, never on input order, so the same day always
		// draws the same way.
		const order = [...fan].sort(
			(a, b) => originOf(a) - originOf(b) || a.startMin - b.startMin || (a.key < b.key ? -1 : 1)
		);
		const slot = to.width / order.length;
		order.forEach((leg, i) => bars.push({ leg, left: to.left + i * slot, width: slot }));
	}

	return { layout, bars };
}
