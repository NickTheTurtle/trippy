// Sample data so the UI is explorable before the backend exists.
// Modeled on a real multi-city itinerary.

export interface City {
	id: string;
	name: string;
	country: string;
	tz: string;
	arrive: string; // ISO date
	depart: string;
	lat?: number;
	lng?: number;
}

export interface SampleTrip {
	id: string;
	name: string;
	dates: string;
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
		cover: 'linear-gradient(135deg, #2f6d5e, #7ba697)',
		members: ['You', 'May', 'Jordan', 'Priya'],
		homeCurrency: 'USD',
		cities: [
			{ id: 'bjs', name: 'Beijing', country: 'China', tz: 'Asia/Shanghai', arrive: '2026-10-24', depart: '2026-10-28', lat: 39.9042, lng: 116.4074 },
			{ id: 'ckg', name: 'Chongqing', country: 'China', tz: 'Asia/Shanghai', arrive: '2026-10-28', depart: '2026-10-31', lat: 29.563, lng: 106.5516 },
			{ id: 'kwl', name: 'Guilin', country: 'China', tz: 'Asia/Shanghai', arrive: '2026-10-31', depart: '2026-11-03', lat: 25.2736, lng: 110.2907 },
			{ id: 'hgh', name: 'Hangzhou', country: 'China', tz: 'Asia/Shanghai', arrive: '2026-11-03', depart: '2026-11-05', lat: 30.2741, lng: 120.1551 },
			{ id: 'sha', name: 'Shanghai', country: 'China', tz: 'Asia/Shanghai', arrive: '2026-11-05', depart: '2026-11-08', lat: 31.2304, lng: 121.4737 }
		]
	},
	{
		id: 'athens-2026',
		name: 'Athens escape marathon',
		dates: 'Apr 16 – 20, 2026',
		cover: 'linear-gradient(135deg, #2f5d8a, #86b7dd)',
		members: ['You', '+19 others'],
		homeCurrency: 'EUR',
		cities: [
			{ id: 'ath', name: 'Athens', country: 'Greece', tz: 'Europe/Athens', arrive: '2026-04-16', depart: '2026-04-20', lat: 37.9838, lng: 23.7275 }
		]
	}
];

export function getTrip(id: string): SampleTrip | undefined {
	return trips.find((t) => t.id === id);
}

// A single day, two parallel tracks, for the calendar mock.
export interface Block {
	start: string;
	end: string;
	title: string;
	type: 'poi' | 'meal' | 'travel' | 'freetime';
	booking?: 'booked' | 'tentative' | 'unbooked';
	travelToNext?: { mode: string; mins: number };
}

export interface Track {
	id: string;
	name: string;
	color: string;
	blocks: Block[];
}

export const sampleDay = {
	date: 'Mon, Oct 26',
	city: 'Beijing',
	tracks: [
		{
			id: 't1',
			name: 'History group',
			color: '#2f6d5e',
			blocks: [
				{ start: '08:30', end: '11:00', title: 'Forbidden City', type: 'poi', booking: 'booked', travelToNext: { mode: 'transit', mins: 20 } },
				{ start: '11:20', end: '12:00', title: 'Tiananmen Square', type: 'poi', booking: 'booked', travelToNext: { mode: 'walk', mins: 10 } },
				{ start: '12:10', end: '13:10', title: 'Lunch, Wangfujing', type: 'meal', booking: 'tentative', travelToNext: { mode: 'drive', mins: 25 } },
				{ start: '14:30', end: '16:00', title: 'Temple of Heaven', type: 'poi', booking: 'unbooked' }
			]
		},
		{
			id: 't2',
			name: 'Foodie group',
			color: '#b4682a',
			blocks: [
				{ start: '09:00', end: '10:30', title: 'Hutong food walk', type: 'poi', booking: 'booked', travelToNext: { mode: 'transit', mins: 15 } },
				{ start: '10:45', end: '11:30', title: 'Boba, 1点点', type: 'meal', booking: 'booked', travelToNext: { mode: 'walk', mins: 12 } },
				{ start: '12:00', end: '13:30', title: 'Lunch, Guijie', type: 'meal', booking: 'tentative' },
				{ start: '14:00', end: '17:00', title: 'Free time', type: 'freetime' }
			]
		}
	] as Track[]
};
