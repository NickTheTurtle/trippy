// Sample itinerary data, modeled on a real multi-city trip. The demo account is
// seeded from it (see packages/server/src/seed-example.ts) so a fresh install
// has something to click around in.

import type { EventType } from './types';

export interface City {
	id: string;
	name: string;
	country: string;
	tz: string;
	lat?: number;
	lng?: number;
}

export interface SampleTrip {
	id: string;
	name: string;
	dates: string;
	startDate: string;
	endDate: string;
	cover: string; // gradient
	members: string[];
	homeCurrency: string;
	cities: City[];
}

export const trips: SampleTrip[] = [
	{
		id: 'china-2026',
		name: 'China, autumn',
		dates: 'Oct 24 – Nov 8, 2026',
		startDate: '2026-10-24',
		endDate: '2026-11-08',
		cover: 'linear-gradient(135deg, #2f6d5e, #7ba697)',
		members: ['You', 'May', 'Jordan', 'Priya'],
		homeCurrency: 'USD',
		cities: [
			{
				id: 'bjs',
				name: 'Beijing',
				country: 'China',
				tz: 'Asia/Shanghai',
				lat: 39.9042,
				lng: 116.4074
			},
			{
				id: 'ckg',
				name: 'Chongqing',
				country: 'China',
				tz: 'Asia/Shanghai',
				lat: 29.563,
				lng: 106.5516
			},
			{
				id: 'kwl',
				name: 'Guilin',
				country: 'China',
				tz: 'Asia/Shanghai',
				lat: 25.2736,
				lng: 110.2907
			},
			{
				id: 'hgh',
				name: 'Hangzhou',
				country: 'China',
				tz: 'Asia/Shanghai',
				lat: 30.2741,
				lng: 120.1551
			},
			{
				id: 'sha',
				name: 'Shanghai',
				country: 'China',
				tz: 'Asia/Shanghai',
				lat: 31.2304,
				lng: 121.4737
			}
		]
	},
	{
		id: 'athens-2026',
		name: 'Athens escape marathon',
		dates: 'Apr 16 – 20, 2026',
		startDate: '2026-04-16',
		endDate: '2026-04-20',
		cover: 'linear-gradient(135deg, #2f5d8a, #86b7dd)',
		members: ['You', '+19 others'],
		homeCurrency: 'EUR',
		cities: [
			{
				id: 'ath',
				name: 'Athens',
				country: 'Greece',
				tz: 'Europe/Athens',
				lat: 37.9838,
				lng: 23.7275
			}
		]
	}
];

export function getTrip(id: string): SampleTrip | undefined {
	return trips.find((t) => t.id === id);
}

// A single day for the schedule mock. Tracks are gone: an event carries the
// people who are at it, and who splits off is read from that rather than from
// which lane someone dropped it in. `people` indexes into the trip's member
// list, because the sample has no user ids of its own.
export interface SampleEvent {
	start: string;
	end: string;
	title: string;
	type: EventType;

	people: number[];
	lat?: number;
	lng?: number;
}

export const sampleDay = {
	date: 'Mon, Oct 26',
	city: 'Beijing',
	// Everyone starts the morning at the same hotel, then the group splits in two
	// for the day and eats apart. Nobody declared a split: it is simply that the
	// eleven o'clock events have different people on them, which is the whole
	// point of the model and the reason this sample is worth seeding.
	events: [
		{
			start: '08:30',
			end: '11:00',
			title: 'Forbidden City',
			type: 'activity',
			people: [0, 1],
			lat: 39.9163,
			lng: 116.3972
		},
		{
			start: '11:20',
			end: '12:00',
			title: 'Tiananmen Square',
			type: 'activity',
			people: [0, 1],
			lat: 39.9055,
			lng: 116.3976
		},
		{
			start: '12:10',
			end: '13:10',
			title: 'Lunch, Wangfujing',
			type: 'food',
			people: [0, 1],
			lat: 39.9149,
			lng: 116.4108
		},
		{
			start: '14:30',
			end: '16:00',
			title: 'Temple of Heaven',
			type: 'activity',
			people: [0, 1],
			lat: 39.8822,
			lng: 116.4066
		},
		{
			start: '09:00',
			end: '10:30',
			title: 'Hutong food walk',
			type: 'activity',
			people: [2, 3],
			lat: 39.9368,
			lng: 116.403
		},
		{
			start: '10:45',
			end: '11:30',
			title: 'Boba, 1点点',
			type: 'food',
			people: [2, 3],
			lat: 39.937,
			lng: 116.4035
		},
		{
			start: '12:00',
			end: '13:30',
			title: 'Lunch, Guijie',
			type: 'food',
			people: [2, 3],
			lat: 39.9469,
			lng: 116.4189
		},
		{ start: '14:00', end: '17:00', title: 'Free time', type: 'freetime', people: [2, 3] },
		// The stay is one row spanning the night: check-in on this evening,
		// checkout the next morning. It anchors both ends of the day.
		{
			start: '21:00',
			end: '09:00',
			title: 'Hotel Éclat',
			type: 'stay',
			people: [0, 1, 2, 3],
			lat: 39.9089,
			lng: 116.4577
		}
	] as SampleEvent[]
};
