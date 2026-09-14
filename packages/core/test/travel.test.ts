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

	it('plans nothing into a journey entered by hand, and resumes from where it lands', () => {
		const a = at(P.hotel, { startMin: 540, endMin: 600, people: ['u1'] });
		const manual = at(P.museum, { type: 'travel', startMin: 600, endMin: 660, people: ['u1'] });
		const b = at(P.market, { startMin: 660, endMin: 720, people: ['u1'] });
		const legs = planLegs([a, manual, b]);
		// Nothing is planned to the middle of your own flight, and nothing spans it:
		// the only journey left is out of the address the flight put you at.
		expect(legs).toHaveLength(1);
		expect(legs[0].fromEventId).toBe(manual.id);
		expect(legs[0].toEventId).toBe(b.id);
	});

	it('breaks the chain at a journey entered by hand with no end location', () => {
		const a = at(P.hotel, { startMin: 540, endMin: 600, people: ['u1'] });
		const manual = ev({
			type: 'travel',
			startMin: 600,
			endMin: 660,
			people: ['u1'],
			lat: null,
			lng: null
		});
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

	it('plans across an event with no coordinates, which says when but not where', () => {
		const a = at(P.hotel, { startMin: 540, endMin: 600, people: ['u1'] });
		const nowhere = ev({ startMin: 610, endMin: 650, people: ['u1'], lat: null, lng: null });
		const b = at(P.market, { startMin: 660, endMin: 720, people: ['u1'] });
		const legs = planLegs([a, nowhere, b]);
		// Adding a block nobody has given an address yet must not delete the
		// travel time either side of it.
		expect(legs).toHaveLength(1);
		expect(legs[0].fromEventId).toBe(a.id);
		expect(legs[0].toEventId).toBe(b.id);
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
	const barFor = (out: { bars: { leg: BoardLeg; left: number; width: number }[] }, key: string) =>
		out.bars.find((b) => b.leg.key === key);

	it('hangs a journey under the event it arrives at', () => {
		const out = layoutBoard(
			[item('a', 600, 660, ['u1']), item('b', 720, 780, ['u1'])],
			[boardLeg('a>b', 'a', 'b', 660, 720)]
		);
		const arrival = out.layout.placed.get('b')!;
		expect(barFor(out, 'a>b')).toMatchObject({ left: arrival.left, width: arrival.width });
	});

	it('draws a journey whose departure is not on the board', () => {
		// Leaving the lodging in the morning: the departure is the previous
		// night's stay, or on the first day nothing at all. The old rule needed
		// both ends and drew these nowhere.
		const out = layoutBoard([item('b', 600, 660, ['u1'])], [boardLeg('a>b', 'a', 'b', 540, 600)]);
		expect(out.bars.map((b) => b.leg.key)).toEqual(['a>b']);
	});

	it('does not draw a journey whose arrival is not on the board', () => {
		// The board hides events nobody in the filter attends. Without its
		// arrival a journey has nothing to hang under.
		const out = layoutBoard([item('a', 600, 660, ['u1'])], [boardLeg('a>b', 'a', 'b', 660, 720)]);
		expect(out.bars).toEqual([]);
	});

	it('gives each arrival its own bar where the group splits', () => {
		const out = layoutBoard(
			[item('a', 540, 600, ['u1', 'u2']), item('b', 720, 780, ['u1']), item('c', 720, 780, ['u2'])],
			[boardLeg('a>b', 'a', 'b', 660, 720, ['u1']), boardLeg('a>c', 'a', 'c', 660, 720, ['u2'])]
		);
		expect(out.bars).toHaveLength(2);
		for (const key of ['a>b', 'a>c']) {
			const arrival = out.layout.placed.get(key.slice(-1))!;
			expect(barFor(out, key)).toMatchObject({ left: arrival.left, width: arrival.width });
		}
	});

	it('shares the arrival between journeys that land on it, ordered by where they came from', () => {
		const out = layoutBoard(
			[item('b', 540, 600, ['u1']), item('c', 540, 600, ['u2']), item('d', 720, 780, ['u1', 'u2'])],
			[boardLeg('b>d', 'b', 'd', 660, 720, ['u1']), boardLeg('c>d', 'c', 'd', 660, 720, ['u2'])]
		);
		const d = out.layout.placed.get('d')!;
		const fan = out.bars.filter((bar) => bar.leg.toEventId === 'd');
		expect(fan).toHaveLength(2);
		// Side by side, together covering exactly the block they lead into.
		expect(fan[0].left).toBe(d.left);
		expect(fan[0].width).toBeCloseTo(d.width / 2);
		expect(fan[1].left).toBeCloseTo(d.left + d.width / 2);
		// Leftmost bar is the group from the leftmost column, which is what the
		// fan carries now that no line does.
		const originLeft = (key: string) => out.layout.placed.get(key.split('>')[0])!.left;
		expect(originLeft(fan[0].leg.key)).toBeLessThan(originLeft(fan[1].leg.key));
	});

	it('lets events keep the width they would have had with no journeys at all', () => {
		// Journeys take no column, so a lone event still spans the board even
		// where a journey runs alongside somebody else's.
		const out = layoutBoard(
			[item('a', 600, 660, ['u1']), item('b', 720, 780, ['u1'])],
			[boardLeg('a>b', 'a', 'b', 660, 720)]
		);
		expect(out.layout.placed.get('a')!.width).toBe(1);
		expect(out.layout.placed.get('b')!.width).toBe(1);
	});

	it('draws a journey too short to carry a label, rather than dropping it', () => {
		const out = layoutBoard(
			[item('a', 600, 660, ['u1']), item('b', 670, 730, ['u1'])],
			[boardLeg('a>b', 'a', 'b', 660, 670)]
		);
		expect(out.bars.map((b) => b.leg.key)).toEqual(['a>b']);
	});

	it('does not depend on the order the legs arrived in', () => {
		const events = [
			item('b', 540, 600, ['u1']),
			item('c', 540, 600, ['u2']),
			item('d', 720, 780, ['u1', 'u2'])
		];
		const legs = [
			boardLeg('b>d', 'b', 'd', 660, 720, ['u1']),
			boardLeg('c>d', 'c', 'd', 660, 720, ['u2'])
		];
		const out = layoutBoard(events, legs);
		const same = layoutBoard(events, [...legs].reverse());
		expect(same.bars).toEqual(out.bars);
	});

	it('lays out an empty day without complaint', () => {
		const out = layoutBoard([], []);
		expect(out.bars).toEqual([]);
		expect(out.layout.placed.size).toBe(0);
	});

	it('keeps journey keys out of the id space events use', () => {
		expect(legLaneId({ key: 'a>b' })).toBe('leg:a>b');
	});
});
