/**
 * Calendar layout engine.
 *
 * The day view no longer draws one column per authored track. Instead columns are
 * derived from the events themselves, so that:
 *
 *  1. An event is as wide as it can be; width shrinks only where events actually
 *     overlap in time, so a solo morning activity spans the full board while three
 *     concurrent afternoon activities each take a third.
 *  2. Horizontal order minimises crossings of the "people flow" arrows. When the
 *     group splits and later rejoins, the events people move between end up near
 *     each other, so the arrows run roughly straight instead of criss-crossing.
 *
 * Everything here is pure so it can be reasoned about (and tested) without a DOM.
 */

export type LayoutEvent = {
	id: string;
	start: number;
	end: number;
	/** Resolved attendees: explicit assignees, else the track's crew. */
	people: string[];
};

/** One person moving from `from` to `to`; `people` aggregates everyone on that hop. */
export type Flow = {
	from: string;
	to: string;
	at: number;
	people: string[];
};

export type Placed = {
	id: string;
	/** Fraction of the board, 0..1. */
	left: number;
	width: number;
	/** Column index and the cluster's column count, useful for debugging. */
	col: number;
	cols: number;
	/** Global left-to-right rank used to order columns. */
	rank: number;
};

export type Layout = {
	placed: Map<string, Placed>;
	flows: Flow[];
	/** Number of flow arrows that cross, after ordering. Lower is better. */
	crossings: number;
};

/** Events overlap when they share any open interval (touching endpoints don't count). */
function overlaps(a: LayoutEvent, b: LayoutEvent): boolean {
	return a.start < b.end && b.start < a.end;
}

/**
 * Person movements between consecutive events. A person's events are taken in
 * start order; every adjacent pair becomes one hop, aggregated by (from,to).
 */
export function buildFlows(events: LayoutEvent[]): Flow[] {
	const byPerson = new Map<string, LayoutEvent[]>();
	for (const ev of events) {
		for (const p of ev.people) {
			const list = byPerson.get(p);
			if (list) list.push(ev);
			else byPerson.set(p, [ev]);
		}
	}
	const agg = new Map<string, Flow>();
	for (const [person, evs] of byPerson) {
		evs.sort((a, b) => a.start - b.start || a.end - b.end);
		for (let i = 1; i < evs.length; i++) {
			const from = evs[i - 1];
			const to = evs[i];
			if (from.id === to.id) continue;
			const key = `${from.id}\u0000${to.id}`;
			const existing = agg.get(key);
			if (existing) existing.people.push(person);
			else agg.set(key, { from: from.id, to: to.id, at: to.start, people: [person] });
		}
	}
	return [...agg.values()].sort((a, b) => a.at - b.at);
}

/**
 * Global left-to-right rank per event.
 *
 * Seeded by start time, then relaxed with a weighted barycentre sweep: each event
 * drifts toward the average position of the events people flow to and from. Events
 * that exchange lots of people end up adjacent, which is what keeps arrows short
 * and un-crossed. Ranks are re-normalised to 0..n-1 after every pass so the scale
 * can't run away.
 */
export function rankEvents(events: LayoutEvent[], flows: Flow[], passes = 12): Map<string, number> {
	const order = [...events].sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : 1));
	const rank = new Map<string, number>(order.map((e, i) => [e.id, i]));
	if (events.length < 3 || flows.length === 0) return rank;

	// Undirected adjacency: a hop pulls both endpoints together.
	const neighbours = new Map<string, { id: string; w: number }[]>();
	const link = (a: string, b: string, w: number) => {
		const list = neighbours.get(a);
		if (list) list.push({ id: b, w });
		else neighbours.set(a, [{ id: b, w }]);
	};
	for (const f of flows) {
		const w = f.people.length;
		link(f.from, f.to, w);
		link(f.to, f.from, w);
	}

	for (let pass = 0; pass < passes; pass++) {
		const next = new Map<string, number>();
		for (const ev of order) {
			const adj = neighbours.get(ev.id);
			const self = rank.get(ev.id) ?? 0;
			if (!adj || adj.length === 0) {
				next.set(ev.id, self);
				continue;
			}
			let sum = self;
			let weight = 1;
			for (const n of adj) {
				sum += (rank.get(n.id) ?? 0) * n.w;
				weight += n.w;
			}
			next.set(ev.id, sum / weight);
		}
		// Re-normalise to dense integer ranks, breaking ties by start time.
		const sorted = [...order].sort(
			(a, b) =>
				(next.get(a.id) ?? 0) - (next.get(b.id) ?? 0) ||
				a.start - b.start ||
				(a.id < b.id ? -1 : 1)
		);
		sorted.forEach((e, i) => rank.set(e.id, i));
	}
	return rank;
}

