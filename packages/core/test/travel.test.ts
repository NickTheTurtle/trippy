import { describe, expect, it } from 'vitest';
import type { LayoutEvent } from '@trippy/core/layout';
import {
	layoutBoard,
	legLaneId,
	peopleKey,
	placeLeg,
	planLegs,
	type BoardLeg,
	type PlannedLeg,
	type PlannerEvent
} from '@trippy/core/travel';

/* Coordinates are a few streets apart in Beijing, far enough that no pair falls
   inside the 30 m same-place threshold except where a test wants it to. */
const P = {
	hotel: [39.9, 116.4],
	museum: [39.92, 116.42],
	park: [39.88, 116.38],
	market: [39.94, 116.44]
} as const;

let seq = 0;

function ev(
	over: Partial<PlannerEvent> & { people: string[]; startMin: number; endMin: number }
): PlannerEvent {
	const at = over.lat != null ? null : P.museum;
	return {
		id: `e${++seq}`,
		type: 'activity',
		lat: at ? at[0] : null,
		lng: at ? at[1] : null,
		...over
	} as PlannerEvent;
}

function at(place: readonly [number, number], over: Partial<PlannerEvent> = {}): PlannerEvent {
	return {
		id: `e${++seq}`,
		type: 'activity',
		startMin: 0,
		endMin: 60,
		lat: place[0],
		lng: place[1],
		people: [],
		...over
	};
}

describe('peopleKey', () => {
	it('does not depend on the order the people were written in', () => {
		expect(peopleKey(['b', 'a', 'c'])).toBe(peopleKey(['c', 'a', 'b']));
	});

	it('collapses a duplicate, so a double assignment is still one traveller', () => {
		expect(peopleKey(['a', 'a', 'b'])).toBe('a,b');
	});
});

