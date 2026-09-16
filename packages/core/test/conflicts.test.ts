import { describe, expect, it } from 'vitest';
import {
	findConflicts,
	conflictsForEvent,
	type ConflictEvent,
	type ScheduleConflict
} from '@trippy/core/conflicts';

/* Athens coordinates. `acropolis` and `pier` are about 8 km apart, which is far
   enough that no pair falls inside the 30 m same-place threshold unless a test
   asks for it by reusing one place for both ends. */
const P = {
	acropolis: [37.9715, 23.7257],
	museum: [37.9891, 23.7332],
	pier: [37.9421, 23.6465]
} as const;

const DAY = '2026-07-14';

let seq = 0;

function ev(over: Partial<ConflictEvent> & { people: string[] }): ConflictEvent {
	return {
		id: `e${++seq}`,
		type: 'activity',
		day: DAY,
		startMin: 9 * 60,
		endMin: 10 * 60,
		tz: 'Europe/Athens',
		lat: P.acropolis[0],
		lng: P.acropolis[1],
		...over
	};
}

function at(place: readonly [number, number], over: Partial<ConflictEvent> & { people: string[] }) {
	return ev({ lat: place[0], lng: place[1], ...over });
}

/** A fixed estimate, so a test states the journey it means rather than a route. */
const flat = (mins: number) => () => mins;

const kinds = (cs: ScheduleConflict[]) => cs.map((c) => c.kind);

describe('overlap', () => {
	it('flags one person on two events at the same time', () => {
		const a = ev({ people: ['ann'], startMin: 540, endMin: 660 });
		const b = ev({ people: ['ann'], startMin: 600, endMin: 720 });
		const out = findConflicts([a, b]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			kind: 'overlap',
			people: ['ann'],
			firstEventId: a.id,
			secondEventId: b.id,
			overlapMins: 60
		});
	});

	it('names only the person who is on both', () => {
		const a = ev({ people: ['ann', 'bo'], startMin: 540, endMin: 660 });
		const b = ev({ people: ['ann', 'cai'], startMin: 600, endMin: 720 });
		const out = findConflicts([a, b]);
		expect(out).toHaveLength(1);
		expect(out[0].people).toEqual(['ann']);
	});

	it('reports one conflict for a whole party, naming everybody in it', () => {
		// A party of four is four ids on the event: the caller expands a crew (or
		// "Everyone") before calling, exactly as the board and `toPlanner` do.
		const party = ['ann', 'bo', 'cai', 'dee'];
		const a = ev({ people: party, startMin: 540, endMin: 660 });
		const b = ev({ people: ['dee', 'cai'], startMin: 630, endMin: 700 });
		const out = findConflicts([a, b]);
		expect(out).toHaveLength(1);
		expect(out[0].people).toEqual(['cai', 'dee']);
	});

	it('leaves back-to-back events alone', () => {
		const a = ev({ people: ['ann'], startMin: 540, endMin: 660 });
		const b = ev({ people: ['ann'], startMin: 660, endMin: 720 });
		expect(findConflicts([a, b])).toEqual([]);
	});

	it('says nothing about an event with nobody on it', () => {
		// Empty means nobody here; a caller expands "Everyone" first. Reading it as
		// everybody would put a warning on nearly every pair on the day.
		const a = ev({ people: [], startMin: 540, endMin: 660 });
		const b = ev({ people: [], startMin: 600, endMin: 720 });
		expect(findConflicts([a, b])).toEqual([]);
	});

	it('finds a clash with an event that contains another', () => {
		const a = ev({ people: ['ann'], startMin: 540, endMin: 1020 });
		const b = ev({ people: ['ann'], startMin: 600, endMin: 660 });
		const c = ev({ people: ['ann'], startMin: 720, endMin: 780 });
		const out = findConflicts([a, b, c]);
		expect(out).toHaveLength(2);
		expect(out.every((x) => x.firstEventId === a.id)).toBe(true);
	});
});

describe('tracks', () => {
	it('is silent when the group splits into two tracks with nobody in common', () => {
		const a = ev({ people: ['ann', 'bo'], startMin: 540, endMin: 720 });
		const b = at(P.museum, { people: ['cai', 'dee'], startMin: 540, endMin: 720 });
		expect(findConflicts([a, b], { travelMins: flat(20) })).toEqual([]);
	});

	it('flags the one person who is on both tracks', () => {
		const a = ev({ people: ['ann', 'bo'], startMin: 540, endMin: 720 });
		const b = at(P.museum, { people: ['bo', 'cai'], startMin: 600, endMin: 780 });
		const out = findConflicts([a, b], { travelMins: flat(20) });
		expect(kinds(out)).toEqual(['overlap']);
		expect(out[0].people).toEqual(['bo']);
	});
});

