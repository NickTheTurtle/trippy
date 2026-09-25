import { describe, expect, it } from 'vitest';
import {
	buildScheduleMapModel,
	frameRegion,
	groupPins
} from '../../../apps/mobile/src/screens/schedule/mapModel';

describe('mobile schedule map model', () => {
	it('groups colocated pins with the same colour', () => {
		const grouped = groupPins([
			{
				key: 'a',
				lat: 1,
				lng: 2,
				title: 'A',
				detail: ['one'],
				color: '#123',
				count: 1,
				eventIds: ['a']
			},
			{
				key: 'b',
				lat: 1,
				lng: 2,
				title: 'B',
				detail: ['two'],
				color: '#123',
				count: 1,
				eventIds: ['b']
			}
		]);
		expect(grouped).toHaveLength(1);
		expect(grouped[0].count).toBe(2);
		expect(grouped[0].eventIds).toEqual(['a', 'b']);
	});

	it('frames pins before city fallback', () => {
		const region = frameRegion(
			[
				{
					key: 'a',
					lat: 10,
					lng: 20,
					title: 'A',
					detail: [],
					color: '#123',
					count: 1,
					eventIds: []
				},
				{
					key: 'b',
					lat: 11,
					lng: 21,
					title: 'B',
					detail: [],
					color: '#123',
					count: 1,
					eventIds: []
				}
			],
			{ id: 'c', name: 'City', tz: 'UTC', lat: 1, lng: 2 }
		);
		expect(region.latitude).toBe(10.5);
		expect(region.longitude).toBe(20.5);
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
});

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