describe('planLegs', () => {
	it('plans one shared leg when two people make the same journey', () => {
		const a = at(P.hotel, { startMin: 540, endMin: 600, people: ['u1', 'u2'] });
		const b = at(P.museum, { startMin: 660, endMin: 720, people: ['u1', 'u2'] });
		const legs = planLegs([a, b]);
		expect(legs).toHaveLength(1);
		expect(legs[0].people).toEqual(['u1', 'u2']);
		expect(legs[0].fromEventId).toBe(a.id);
		expect(legs[0].toEventId).toBe(b.id);
	});

	it('plans two legs when the group splits, with nobody declaring a split', () => {
		const start = at(P.hotel, { startMin: 540, endMin: 600, people: ['u1', 'u2'] });
		const one = at(P.museum, { startMin: 660, endMin: 720, people: ['u1'] });
		const two = at(P.park, { startMin: 660, endMin: 720, people: ['u2'] });
		const legs = planLegs([start, one, two]);
		expect(legs).toHaveLength(2);
		expect(legs.map((l) => l.people)).toEqual([['u1'], ['u2']]);
	});

	it('plans one leg when a split rejoins', () => {
		const one = at(P.museum, { startMin: 540, endMin: 600, people: ['u1'] });
		const two = at(P.museum, { startMin: 540, endMin: 600, people: ['u2'] });
		const together = at(P.market, { startMin: 660, endMin: 720, people: ['u1', 'u2'] });
		const legs = planLegs([one, two, together]);
		// Both arrive at the same event, but from different ones, so the journeys
		// are not the same journey even though the destination is shared.
		expect(legs).toHaveLength(2);
		expect(legs.every((l) => l.toEventId === together.id)).toBe(true);
	});

	it('breaks the chain across free time, because nobody promised to be anywhere', () => {
		const a = at(P.hotel, { startMin: 540, endMin: 600, people: ['u1'] });
		const free = at(P.museum, {
			type: 'freetime',
			startMin: 610,
			endMin: 700,
			people: ['u1'],
			lat: null,
			lng: null
		});
		const b = at(P.market, { startMin: 720, endMin: 780, people: ['u1'] });
		expect(planLegs([a, free, b])).toHaveLength(0);
	});

	it('suppresses automatic travel across a journey entered by hand', () => {
		const a = at(P.hotel, { startMin: 540, endMin: 600, people: ['u1'] });
		const manual = at(P.museum, { type: 'travel', startMin: 600, endMin: 660, people: ['u1'] });
		const b = at(P.market, { startMin: 660, endMin: 720, people: ['u1'] });
		expect(planLegs([a, manual, b])).toHaveLength(0);
	});

	it('plans nothing between two events at the same address', () => {
		const a = at(P.hotel, { startMin: 540, endMin: 600, people: ['u1'] });
		const b = at(P.hotel, { startMin: 610, endMin: 660, people: ['u1'] });
		expect(planLegs([a, b])).toHaveLength(0);
	});

	it('plans nothing out of an event with no coordinates', () => {
		const a = ev({ startMin: 540, endMin: 600, people: ['u1'], lat: null, lng: null });
		const b = at(P.market, { startMin: 660, endMin: 720, people: ['u1'] });
		expect(planLegs([a, b])).toHaveLength(0);
	});

	it("starts the morning from last night's stay, for the people who slept there", () => {
		const stay = at(P.hotel, {
			type: 'stay',
			// A stay is an ordinary block on its own evening. What it says about the
			// next morning is only where its people wake up.
			startMin: 21 * 60,
			endMin: 24 * 60,
			people: ['u1']
		});
		const morning = at(P.museum, { startMin: 600, endMin: 660, people: ['u1', 'u2'] });
		const legs = planLegs([morning], stay);
		expect(legs).toHaveLength(1);
		// u2 did not sleep there, so u2 is not on the journey out of it.
		expect(legs[0].people).toEqual(['u1']);
		// The journey out of it is anchored to midnight: the stay carries no
		// checkout, so the only honest earliest departure is the start of the day.
		expect(legs[0].afterMin).toBe(0);
	});

	it('keys a leg on the events and the travellers, so an unrelated edit does not churn it', () => {
		const a = at(P.hotel, { startMin: 540, endMin: 600, people: ['u1', 'u2'] });
		const b = at(P.museum, { startMin: 660, endMin: 720, people: ['u1', 'u2'] });
		const before = planLegs([a, b])[0].key;
		// Drag both events ten minutes later. Who is going where has not changed,
		// so a manual override on this leg has to survive.
		const after = planLegs([
			{ ...a, startMin: 550, endMin: 610 },
			{ ...b, startMin: 670, endMin: 730 }
		])[0].key;
		expect(after).toBe(before);
	});

	it('changes the key when the travelling group changes, so an override does not leak', () => {
		const a = at(P.hotel, { startMin: 540, endMin: 600, people: ['u1', 'u2'] });
		const b = at(P.museum, { startMin: 660, endMin: 720, people: ['u1', 'u2'] });
		const both = planLegs([a, b])[0].key;
		const alone = planLegs([
			{ ...a, people: ['u1'] },
			{ ...b, people: ['u1'] }
		])[0].key;
		expect(alone).not.toBe(both);
	});

	it('returns the same list in the same order over two runs', () => {
		const evs = [
			at(P.hotel, { startMin: 540, endMin: 600, people: ['u1', 'u2'] }),
			at(P.museum, { startMin: 660, endMin: 720, people: ['u1'] }),
			at(P.park, { startMin: 660, endMin: 720, people: ['u2'] }),
			at(P.market, { startMin: 800, endMin: 860, people: ['u1', 'u2'] })
		];
		const first = planLegs(evs).map((l) => l.key);
		const shuffled = [evs[3], evs[1], evs[0], evs[2]];
		expect(planLegs(shuffled).map((l) => l.key)).toEqual(first);
	});

	it('plans nothing for a day with one event, or none at all', () => {
		expect(planLegs([])).toHaveLength(0);
		expect(planLegs([at(P.hotel, { people: ['u1'] })])).toHaveLength(0);
	});

	it('ignores an event nobody is on', () => {
		const a = at(P.hotel, { startMin: 540, endMin: 600, people: ['u1'] });
		const orphan = at(P.park, { startMin: 620, endMin: 640, people: [] });
		const b = at(P.museum, { startMin: 660, endMin: 720, people: ['u1'] });
		const legs = planLegs([a, orphan, b]);
		expect(legs).toHaveLength(1);
		expect(legs[0].fromEventId).toBe(a.id);
		expect(legs[0].toEventId).toBe(b.id);
	});
});

function leg(over: Partial<PlannedLeg> = {}): PlannedLeg {
	return {
		key: 'k',
		fromEventId: 'a',
		toEventId: 'b',
		people: ['u1'],
		fromLat: P.hotel[0],
		fromLng: P.hotel[1],
		toLat: P.museum[0],
		toLng: P.museum[1],
		km: 2,
		afterMin: 600,
		beforeMin: 700,
		...over
	};
}

describe('placeLeg', () => {
	it('anchors a journey to its arrival, not its departure', () => {
		// A table at 19:00 that takes 30 minutes to reach means leaving at 18:30,
		// whatever time the previous stop happened to finish.
		const placed = placeLeg(leg({ afterMin: 900, beforeMin: 1140 }), 30);
		expect(placed).toEqual({ startMin: 1110, endMin: 1140, tight: false });
	});

	it('fills the gap and flags a journey that does not fit', () => {
		const placed = placeLeg(leg({ afterMin: 600, beforeMin: 630 }), 90);
		// Drawn at the gap rather than shrunk: an unachievable day should show the
		// problem, not hide it.
		expect(placed).toEqual({ startMin: 600, endMin: 630, tight: true });
	});

	it('fits a journey exactly as long as its gap', () => {
		expect(placeLeg(leg({ afterMin: 600, beforeMin: 660 }), 60)).toEqual({
			startMin: 600,
			endMin: 660,
			tight: false
		});
	});

	it('never places a journey of no length', () => {
		const placed = placeLeg(leg({ afterMin: 600, beforeMin: 700 }), 0);
		expect(placed.endMin - placed.startMin).toBe(1);
	});

	it('flags a gap that runs backwards, which is an overlap the user has to see', () => {
		expect(placeLeg(leg({ afterMin: 700, beforeMin: 600 }), 10).tight).toBe(true);
	});
});

