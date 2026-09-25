import { describe, expect, it } from 'vitest';
import {
	buildScheduleMapModel,
	frameRegion,
	groupPins
} from '../../../apps/mobile/src/screens/schedule/mapModel';

describe('mobile schedule map model', () => {
	it('groups colocated pins even with different colours', () => {
		const grouped = groupPins([pin('a', 1, 2, '#123', ['a']), pin('b', 1, 2, '#456', ['b'])]);
		expect(grouped).toHaveLength(1);
		expect(grouped[0].count).toBe(2);
		expect(grouped[0].eventIds).toEqual(['a', 'b']);
	});

	it('does not frame saved-only pins', () => {
		const region = frameRegion(
			[pin('saved-a', 10, 20, '#123', []), pin('saved-b', 11, 21, '#123', [])],
			{ id: 'c', name: 'City', tz: 'UTC', lat: 1, lng: 2 }
		);
		expect(region.latitude).toBe(1);
		expect(region.longitude).toBe(2);
	});

	it('frames scheduled pins over saved pins', () => {
		const region = frameRegion(
			[pin('a', 10, 20, '#123', ['a']), pin('saved', 50, 60, '#999', [])],
			{ id: 'c', name: 'City', tz: 'UTC', lat: 1, lng: 2 }
		);
		expect(region.latitude).toBe(10);
		expect(region.longitude).toBe(20);
	});

	it('uses the shortest longitude arc across the dateline', () => {
		const region = frameRegion(
			[pin('a', 10, 179, '#123', ['a']), pin('b', 10, -179, '#123', ['b'])],
			null
		);
		expect(Math.abs(Math.abs(region.longitude) - 180)).toBeLessThan(0.0001);
		expect(region.longitudeDelta).toBeLessThan(5);
	});

	it('builds event routes per member', () => {
		const model = buildScheduleMapModel({
			events: [
				event('a', 9 * 60, 10, 20, []),
				event('b', 10 * 60, 11, 21, ['p1']),
				event('c', 11 * 60, 12, 22, ['p2'])
			],
			stays: [],
			legs: [],
			saved: [],
			city: null,
			memberIds: ['p1', 'p2'],
			peopleLabel: (ids) => ids.join(',') || 'Everyone',
			locked: false
		});
		expect(model.routes).toHaveLength(2);
		expect(model.routes.map((route) => route.points.length)).toEqual([2, 2]);
	});

	it('keeps locked saved pins but removes add actions', () => {
		const model = buildScheduleMapModel({
			events: [],
			stays: [],
			legs: [],
			saved: [{ id: 'p', name: 'Saved', city_id: 'c', lat: 1, lng: 2, votes: 0 }],
			city: { id: 'c', name: 'City', tz: 'UTC', lat: 1, lng: 2 },
			memberIds: ['p1'],
			peopleLabel: () => 'Everyone',
			locked: true
		});
		expect(model.pins).toHaveLength(1);
		expect(model.pins[0].addId).toBeUndefined();
	});

	it('includes stay pins', () => {
		const model = buildScheduleMapModel({
			events: [],
			stays: [{ ...event('stay', 0, 1, 2, []), type: 'stay' as const }],
			legs: [],
			saved: [],
			city: null,
			memberIds: ['p1'],
			peopleLabel: () => 'Everyone',
			locked: false
		});
		expect(model.pins[0].eventIds).toEqual(['stay']);
	});

	it('does not number overlapping split days unless reading one person', () => {
		const base = {
			events: [event('a', 9 * 60, 1, 2, ['p1']), event('b', 9 * 60 + 10, 3, 4, ['p2'])],
			stays: [],
			legs: [],
			saved: [],
			city: null,
			memberIds: ['p1', 'p2'],
			peopleLabel: (ids: string[]) => ids.join(',') || 'Everyone',
			locked: false
		};
		expect(buildScheduleMapModel(base).pins.map((p) => p.number)).toEqual([undefined, undefined]);
		expect(
			buildScheduleMapModel({ ...base, memberIds: ['p1'], singleViewer: true }).pins[0].number
		).toBe(1);
	});
});

function pin(key: string, lat: number, lng: number, color: string, eventIds: string[]) {
	return {
		key,
		lat,
		lng,
		title: key,
		detail: [],
		entries: [{ title: key, detail: [], eventId: eventIds[0] }],
		color,
		count: 1,
		eventIds
	};
}

function event(id: string, start: number, lat: number, lng: number, people: string[]) {
	return {
		id,
		day: '2026-04-16',
		end_day: null,
		title: id,
		type: 'activity' as const,
		start_min: start,
		end_min: start + 30,
		poi_id: null,
		lodging_id: null,
		place_text: null,
		city_id: null,
		lat,
		lng,
		notes: null,
		travel_mode: null,
		people,
		version: 1
	};
}
