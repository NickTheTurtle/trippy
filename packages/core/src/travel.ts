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
import { layoutDay, type Layout, type LayoutEvent, type Placed } from './layout';
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

/** A leg the board has to place: it knows which two events it joins. */
export interface BoardLeg extends TimedLeg {
	fromEventId: string;
	toEventId: string;
}

/** Legs and events share one id space in the layout, so neither can shadow the other. */
const LEG_PREFIX = 'leg:';

export function legLaneId(leg: { key: string }): string {
	return `${LEG_PREFIX}${leg.key}`;
}

/** Whether a layout id belongs to a journey rather than an event. */
export function isLegLaneId(id: string): boolean {
	return id.startsWith(LEG_PREFIX);
}

export interface BoardLayout<T extends BoardLeg> {
	layout: Layout;
	/** Legs drawn as blocks, in the same columns as the events they join. */
	blocks: T[];
	/** Legs with no block, to be drawn as an arrow between their two events. */
	stranded: T[];
}

/**
 * How much of a block's width a middle may fall outside and still count as
 * being under it, as a fraction of the board. Covers the gutter a block leaves
 * between itself and its neighbour.
 */
const SAME_COLUMN = 0.02;

/**
 * A demoted leg frees a column, which can move the blocks that were beside it,
 * which can demote another. Each pass drops at least one leg, so this only
 * bounds how much churn is worth chasing before settling.
 */
const MAX_PASSES = 4;

/**
 * A journey too short to carry its label is still a journey, and drawing it as
 * a thin block keeps the day reading top to bottom: the arrow is reserved for
 * the one thing a column layout genuinely cannot show. The board gives these a
 * floor height and tucks them under the event they arrive at.
 */

function middle(p: Placed): number {
	return p.left + p.width / 2;
}

/**
 * Whether a journey can be drawn as a block: its own middle must fall under
 * both events it joins, so the run reads straight down.
 *
 * Under rather than aligned. An event the whole group attends spans the board,
 * and a journey four of them make sits in one narrow column of it. Their
 * middles are nowhere near each other, and yet the journey is drawn directly
 * beneath the event and reads as leaving it, which is what matters.
 */
function straight<T extends BoardLeg>(layout: Layout, leg: T): boolean {
	const from = layout.placed.get(leg.fromEventId);
	const to = layout.placed.get(leg.toEventId);
	const self = layout.placed.get(legLaneId(leg));
	if (!from || !to || !self) return false;
	const x = middle(self);
	const under = (p: Placed) => x > p.left - SAME_COLUMN && x < p.left + p.width + SAME_COLUMN;
	return under(from) && under(to);
}

/**
 * Lay out a day's events and journeys together.
 *
 * A journey is drawn as a block wherever one can be drawn, because a block is
 * the only form that says how long the journey takes and how much of the gap it
 * eats. An arrow says only that people moved.
 *
 * A block can be drawn when the journey sits under both events it joins: then
 * it reads straight down, and the journey is visibly the thing joining the two.
 * When it cannot, which is what happens where a journey has to reach across to
 * a column its departure point does not cover, a block would claim a track its
 * travellers are not on. That is the case the arrow exists for, and the only
 * one.
 *
 * Every leg starts as a candidate block. Laying them out can move the events
 * under them, so a candidate that turns out to cross is dropped and the day is
 * laid out again without it. This settles, because a pass only ever drops.
 */
export function layoutBoard<T extends BoardLeg>(
	events: readonly LayoutEvent[],
	legs: readonly T[]
): BoardLayout<T> {
	const asItems = (chosen: readonly T[]): LayoutEvent[] => [
		...events,
		...chosen.map((l) => ({
			id: legLaneId(l),
			start: l.startMin,
			end: l.endMin,
			people: l.people
		}))
	];

	// Every journey starts as a candidate: preferring blocks means trying one
	// everywhere, and only geometry takes it away.
	let chosen: readonly T[] = legs;
	let layout = layoutDay(asItems(chosen));

	for (let pass = 1; pass < MAX_PASSES; pass++) {
		const keep = chosen.filter((l) => straight(layout, l));
		if (keep.length === chosen.length) break;
		chosen = keep;
		layout = layoutDay(asItems(chosen));
	}

	const drawn = new Set(chosen.map((l) => l.key));
	return { layout, blocks: [...chosen], stranded: legs.filter((l) => !drawn.has(l.key)) };
}
