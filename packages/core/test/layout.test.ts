import { describe, expect, it } from 'vitest';
import { buildFlows, countCrossings, layoutDay, rankEvents, type LayoutEvent } from '@trippy/core/layout';

function placed(events: LayoutEvent[]) {
	return layoutDay(events).placed;
}

describe('layoutDay', () => {
	it('returns empty placement and flows for empty input', () => {
		const out = layoutDay([]);

		expect(out.placed.size).toBe(0);
		expect(out.flows).toEqual([]);
		// The crossing count is a test-only measure now, not part of every layout.
		expect('crossings' in out).toBe(false);
	});

	it('places a single interval at full width', () => {
		const out = placed([{ id: 'breakfast', start: 9 * 60, end: 10 * 60, people: ['a'] }]);

		expect(out.get('breakfast')).toMatchObject({ left: 0, width: 1, col: 0, cols: 1, rank: 0 });
	});

	it('places overlapping intervals in separate columns', () => {
		const out = placed([
			{ id: 'breakfast', start: 9 * 60, end: 10 * 60, people: ['a'] },
			{ id: 'museum', start: 9 * 60 + 30, end: 11 * 60, people: ['b'] }
		]);

		expect(out.get('breakfast')).toMatchObject({ width: 0.5, cols: 2 });
		expect(out.get('museum')).toMatchObject({ width: 0.5, cols: 2 });
		expect(out.get('breakfast')?.left).not.toBe(out.get('museum')?.left);
	});

	it('lets adjacent intervals use the full width', () => {
		const out = placed([
			{ id: 'breakfast', start: 9 * 60, end: 10 * 60, people: ['a'] },
			{ id: 'museum', start: 10 * 60, end: 11 * 60, people: ['a'] }
		]);

		expect(out.get('breakfast')).toMatchObject({ left: 0, width: 1, cols: 1 });
		expect(out.get('museum')).toMatchObject({ left: 0, width: 1, cols: 1 });
	});

	it('lets adjacent intervals share a column inside an overlapping cluster', () => {
		const out = placed([
			{ id: 'early', start: 9 * 60, end: 10 * 60, people: ['a'] },
			{ id: 'middle', start: 9 * 60 + 30, end: 10 * 60 + 30, people: ['b'] },
			{ id: 'late', start: 10 * 60, end: 11 * 60, people: ['a'] }
		]);

		expect(out.get('early')).toMatchObject({ col: 0, cols: 2 });
		expect(out.get('late')).toMatchObject({ col: 0, cols: 2 });
		expect(out.get('middle')).toMatchObject({ col: 1, cols: 2 });
	});

	it('keeps a fully contained interval from sharing the containing interval column', () => {
		const out = placed([
			{ id: 'free-day', start: 9 * 60, end: 12 * 60, people: ['a'] },
			{ id: 'tour', start: 10 * 60, end: 11 * 60, people: ['b'] }
		]);

		expect(out.get('free-day')).toMatchObject({ width: 0.5, cols: 2 });
		expect(out.get('tour')).toMatchObject({ width: 0.5, cols: 2 });
		expect(out.get('free-day')?.left).not.toBe(out.get('tour')?.left);
	});

	it('places identical intervals in separate columns', () => {
		const out = placed([
			{ id: 'tour-a', start: 10 * 60, end: 11 * 60, people: ['a'] },
			{ id: 'tour-b', start: 10 * 60, end: 11 * 60, people: ['b'] },
			{ id: 'tour-c', start: 10 * 60, end: 11 * 60, people: ['c'] }
		]);

		expect(out.get('tour-a')).toMatchObject({ width: 1 / 3, cols: 3 });
		expect(out.get('tour-b')).toMatchObject({ width: 1 / 3, cols: 3 });
		expect(out.get('tour-c')).toMatchObject({ width: 1 / 3, cols: 3 });
		expect(new Set([...out.values()].map((event) => event.col))).toEqual(new Set([0, 1, 2]));
	});

	it('permits a single zero-length interval', () => {
		const out = placed([{ id: 'marker', start: 10 * 60, end: 10 * 60, people: ['a'] }]);

		expect(out.get('marker')).toMatchObject({ left: 0, width: 1, col: 0, cols: 1 });
	});

});

describe('buildFlows', () => {
	it('aggregates consecutive movements shared by multiple people', () => {
		const flows = buildFlows([
			{ id: 'breakfast', start: 9 * 60, end: 10 * 60, people: ['alice', 'bob'] },
			{ id: 'museum', start: 10 * 60, end: 12 * 60, people: ['alice', 'bob'] }
		]);

		expect(flows).toEqual([{ from: 'breakfast', to: 'museum', at: 10 * 60, people: ['alice', 'bob'] }]);
	});

	it('ignores duplicate adjacent events with the same id', () => {
		const flows = buildFlows([
			{ id: 'train', start: 9 * 60, end: 10 * 60, people: ['alice'] },
			{ id: 'train', start: 10 * 60, end: 11 * 60, people: ['alice'] }
		]);

		expect(flows).toEqual([]);
	});
});

describe('rankEvents and countCrossings', () => {
	it('keeps start order when fewer than three events are ranked', () => {
		const ranks = rankEvents([
			{ id: 'late', start: 10 * 60, end: 11 * 60, people: [] },
			{ id: 'early', start: 9 * 60, end: 10 * 60, people: [] }
		], []);

		expect(ranks.get('early')).toBe(0);
		expect(ranks.get('late')).toBe(1);
	});

	it('counts crossing flow pairs from rank order', () => {
		const rank = new Map([
			['a', 0],
			['b', 1],
			['c', 1],
			['d', 0]
		]);

		expect(countCrossings([
			{ from: 'a', to: 'c', at: 10 * 60, people: ['alice'] },
			{ from: 'b', to: 'd', at: 10 * 60, people: ['bob'] }
		], rank)).toBe(1);
	});
});