describe('travel fit', () => {
	it('is quiet when the gap covers the journey', () => {
		const a = ev({ people: ['ann'], startMin: 540, endMin: 600 });
		const b = at(P.museum, { people: ['ann'], startMin: 660, endMin: 720 });
		expect(findConflicts([a, b], { travelMins: flat(30) })).toEqual([]);
	});

	it('is quiet when the journey exactly fills the gap', () => {
		const a = ev({ people: ['ann'], startMin: 540, endMin: 600 });
		const b = at(P.museum, { people: ['ann'], startMin: 630, endMin: 720 });
		expect(findConflicts([a, b], { travelMins: flat(30) })).toEqual([]);
	});

	it('flags a journey that does not fit, with the numbers', () => {
		const a = ev({ people: ['ann'], startMin: 540, endMin: 600 });
		const b = at(P.pier, { people: ['ann'], startMin: 610, endMin: 720 });
		const out = findConflicts([a, b], { travelMins: flat(45) });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			kind: 'travel',
			people: ['ann'],
			firstEventId: a.id,
			secondEventId: b.id,
			requiredMins: 45,
			availableMins: 10,
			shortfallMins: 35
		});
	});

	it('needs no travel time between two events at the same address', () => {
		const a = ev({ people: ['ann'], startMin: 540, endMin: 600 });
		const b = ev({ people: ['ann'], startMin: 600, endMin: 660 });
		expect(findConflicts([a, b], { travelMins: flat(45) })).toEqual([]);
	});

	it('reports an overlap once rather than also as an impossible journey', () => {
		const a = ev({ people: ['ann'], startMin: 540, endMin: 660 });
		const b = at(P.pier, { people: ['ann'], startMin: 600, endMin: 720 });
		expect(kinds(findConflicts([a, b], { travelMins: flat(45) }))).toEqual(['overlap']);
	});

	it('checks nothing when the caller has no estimate', () => {
		const a = ev({ people: ['ann'], startMin: 540, endMin: 600 });
		const b = at(P.pier, { people: ['ann'], startMin: 610, endMin: 720 });
		expect(findConflicts([a, b], { travelMins: () => null })).toEqual([]);
		expect(findConflicts([a, b])).toEqual([]);
	});

	it('passes over a block with no location instead of breaking the chain', () => {
		const a = ev({ people: ['ann'], startMin: 540, endMin: 600 });
		const busy = ev({ people: ['ann'], startMin: 600, endMin: 620, lat: null, lng: null });
		const b = at(P.pier, { people: ['ann'], startMin: 630, endMin: 720 });
		const out = findConflicts([a, busy, b], { travelMins: flat(45) });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ firstEventId: a.id, secondEventId: b.id });
	});

	it('breaks the chain at free time', () => {
		const a = ev({ people: ['ann'], startMin: 540, endMin: 600 });
		const free = ev({ people: ['ann'], type: 'freetime', startMin: 600, endMin: 620 });
		const b = at(P.pier, { people: ['ann'], startMin: 630, endMin: 720 });
		expect(findConflicts([a, free, b], { travelMins: flat(45) })).toEqual([]);
	});
});

describe('travel events', () => {
	it('does not ask how you get to your own flight, and starts the next hop where it lands', () => {
		const a = ev({ people: ['ann'], startMin: 540, endMin: 600 });
		const hop = at(P.pier, {
			people: ['ann'],
			type: 'travel',
			startMin: 600,
			endMin: 700
		});
		const b = at(P.pier, { people: ['ann'], startMin: 700, endMin: 800 });
		expect(findConflicts([a, hop, b], { travelMins: flat(45) })).toEqual([]);
	});

	it('still flags a stop nobody can reach after the journey lands', () => {
		const hop = at(P.pier, { people: ['ann'], type: 'travel', startMin: 540, endMin: 600 });
		const b = at(P.museum, { people: ['ann'], startMin: 605, endMin: 700 });
		const out = findConflicts([hop, b], { travelMins: flat(40) });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ kind: 'travel', firstEventId: hop.id, secondEventId: b.id });
	});

	it('treats a journey as a real commitment for overlap', () => {
		const hop = at(P.pier, { people: ['ann'], type: 'travel', startMin: 540, endMin: 700 });
		const b = ev({ people: ['ann'], startMin: 600, endMin: 660 });
		expect(kinds(findConflicts([hop, b]))).toEqual(['overlap']);
	});
});

