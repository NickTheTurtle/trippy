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
import type { EventType } from './types';

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
}

/**
 * Two stops closer together than this are the same place as far as a traveller
 * is concerned, so no journey is planned between them. Roughly 30 metres, which
 * is inside the error of a geocoded street address and well inside the width of
 * a hotel.
 */
const SAME_PLACE_KM = 0.03;

/** The people key half of a leg key: sorted ids, so it does not depend on write order. */
export function peopleKey(people: readonly string[]): string {
	return [...new Set(people)].sort().join(',');
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
 * A `travel` event is excluded for a different reason: it IS a journey, entered
 * by hand. Because it is never an endpoint, no automatic leg is planned into or
 * out of it, which is exactly what a person wants when they have already said
 * how they are getting from A to B.
 */
function isAnchor(e: PlannerEvent): boolean {
	if (e.type === 'freetime' || e.type === 'travel') return false;
	return e.lat != null && e.lng != null;
}

/**
 * The legs a day requires.
 *
 * `events` is everything scheduled on the day. `incomingStay` is the previous
 * night's stay, which is where everyone assigned to it starts the morning; pass
 * null for the first day of a trip, or when nobody has booked anywhere. It is
 * an event on yesterday, so its own times say nothing about this morning: the
 * journey out of it is treated as leaving at midnight, which is the honest
 * statement that you can set off whenever you like.
 *
 * The result is ordered by arrival time, then by key, so two runs over the same
 * day produce the same list in the same order and a diff against what is stored
 * is a set comparison rather than a merge.
 */
export function planLegs(
	events: readonly PlannerEvent[],
	incomingStay: PlannerEvent | null = null
): PlannedLeg[] {
	// Sorting once here rather than per person keeps the per-person walk a filter
	// over an already-ordered list. Ties are broken on id so the order is total:
	// two events starting at the same minute must not swap between runs, or the
	// legs either side of them would churn.
	const ordered = [...events].sort((a, b) => a.startMin - b.startMin || (a.id < b.id ? -1 : 1));

	// Yesterday's stay is an origin, not a block on this day, and its own end is
	// a time on the day before. Anchoring the journey out of it to midnight is
	// what says the only true thing about it: you can set off when you like.
	const origin = incomingStay ? { ...incomingStay, startMin: 0, endMin: 0 } : null;

	const everyone = new Set<string>();
	for (const e of ordered) for (const p of e.people) everyone.add(p);
	if (origin) for (const p of origin.people) everyone.add(p);

	// Keyed on the pair of events, which is what makes a shared journey one leg:
	// everyone moving from A to B lands in the same bucket regardless of how many
	// people it turns out to be.
	const byPair = new Map<string, { from: PlannerEvent; to: PlannerEvent; people: Set<string> }>();

	for (const person of everyone) {
		const mine: PlannerEvent[] = [];
		// Last night's stay is the origin, so it goes in front of the day. It is
		// only an origin for the people who actually slept there.
		if (origin && origin.people.includes(person)) mine.push(origin);
		for (const e of ordered) if (e.people.includes(person)) mine.push(e);

		let prev: PlannerEvent | null = null;
		for (const e of mine) {
			if (!isAnchor(e)) {
				// Free time and hand-entered travel both end the current chain: the
				// next journey is planned from whatever comes after them, not across
				// them.
				prev = null;
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
			beforeMin: to.startMin
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
 */
export function placeLeg(leg: PlannedLeg, mins: number): PlacedLeg {
	const gap = leg.beforeMin - leg.afterMin;
	const dur = Math.max(1, Math.round(mins));
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

/** A cluster of legs drawn as one arrow because there was no room for blocks. */
export interface LegArrow {
	startMin: number;
	endMin: number;
	/** Every leg the arrow stands in for, so a click can open the list. */
	keys: string[];
	people: string[];
}

export interface LegLayout<T extends TimedLeg> {
	/** Legs with room to be drawn as a block, each with the lane it sits in. */
	blocks: { leg: T; lane: number; lanes: number }[];
	arrows: LegArrow[];
}

/**
 * A journey shorter than this cannot show a mode and a duration, so drawing it
 * as a block produces a sliver with clipped text. Twenty minutes is about two
 * lines of type at the density the day column is drawn at.
 */
const MIN_BLOCK_MINS = 20;

/**
 * More than this many journeys overlapping at once and each block is too narrow
 * to read, whatever its duration. Three is the point where the column still
 * shows a title; the fourth pushes every one of them under it.
 */
const MAX_LANES = 3;

/**
 * Decide which journeys are drawn as blocks and which collapse into an arrow.
 *
 * A day where the group splits four ways generates a lot of short legs at the
 * same moment, and drawing them all faithfully turns the middle of the
 * afternoon into a picket fence of unreadable slivers. The heuristic gives up
 * on detail exactly where detail stops being legible, and says the true thing
 * instead: people moved here, this many journeys, tap to see them.
 *
 * Two rules, applied in order:
 *
 * 1. Legs that overlap are clustered, transitively. A cluster with more than
 *    `MAX_LANES` legs collapses whole, because the problem is the width of the
 *    column and that is shared by everything in it.
 * 2. Within a surviving cluster, any leg too short to carry its own label
 *    becomes an arrow on its own, and the rest are drawn as blocks in lanes.
 *
 * Collapsing whole clusters rather than individual legs matters: half a cluster
 * as blocks and half as arrows would be drawn at two different widths for no
 * reason the reader could see.
 */
export function layoutLegs<T extends TimedLeg>(legs: readonly T[]): LegLayout<T> {
	const ordered = [...legs].sort((a, b) => a.startMin - b.startMin || (a.key < b.key ? -1 : 1));

	// Transitive overlap clusters. `reach` is the furthest end seen so far, which
	// is what makes it transitive: A-C overlapping B keeps B in the cluster even
	// when A and B do not touch.
	const clusters: T[][] = [];
	let current: T[] = [];
	let reach = -1;
	for (const leg of ordered) {
		if (current.length && leg.startMin >= reach) {
			clusters.push(current);
			current = [];
		}
		current.push(leg);
		reach = Math.max(reach, leg.endMin);
	}
	if (current.length) clusters.push(current);

	const blocks: LegLayout<T>['blocks'] = [];
	const arrows: LegArrow[] = [];

	const arrowFor = (group: T[]): LegArrow => ({
		startMin: Math.min(...group.map((l) => l.startMin)),
		endMin: Math.max(...group.map((l) => l.endMin)),
		keys: group.map((l) => l.key),
		people: [...new Set(group.flatMap((l) => l.people))].sort()
	});

	for (const cluster of clusters) {
		if (cluster.length > MAX_LANES) {
			arrows.push(arrowFor(cluster));
			continue;
		}
		const drawable = cluster.filter((l) => l.endMin - l.startMin >= MIN_BLOCK_MINS);
		for (const l of cluster) if (!drawable.includes(l)) arrows.push(arrowFor([l]));
		drawable.forEach((leg, i) => blocks.push({ leg, lane: i, lanes: drawable.length }));
	}

	arrows.sort((a, b) => a.startMin - b.startMin);
	return { blocks, arrows };
}