/**
 * Arrows cross when one starts left of another but ends right of it. Counted over
 * every pair of flows so the result is comparable between candidate orderings.
 */
export function countCrossings(flows: Flow[], rank: Map<string, number>): number {
	let n = 0;
	for (let i = 0; i < flows.length; i++) {
		for (let j = i + 1; j < flows.length; j++) {
			const a = flows[i];
			const b = flows[j];
			const a1 = rank.get(a.from) ?? 0;
			const a2 = rank.get(a.to) ?? 0;
			const b1 = rank.get(b.from) ?? 0;
			const b2 = rank.get(b.to) ?? 0;
			if ((a1 - b1) * (a2 - b2) < 0) n++;
		}
	}
	return n;
}

/** Transitively-overlapping groups. Widths are computed per cluster. */
function clusterize(events: LayoutEvent[]): LayoutEvent[][] {
	const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end);
	const out: LayoutEvent[][] = [];
	let current: LayoutEvent[] = [];
	let clusterEnd = -Infinity;
	for (const ev of sorted) {
		if (current.length && ev.start >= clusterEnd) {
			out.push(current);
			current = [];
			clusterEnd = -Infinity;
		}
		current.push(ev);
		clusterEnd = Math.max(clusterEnd, ev.end);
	}
	if (current.length) out.push(current);
	return out;
}

/**
 * Full layout: rank events to minimise arrow crossings, pack each overlap cluster
 * into as few columns as possible in rank order, then let every event expand right
 * into any columns that stay free for its whole duration.
 */
export function layoutDay(events: LayoutEvent[]): Layout {
	const flows = buildFlows(events);
	const rank = rankEvents(events, flows);
	const placed = new Map<string, Placed>();

	for (const cluster of clusterize(events)) {
		// Columns are filled in rank order so horizontal position follows the
		// crossing-minimised ordering rather than raw start time.
		const byRank = [...cluster].sort(
			(a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) || a.start - b.start
		);
		const columns: LayoutEvent[][] = [];
		const colOf = new Map<string, number>();
		for (const ev of byRank) {
			let target = columns.findIndex((col) => col.every((other) => !overlaps(ev, other)));
			if (target === -1) {
				columns.push([]);
				target = columns.length - 1;
			}
			columns[target].push(ev);
			colOf.set(ev.id, target);
		}

		const cols = columns.length;
		for (const ev of cluster) {
			const col = colOf.get(ev.id) ?? 0;
			// Grow rightwards while the neighbouring column is free for this event's span.
			let span = 1;
			while (
				col + span < cols &&
				columns[col + span].every((other) => other.id === ev.id || !overlaps(ev, other))
			) {
				span++;
			}
			placed.set(ev.id, {
				id: ev.id,
				left: col / cols,
				width: span / cols,
				col,
				cols,
				rank: rank.get(ev.id) ?? 0
			});
		}
	}

	return { placed, flows, crossings: countCrossings(flows, rank) };
}

export type Band = {
	eventId: string | null;
	start: number;
	end: number;
};

/**
 * Per-person contiguous bands across the day, for the swimlane view. Gaps between
 * events become `eventId: null` bands so each person's row is a continuous strip
 * from `dayStart` to `dayEnd`.
 */
export function personBands(
	events: LayoutEvent[],
	people: string[],
	dayStart: number,
	dayEnd: number
): Map<string, Band[]> {
	const out = new Map<string, Band[]>();
	for (const person of people) {
		const mine = events
			.filter((e) => e.people.includes(person))
			.sort((a, b) => a.start - b.start || a.end - b.end);
		const bands: Band[] = [];
		let cursor = dayStart;
		for (const ev of mine) {
			const s = Math.max(dayStart, ev.start);
			const e = Math.min(dayEnd, ev.end);
			if (e <= cursor) continue;
			if (s > cursor) bands.push({ eventId: null, start: cursor, end: s });
			bands.push({ eventId: ev.id, start: Math.max(s, cursor), end: e });
			cursor = e;
		}
		if (cursor < dayEnd) bands.push({ eventId: null, start: cursor, end: dayEnd });
		out.set(person, bands);
	}
	return out;
}