describe('stays', () => {
	it('does not let last night bed-time collide with today', () => {
		// A stay covers nights and is drawn as a band; the minute it carries is a
		// drawing anchor, not a promise to be in the room.
		const stay = at(P.museum, {
			people: ['ann', 'bo'],
			type: 'stay',
			day: '2026-07-13',
			startMin: 21 * 60,
			endMin: 24 * 60
		});
		const morning = ev({ people: ['ann'], startMin: 9 * 60, endMin: 11 * 60 });
		const dinner = at(P.pier, { people: ['ann'], startMin: 20 * 60, endMin: 23 * 60 });
		expect(findConflicts([stay, morning, dinner], { travelMins: flat(30) })).toEqual([]);
	});

	it('does not break the chain it sits in the middle of', () => {
		const lunch = ev({ people: ['ann'], startMin: 12 * 60, endMin: 13 * 60 });
		const stay = at(P.museum, {
			people: ['ann'],
			type: 'stay',
			startMin: 21 * 60,
			endMin: 24 * 60
		});
		const late = at(P.pier, { people: ['ann'], startMin: 13 * 60 + 5, endMin: 14 * 60 });
		const out = findConflicts([lunch, stay, late], { travelMins: flat(40) });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ firstEventId: lunch.id, secondEventId: late.id });
	});
});

describe('time zones', () => {
	it('compares instants, not wall clocks, across a zone change', () => {
		// 12:00 Athens is 09:00 UTC; 09:30 Lisbon is 08:30 UTC. The clock faces
		// look disjoint and the instants overlap by half an hour.
		const athens = ev({ people: ['ann'], startMin: 12 * 60, endMin: 13 * 60 });
		const lisbon = at(P.museum, {
			people: ['ann'],
			tz: 'Europe/Lisbon',
			startMin: 9 * 60 + 30,
			endMin: 10 * 60 + 30
		});
		const out = findConflicts([athens, lisbon]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ kind: 'overlap', overlapMins: 30 });
	});

	it('does not invent a clash out of a zone change that gives time back', () => {
		// 10:00-11:00 Athens ends at 08:00 UTC; 09:00 Lisbon starts at 08:00 UTC,
		// so the two touch exactly and a westbound morning is not a conflict.
		const athens = ev({ people: ['ann'], startMin: 10 * 60, endMin: 11 * 60 });
		const lisbon = at(P.museum, {
			people: ['ann'],
			tz: 'Europe/Lisbon',
			startMin: 9 * 60,
			endMin: 10 * 60
		});
		expect(findConflicts([athens, lisbon], { travelMins: flat(0) })).toEqual([]);
	});

	it('measures the gap in real minutes when the zone changes', () => {
		// The Athens block ends at 12:00 local, which is 09:00 UTC. The Lisbon one
		// starts at 11:00 local, which is 10:00 UTC: an hour later in real time,
		// even though the clock face reads earlier. A 90 minute hop does not fit
		// in that hour, and the gap reported is the real 60 minutes.
		const athens = ev({ people: ['ann'], startMin: 11 * 60, endMin: 12 * 60 });
		const lisbon = at(P.pier, {
			people: ['ann'],
			tz: 'Europe/Lisbon',
			startMin: 11 * 60,
			endMin: 12 * 60
		});
		const out = findConflicts([athens, lisbon], { travelMins: flat(90) });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ kind: 'travel', requiredMins: 90, availableMins: 60 });
	});
});

describe('shape', () => {
	it('returns the same list in the same order whatever order it is handed', () => {
		const a = ev({ people: ['ann'], startMin: 540, endMin: 660 });
		const b = ev({ people: ['ann'], startMin: 600, endMin: 720 });
		const c = at(P.pier, { people: ['ann'], startMin: 725, endMin: 800 });
		const forward = findConflicts([a, b, c], { travelMins: flat(45) });
		const backward = findConflicts([c, b, a], { travelMins: flat(45) });
		expect(backward).toEqual(forward);
		expect(kinds(forward)).toEqual(['overlap', 'travel']);
	});

	it('picks out the conflicts one event is in', () => {
		const a = ev({ people: ['ann'], startMin: 540, endMin: 660 });
		const b = ev({ people: ['ann'], startMin: 600, endMin: 720 });
		const all = findConflicts([a, b]);
		expect(conflictsForEvent(all, b.id)).toHaveLength(1);
		expect(conflictsForEvent(all, 'nope')).toEqual([]);
	});
});