/* --- layoutBoard ---------------------------------------------------------
 *
 * The question these ask is only ever "block or arrow", so the events are
 * skeletal: an id, a span, and who is on it, which is all the column layout
 * reads. */

function item(id: string, start: number, end: number, people: string[]): LayoutEvent {
	return { id, start, end, people };
}

function boardLeg(
	key: string,
	fromEventId: string,
	toEventId: string,
	startMin: number,
	endMin: number,
	people = ['u1']
): BoardLeg {
	return { key, fromEventId, toEventId, startMin, endMin, people };
}

describe('layoutBoard', () => {
	it('draws a journey between two events on one track as a block', () => {
		const out = layoutBoard(
			[item('a', 600, 660, ['u1']), item('b', 720, 780, ['u1'])],
			[boardLeg('a>b', 'a', 'b', 660, 720)]
		);
		expect(out.blocks.map((l) => l.key)).toEqual(['a>b']);
		expect(out.stranded).toEqual([]);
	});

	it('blocks both journeys where the group splits', () => {
		// Two people part after 'a': 'b' and 'c' take a column each and 'a' spans
		// both. Each journey sits in its own half, under 'a' and over its arrival,
		// so both read straight down and neither needs an arrow.
		const out = layoutBoard(
			[item('a', 540, 600, ['u1', 'u2']), item('b', 720, 780, ['u1']), item('c', 720, 780, ['u2'])],
			[boardLeg('a>b', 'a', 'b', 660, 720, ['u1']), boardLeg('a>c', 'a', 'c', 660, 720, ['u2'])]
		);
		expect(out.blocks.map((l) => l.key).sort()).toEqual(['a>b', 'a>c']);
		expect(out.stranded).toEqual([]);
	});

	it('arrows a journey whose arrival is not on the board', () => {
		// The board hides events nobody in the filter attends, and a journey can
		// outlive the event it arrives at. It has no column to run down to.
		const out = layoutBoard([item('a', 600, 660, ['u1'])], [boardLeg('a>b', 'a', 'b', 660, 720)]);
		expect(out.blocks).toEqual([]);
		expect(out.stranded.map((l) => l.key)).toEqual(['a>b']);
	});

	it('keeps a journey inside a track as a block while the group is apart', () => {
		const out = layoutBoard(
			[
				item('b1', 600, 660, ['u1']),
				item('c1', 600, 660, ['u2']),
				item('b2', 720, 780, ['u1']),
				item('c2', 720, 780, ['u2'])
			],
			[
				boardLeg('b1>b2', 'b1', 'b2', 660, 720, ['u1']),
				boardLeg('c1>c2', 'c1', 'c2', 660, 720, ['u2'])
			]
		);
		expect(out.blocks.map((l) => l.key).sort()).toEqual(['b1>b2', 'c1>c2']);
		expect(out.stranded).toEqual([]);
	});

	it('blocks a journey too short to carry a label, rather than arrowing it', () => {
		// Ten minutes is a sliver, but it is a sliver in the right column and the
		// board floors its drawn height. An arrow would say less about it.
		const out = layoutBoard(
			[item('a', 600, 660, ['u1']), item('b', 670, 730, ['u1'])],
			[boardLeg('a>b', 'a', 'b', 660, 670)]
		);
		expect(out.blocks.map((l) => l.key)).toEqual(['a>b']);
		expect(out.stranded).toEqual([]);
	});

	it('places every journey it draws, under the id the board looks it up by', () => {
		const out = layoutBoard(
			[item('a', 600, 660, ['u1']), item('b', 720, 780, ['u1'])],
			[boardLeg('a>b', 'a', 'b', 660, 720)]
		);
		expect(out.layout.placed.has(legLaneId({ key: 'a>b' }))).toBe(true);
	});

	it('leaves a journey whose events it has never heard of as an arrow', () => {
		const out = layoutBoard([], [boardLeg('a>b', 'a', 'b', 660, 720)]);
		expect(out.blocks).toEqual([]);
		expect(out.stranded.map((l) => l.key)).toEqual(['a>b']);
	});

	it('does not depend on the order the legs arrived in', () => {
		const events = [
			item('a', 540, 600, ['u1', 'u2']),
			item('b', 720, 780, ['u1']),
			item('c', 720, 780, ['u2'])
		];
		const legs = [
			boardLeg('a>b', 'a', 'b', 660, 720, ['u1']),
			boardLeg('a>c', 'a', 'c', 660, 720, ['u2'])
		];
		const out = layoutBoard(events, legs);
		const same = layoutBoard(events, [...legs].reverse());
		expect(same.blocks.map((l) => l.key).sort()).toEqual(out.blocks.map((l) => l.key).sort());
	});

	it('lays out an empty day without complaint', () => {
		const out = layoutBoard([], []);
		expect(out.blocks).toEqual([]);
		expect(out.stranded).toEqual([]);
		expect(out.layout.placed.size).toBe(0);
	});
});
