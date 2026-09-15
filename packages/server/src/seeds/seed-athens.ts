import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { poiKindFromCategory, type EventType } from '@trippy/core/types';
import { recomputeLegs } from '../persistence/schedule';

/**
 * A 20-person escape-room trip to Athens.
 *
 * Escape rooms seat four, so twenty people means five rooms running at once,
 * which is exactly the case the calendar's layout engine exists for. Teams are
 * reshuffled between slots (a cyclic rotation on day 2, a full redraft on day 3)
 * so the flow arrows and one person's agenda have real switching to draw, and
 * the group repeatedly collapses back into one full-width block for meals.
 *
 * Assignees on each item are the single source of truth for who is where.
 */

export const ATHENS_TRIP = {
	name: 'Athens escape marathon',
	dates: 'Apr 16 – 20, 2026',
	startDate: '2026-04-16',
	endDate: '2026-04-20',
	cover: 'linear-gradient(135deg, #2f5d8a, #86b7dd)',
	homeCurrency: 'EUR',
	city: {
		name: 'Athens',
		country: 'Greece',
		tz: 'Europe/Athens',
		lat: 37.9838,
		lng: 23.7275
	}
};

/** 19 companions + the organizer = 20 travellers = five rooms of four. */
export const COMPANIONS = [
	'Nikos',
	'Elena',
	'Marcus',
	'Yuki',
	'Priya',
	'Tomas',
	'Sofia',
	'Adaeze',
	'Liam',
	'Mei',
	'Rafael',
	'Hannah',
	'Omar',
	'Ingrid',
	'Diego',
	'Zoe',
	'Ravi',
	'Clara',
	'Jonas'
];

/**
 * The venues the day is built around. They used to be lanes on the board; now
 * they are only coordinates, because where an event is and who is going to it
 * are the two facts the schedule needs and a lane was neither.
 */
const COORDS: Record<string, [number, number]> = {
	great: [37.9765, 23.7255],
	locked: [37.9793, 23.7228],
	mystery: [37.9646, 23.7248],
	paradox: [37.9782, 23.7405],
	vault: [37.9856, 23.7333],
	hotel: [37.9718, 23.729],
	psyrri: [37.979, 23.725],
	plaka: [37.972, 23.73],
	acropolis: [37.9715, 23.7257],
	acropolisMuseum: [37.9686, 23.7286],
	filopappou: [37.9668, 23.7189],
	agora: [37.9755, 23.722],
	monastiraki: [37.976, 23.725],
	kolonaki: [37.9787, 23.7418],
	exarchia: [37.9862, 23.7345],
	vouliagmeni: [37.806, 23.781],
	airport: [37.9364, 23.9445]
};

type Kind = EventType;

interface Ev {
	title: string;
	type: Kind;
	/** Minutes from midnight. A stay's `end` is a checkout the next morning. */
	start: number;
	end: number;
	place?: keyof typeof COORDS;
	/** Member indices; 0 is the organizer. */
	who: number[];
}

const hm = (h: number, m = 0) => h * 60 + m;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ALL = range(0, 19);
const except = (...out: number[]) => ALL.filter((i) => !out.includes(i));

const DAYS: { day: string; events: Ev[] }[] = [
	// ── Day 1: land, then two warm-up waves so half the group is always in a room.
	{
		day: '2026-04-16',
		events: [
			{
				title: 'Airport → Plaka apartments',
				type: 'travel',
				start: hm(10),
				end: hm(11, 15),
				place: 'hotel',
				who: ALL
			},
			{
				title: 'Welcome brunch, Psyrri',
				type: 'food',
				start: hm(11, 30),
				end: hm(13),
				place: 'psyrri',
				who: ALL
			},

			{
				title: "Warm-up: The Alchemist's Study",
				type: 'activity',
				start: hm(13, 30),
				end: hm(15),
				place: 'great',
				who: range(0, 3)
			},
			{
				title: "Warm-up: Pharaoh's Tomb",
				type: 'activity',
				start: hm(13, 30),
				end: hm(15),
				place: 'locked',
				who: range(4, 7)
			},
			{
				title: 'Acropolis Museum',
				type: 'activity',
				start: hm(13, 30),
				end: hm(15),
				place: 'acropolisMuseum',
				who: range(8, 19)
			},

			{
				title: 'Warm-up: Submarine 1943',
				type: 'activity',
				start: hm(15, 30),
				end: hm(17),
				place: 'mystery',
				who: range(8, 11)
			},
			{
				title: 'Warm-up: Bank Heist',
				type: 'activity',
				start: hm(15, 30),
				end: hm(17),
				place: 'paradox',
				who: range(12, 15)
			},
			{
				title: 'Free time, Plaka',
				type: 'freetime',
				start: hm(15, 30),
				end: hm(17),
				who: [...range(0, 7), ...range(16, 19)]
			},

			{
				title: 'Sunset, Filopappou Hill',
				type: 'activity',
				start: hm(17, 15),
				end: hm(18),
				place: 'filopappou',
				who: ALL
			},

			{
				title: 'Plaka apartments',
				type: 'stay',
				start: hm(21),
				end: hm(8),
				place: 'hotel',
				who: ALL
			}
		]
	},

	// ── Day 2 (showpiece): five rooms, twice, with a one-person cyclic rotation
	// between the slots; lunch collapses everyone back into one block.
	{
		day: '2026-04-17',
		events: [
			{
				title: "Round 1: Da Vinci's Workshop",
				type: 'activity',
				start: hm(9, 30),
				end: hm(11),
				place: 'great',
				who: [0, 1, 2, 3]
			},
			{
				title: 'Round 1: The Oracle at Delphi',
				type: 'activity',
				start: hm(9, 30),
				end: hm(11),
				place: 'locked',
				who: [4, 5, 6, 7]
			},
			{
				title: 'Round 1: Submarine 1943',
				type: 'activity',
				start: hm(9, 30),
				end: hm(11),
				place: 'mystery',
				who: [8, 9, 10, 11]
			},
			{
				title: 'Round 1: Bank Heist',
				type: 'activity',
				start: hm(9, 30),
				end: hm(11),
				place: 'paradox',
				who: [12, 13, 14, 15]
			},
			{
				title: 'Round 1: Asylum',
				type: 'activity',
				start: hm(9, 30),
				end: hm(11),
				place: 'vault',
				who: [16, 17, 18, 19]
			},

			// Rotation: the last player of each team moves to the next team.
			{
				title: "Round 2: Minotaur's Labyrinth",
				type: 'activity',
				start: hm(11, 30),
				end: hm(13),
				place: 'great',
				who: [0, 1, 2, 19]
			},
			{
				title: 'Round 2: Zombie Lab',
				type: 'activity',
				start: hm(11, 30),
				end: hm(13),
				place: 'locked',
				who: [3, 4, 5, 6]
			},
			{
				title: 'Round 2: The Lost Temple',
				type: 'activity',
				start: hm(11, 30),
				end: hm(13),
				place: 'mystery',
				who: [7, 8, 9, 10]
			},
			{
				title: 'Round 2: Prison Break',
				type: 'activity',
				start: hm(11, 30),
				end: hm(13),
				place: 'paradox',
				who: [11, 12, 13, 14]
			},
			{
				title: "Round 2: Sherlock's Study",
				type: 'activity',
				start: hm(11, 30),
				end: hm(13),
				place: 'vault',
				who: [15, 16, 17, 18]
			},

			{
				title: 'Lunch, Karamanlidika',
				type: 'food',
				start: hm(13, 15),
				end: hm(14, 15),
				place: 'psyrri',
				who: ALL
			},

			{
				title: 'Room: Nautilus',
				type: 'activity',
				start: hm(14, 30),
				end: hm(16),
				place: 'mystery',
				who: [0, 1, 4, 5]
			},
			{
				title: 'Room: The Vault',
				type: 'activity',
				start: hm(14, 30),
				end: hm(16),
				place: 'vault',
				who: [8, 9, 12, 13]
			},
			{
				title: 'Acropolis & Parthenon',
				type: 'activity',
				start: hm(14, 30),
				end: hm(16),
				place: 'acropolis',
				who: [2, 3, 6, 7, 10, 11]
			},
			{
				title: 'Plaka & Anafiotika food walk',
				type: 'activity',
				start: hm(14, 30),
				end: hm(16),
				place: 'plaka',
				who: [14, 15, 16, 17, 18, 19]
			},

			{
				title: 'Rooftop debrief, A for Athens',
				type: 'food',
				start: hm(16, 30),
				end: hm(17, 45),
				place: 'monastiraki',
				who: ALL
			},

			{
				title: 'Plaka apartments',
				type: 'stay',
				start: hm(21),
				end: hm(8),
				place: 'hotel',
				who: ALL
			}
		]
	},

	// ── Day 3: tournament. Teams are redrafted from scratch, so almost everyone
	// switches; then the field narrows to two semis and one final.
	{
		day: '2026-04-18',
		events: [
			{
				title: 'Heat: Alcatraz',
				type: 'activity',
				start: hm(9),
				end: hm(10, 30),
				place: 'great',
				who: [0, 4, 8, 12]
			},
			{
				title: "Heat: Pharaoh's Tomb",
				type: 'activity',
				start: hm(9),
				end: hm(10, 30),
				place: 'locked',
				who: [1, 5, 9, 13]
			},
			{
				title: 'Heat: Space Station',
				type: 'activity',
				start: hm(9),
				end: hm(10, 30),
				place: 'mystery',
				who: [2, 6, 10, 14]
			},
			{
				title: 'Heat: The Heist II',
				type: 'activity',
				start: hm(9),
				end: hm(10, 30),
				place: 'paradox',
				who: [3, 7, 11, 15]
			},
			{
				title: 'Heat: Witch Hunt',
				type: 'activity',
				start: hm(9),
				end: hm(10, 30),
				place: 'vault',
				who: [16, 17, 18, 19]
			},

			{
				title: 'Semifinal: The Oracle at Delphi',
				type: 'activity',
				start: hm(11),
				end: hm(12, 30),
				place: 'locked',
				who: [0, 4, 8, 12]
			},
			{
				title: 'Semifinal: Space Station Redux',
				type: 'activity',
				start: hm(11),
				end: hm(12, 30),
				place: 'mystery',
				who: [2, 6, 10, 14]
			},
			{
				title: 'Recovery brunch, Kolonaki',
				type: 'food',
				start: hm(11),
				end: hm(12, 30),
				place: 'kolonaki',
				who: [1, 3, 5, 7, 9, 11, 13, 15, 16, 17, 18, 19]
			},

			{
				title: 'Ancient Agora walk',
				type: 'activity',
				start: hm(13),
				end: hm(14, 30),
				place: 'agora',
				who: ALL
			},

			{
				title: 'Grand final: Bank Heist',
				type: 'activity',
				start: hm(15),
				end: hm(16, 30),
				place: 'paradox',
				who: [0, 4, 10, 14]
			},
			{
				title: 'Beach afternoon, Vouliagmeni',
				type: 'freetime',
				start: hm(15),
				end: hm(16, 30),
				place: 'vouliagmeni',
				who: except(0, 4, 10, 14)
			},

			{
				title: 'Awards dinner, Psyrri taverna',
				type: 'food',
				start: hm(17, 15),
				end: hm(18),
				place: 'psyrri',
				who: ALL
			},

			{
				title: 'Plaka apartments',
				type: 'stay',
				start: hm(21),
				end: hm(8),
				place: 'hotel',
				who: ALL
			}
		]
	},

	// ── Day 4: one last wave of rooms, then home.
	{
		day: '2026-04-19',
		events: [
			{
				title: 'Monastiraki flea market',
				type: 'activity',
				start: hm(9, 30),
				end: hm(11),
				place: 'monastiraki',
				who: ALL
			},

			{
				title: "Last room: The Alchemist's Study",
				type: 'activity',
				start: hm(11, 15),
				end: hm(12, 45),
				place: 'great',
				who: [0, 1, 2, 3]
			},
			{
				title: 'Last room: Nautilus',
				type: 'activity',
				start: hm(11, 15),
				end: hm(12, 45),
				place: 'mystery',
				who: [4, 5, 6, 7]
			},
			{
				title: 'Coffee & board games, Exarchia',
				type: 'freetime',
				start: hm(11, 15),
				end: hm(12, 45),
				place: 'exarchia',
				who: range(8, 19)
			},

			{
				title: 'Farewell lunch, Plaka',
				type: 'food',
				start: hm(13, 15),
				end: hm(14, 45),
				place: 'plaka',
				who: ALL
			},
			{
				title: 'Depart for ATH airport',
				type: 'travel',
				start: hm(15, 15),
				end: hm(16, 45),
				place: 'airport',
				who: ALL
			}
		]
	}
];

const POIS: {
	name: string;
	category: string;
	notes: string | null;
	place: keyof typeof COORDS;
	saved: number;
	votes: number;
}[] = [
	{
		name: 'Great Escape Athens',
		category: 'Escape room',
		notes: '3 rooms, 2–5 players each',
		place: 'great',
		saved: 1,
		votes: 14
	},
	{
		name: 'Locked Athens',
		category: 'Escape room',
		notes: 'Book the whole venue for 20',
		place: 'locked',
		saved: 1,
		votes: 12
	},
	{
		name: 'Mystery Rooms Athens',
		category: 'Escape room',
		notes: 'Best rated in Koukaki',
		place: 'mystery',
		saved: 1,
		votes: 16
	},
	{
		name: 'Paradox Project',
		category: 'Escape room',
		notes: 'Bank Heist is the hard one',
		place: 'paradox',
		saved: 1,
		votes: 11
	},
	{
		name: 'The Athens Vault',
		category: 'Escape room',
		notes: 'Two rooms run in parallel',
		place: 'vault',
		saved: 1,
		votes: 9
	},
	{
		name: 'Acropolis & Parthenon',
		category: 'History',
		notes: 'Go before 10:00 or after 16:00',
		place: 'acropolis',
		saved: 1,
		votes: 15
	},
	{
		name: 'Acropolis Museum',
		category: 'History',
		notes: null,
		place: 'acropolisMuseum',
		saved: 1,
		votes: 10
	},
	{ name: 'Ancient Agora', category: 'History', notes: null, place: 'agora', saved: 1, votes: 8 },
	{
		name: 'Filopappou Hill',
		category: 'Nature',
		notes: 'Sunset over the Acropolis',
		place: 'filopappou',
		saved: 1,
		votes: 7
	},
	{
		name: 'Monastiraki flea market',
		category: 'Shopping',
		notes: 'Sunday is the big one',
		place: 'monastiraki',
		saved: 1,
		votes: 6
	},
	{
		name: 'Vouliagmeni beach',
		category: 'Nature',
		notes: '40 min by coach',
		place: 'vouliagmeni',
		saved: 0,
		votes: 9
	},
	{
		name: 'Karamanlidika, Psyrri',
		category: 'Food',
		notes: 'Can seat 20 with notice',
		place: 'psyrri',
		saved: 0,
		votes: 12
	},
	{
		name: 'A for Athens rooftop',
		category: 'Food',
		notes: 'Reserve the terrace',
		place: 'monastiraki',
		saved: 0,
		votes: 11
	}
];

/** Seed the whole Athens trip for `userId` (who becomes the organizer). */
export function seedAthensTrip(db: DatabaseSync, userId: string): string {
	const now = Date.now();
	const tripId = randomUUID();

	db.prepare(
		`INSERT INTO trips (id, organizer_id, name, dates, cover, home_currency, start_date, end_date, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		tripId,
		userId,
		ATHENS_TRIP.name,
		ATHENS_TRIP.dates,
		ATHENS_TRIP.cover,
		ATHENS_TRIP.homeCurrency,
		ATHENS_TRIP.startDate,
		ATHENS_TRIP.endDate,
		now
	);
	db.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'organizer')`).run(
		tripId,
		userId
	);

	const c = ATHENS_TRIP.city;
	const cityId = randomUUID();
	db.prepare(
		`INSERT INTO cities (id, trip_id, name, country, tz, lat, lng, sort)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
	).run(cityId, tripId, c.name, c.country, c.tz, c.lat, c.lng);

	// Roster: index 0 is the organizer, 1..19 are seeded companions.
	const insertUser = db.prepare(
		`INSERT INTO users (id, email, name, password_hash, home_tz, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	);
	const insertMember = db.prepare(
		`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'member')`
	);
	const roster: string[] = [userId];
	for (const name of COMPANIONS) {
		const id = randomUUID();
		insertUser.run(
			id,
			`${name.toLowerCase()}+${tripId}@example.invalid`,
			name,
			`seed:${randomUUID()}`,
			'UTC',
			now
		);
		insertMember.run(tripId, id);
		roster.push(id);
	}

	seedPois(db, tripId, cityId, roster);
	seedLodging(db, tripId, cityId, roster);
	// After the lodging, so a stay can point at the option the group chose.
	seedAthensSchedule(db, tripId, cityId, roster);
	seedExpenses(db, tripId, roster);
	seedBudget(db, tripId, cityId);
	seedTasks(db, tripId, roster);

	return tripId;
}

/**
 * Lay the five days of events onto a trip, and let the travel fall out of them.
 *
 * Split out of `seedAthensTrip` so the schedule can be re-seeded on its own
 * against a trip that already exists. The rework that replaced tracks with
 * events dropped every scheduled block in the database, and rebuilding the
 * whole demo trip to get the board back would have meant throwing away the
 * expenses, votes and tasks attached to the real one.
 *
 * `roster` is indexed the way the `who` lists are: 0 is the organizer.
 *
 * It deletes the trip's existing events first, so running it twice leaves one
 * copy rather than two. Legs are not deleted explicitly: they cascade from the
 * events they join, and `recomputeLegs` then plans the new ones per day.
 */
export function seedAthensSchedule(
	db: DatabaseSync,
	tripId: string,
	cityId: string,
	roster: string[]
): number {
	const now = Date.now();
	db.prepare(`DELETE FROM events WHERE trip_id = ?`).run(tripId);

	const insertEvent = db.prepare(
		`INSERT INTO events
		 (id, trip_id, day, title, type, start_min, end_min, poi_id, lodging_id, city_id, lat, lng, notes, travel_mode, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?)`
	);
	const insertPerson = db.prepare(`INSERT INTO event_people (event_id, user_id) VALUES (?, ?)`);

	// A stay points at the option the group actually picked, so the lodging a
	// night resolves to is the one fact rather than a title that agrees with it
	// by coincidence. The leading vote stands in for a locked choice.
	const stayOption =
		(
			db
				.prepare(
					`SELECT o.id FROM lodging_options o
					  LEFT JOIN lodging_votes v ON v.option_id = o.id
					  WHERE o.trip_id = ?
					  GROUP BY o.id ORDER BY o.locked DESC, count(v.user_id) DESC LIMIT 1`
				)
				.get(tripId) as { id: string } | undefined
		)?.id ?? null;

	let count = 0;
	for (const d of DAYS) {
		for (const e of d.events) {
			const eventId = randomUUID();
			const co = e.place ? COORDS[e.place] : null;
			insertEvent.run(
				eventId,
				tripId,
				d.day,
				e.title,
				e.type,
				e.start,
				e.end,
				e.type === 'stay' ? stayOption : null,
				cityId,
				co ? co[0] : null,
				co ? co[1] : null,
				now
			);
			for (const w of e.who) insertPerson.run(eventId, roster[w]);
			count++;
		}
	}
	// After every event exists, not per day: a stay is the origin of the next
	// morning's first journey, so planning day N while day N-1 is still empty
	// would plan it without one and leave the morning starting from nowhere.
	for (const d of DAYS) recomputeLegs(tripId, d.day);
	return count;
}

function seedPois(db: DatabaseSync, tripId: string, cityId: string, roster: string[]): void {
	const insertPoi = db.prepare(
		`INSERT INTO pois (id, trip_id, city_id, name, category, kind, notes, url, lat, lng, saved, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
	);
	const insertVote = db.prepare(`INSERT INTO poi_votes (poi_id, user_id) VALUES (?, ?)`);
	const base = Date.now();
	POIS.forEach((p, i) => {
		const id = randomUUID();
		const co = COORDS[p.place];
		// Bucketed the same way the migration backfilled real rows, so a fresh
		// demo database and an existing one classify identically.
		insertPoi.run(
			id,
			tripId,
			cityId,
			p.name,
			p.category,
			poiKindFromCategory(p.category),
			p.notes,
			co[0],
			co[1],
			p.saved,
			base - i * 100
		);
		for (let v = 0; v < Math.min(p.votes, roster.length); v++) insertVote.run(id, roster[v]);
	});
}

function seedLodging(db: DatabaseSync, tripId: string, cityId: string, roster: string[]): void {
	const insertOption = db.prepare(
		`INSERT INTO lodging_options (id, trip_id, city_id, name, tag, price_cents, currency, url, locked, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'EUR', NULL, 0, ?)`
	);
	const insertVote = db.prepare(
		`INSERT INTO lodging_votes (city_id, user_id, option_id) VALUES (?, ?, ?)`
	);
	const base = Date.now();
	// Prices are per night for the whole group of 20.
	const add = (name: string, tag: string, cents: number, at: number) => {
		const id = randomUUID();
		insertOption.run(id, tripId, cityId, name, tag, cents, at);
		return id;
	};
	const plaka = add('Plaka apartments (5 flats)', 'Central, walkable', 62000, base - 4000);
	const koukaki = add('Koukaki villa', 'Quiet, one roof', 54000, base - 3000);
	const hostel = add('Monastiraki hostel takeover', 'Cheapest', 32000, base - 2000);
	add('Syntagma hotel block', 'Hotel service', 78000, base - 1000);

	// 18 of 20 have voted; Plaka leads, Koukaki is a real contender.
	const ballots = [
		...Array(9).fill(plaka),
		...Array(6).fill(koukaki),
		...Array(3).fill(hostel)
	] as string[];
	ballots.forEach((opt, i) => insertVote.run(cityId, roster[i], opt));
}

function seedExpenses(db: DatabaseSync, tripId: string, roster: string[]): void {
	const insertExpense = db.prepare(
		`INSERT INTO expenses (id, trip_id, payer_id, description, amount_cents, currency, split_mode, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const insertPart = db.prepare(
		`INSERT INTO expense_participants (expense_id, user_id, weight) VALUES (?, ?, ?)`
	);
	const base = Date.now();
	const seed = (
		payer: number,
		desc: string,
		cents: number,
		who: number[],
		ago: number,
		currency = 'EUR',
		// Weights are 1 each unless given; see `@trippy/core/split` for what they mean.
		mode: 'even' | 'shares' | 'exact' = 'even',
		weights?: number[]
	) => {
		const id = randomUUID();
		insertExpense.run(id, tripId, roster[payer], desc, cents, currency, mode, base - ago);
		who.forEach((w, i) => insertPart.run(id, roster[w], weights?.[i] ?? 1));
	};
	seed(0, 'Escape room bookings, day 2 (10 rooms)', 120000, ALL, 6000);
	seed(1, 'Airport transfers, 5 vans', 45000, ALL, 5000);
	seed(2, 'Welcome brunch, Psyrri', 38400, ALL, 4000);
	seed(3, 'Tournament rooms + trophy', 92000, ALL, 3000);
	// Paid on a card in USD to exercise the conversion in settle-up.
	seed(4, 'Acropolis combo tickets', 30000, [2, 3, 6, 7, 10, 11, 8, 9, 12, 13], 2500, 'USD');
	seed(5, 'Beach coach + sunbeds', 9600, except(0, 4, 10, 14), 2000);
	// Private rooms cost double a shared bunk, creating an uneven, weighted split.
	seed(
		7,
		'Plaka apartments, night 1',
		62000,
		ALL,
		1800,
		'EUR',
		'shares',
		ALL.map((i) => (i < 6 ? 2 : 1))
	);
	seed(6, 'Awards dinner, Psyrri taverna', 76000, ALL, 1000);
	// A refund: the venue returned the damage deposit, so everyone is credited.
	seed(0, 'Escape room deposit refunded', -20000, ALL, 500);
}

function seedBudget(db: DatabaseSync, tripId: string, cityId: string): void {
	const insert = db.prepare(
		`INSERT INTO cost_estimates (trip_id, city_id, category, amount_cents) VALUES (?, ?, ?, ?)`
	);
	const insertItem = db.prepare(
		`INSERT INTO cost_items (id, trip_id, city_id, category, label, amount_cents, sort, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	// Whole-group totals for four nights, twenty people.
	const rows: [string, string, number][] = [
		['lodging', 'Plaka apartments, 4 nights', 248000],
		['activities', 'Escape rooms (22 sessions)', 264000],
		['activities', 'Museums & sites', 42000],
		['food', 'Group meals', 214000],
		['travel', 'Transfers & coaches', 78000]
	];
	const totals: Record<string, number> = {};
	let sort = 0;
	for (const [cat, label, cents] of rows) {
		totals[cat] = (totals[cat] ?? 0) + cents;
		insertItem.run(randomUUID(), tripId, cityId, cat, label, cents, sort++, Date.now());
	}
	for (const [cat, cents] of Object.entries(totals)) insert.run(tripId, cityId, cat, cents);
}

function seedTasks(db: DatabaseSync, tripId: string, roster: string[]): void {
	const insert = db.prepare(
		`INSERT INTO trip_tasks (id, trip_id, kind, label, assignee, done, sort, created_at, owner_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const insertAssignee = db.prepare(
		`INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)`
	);
	const insertDone = db.prepare(
		`INSERT OR IGNORE INTO task_done (task_id, user_id, done_at) VALUES (?, ?, ?)`
	);
	const nameOf = new Map(COMPANIONS.map((n, i) => [n, i + 1]));
	const base = Date.now();
	const everyone = roster.map((_, i) => i);

	/**
	 * `who` is roster indices. Tasks everyone must do individually (visas,
	 * insurance, flights) are the whole point of per-person completion; one
	 * person filing a visa doesn't clear it for the group. `doneWho` is the
	 * subset that has finished, so the demo shows partial progress.
	 */
	const tasks: {
		kind: string;
		label: string;
		who: number[];
		doneWho?: number[];
		shared?: number;
	}[] = [
		{
			kind: 'task',
			label: 'Apply for a Schengen visa',
			who: everyone,
			doneWho: everyone.slice(0, 13)
		},
		{
			kind: 'task',
			label: 'Send passport scan + arrival time to the organizer',
			who: everyone,
			doneWho: everyone.filter((i) => i % 3 !== 0)
		},
		{
			kind: 'task',
			label: 'Buy travel insurance',
			who: everyone,
			doneWho: everyone.slice(0, 6)
		},
		{
			kind: 'task',
			label: 'Confirm 5 parallel rooms for Friday morning',
			who: [nameOf.get('Nikos')!],
			doneWho: [nameOf.get('Nikos')!]
		},
		{ kind: 'task', label: 'Split the group into starting teams of four', who: [], shared: 1 },
		{ kind: 'task', label: 'Book Karamanlidika for 20 (Fri lunch)', who: [nameOf.get('Elena')!] },
		{ kind: 'task', label: 'Reserve the A for Athens terrace', who: [nameOf.get('Marcus')!] },
		{
			kind: 'task',
			label: 'Charter a coach to Vouliagmeni (Sat)',
			who: [nameOf.get('Yuki')!, nameOf.get('Tomas')!],
			doneWho: [nameOf.get('Yuki')!]
		},
		{ kind: 'task', label: 'Buy Acropolis combo tickets online', who: [nameOf.get('Priya')!] },
		{ kind: 'task', label: 'Collect everyone flight numbers', who: [], shared: 0 },
		{ kind: 'packing', label: 'Passport / ID', who: [], shared: 1 },
		{ kind: 'packing', label: 'Comfortable shoes (lots of walking)', who: [], shared: 0 },
		{ kind: 'packing', label: 'Power adapter (type C/F)', who: [], shared: 0 },
		{ kind: 'packing', label: 'Swimsuit for Vouliagmeni', who: [], shared: 0 },
		{ kind: 'packing', label: 'Team t-shirts', who: [], shared: 0 }
	];

	const names = [null, ...COMPANIONS];
	tasks.forEach((t, i) => {
		const id = randomUUID();
		const label = t.who
			.map((w) => names[w])
			.filter(Boolean)
			.join(', ');
		// A packing list is private, so the seeded one belongs to the account
		// looking at the trip. The companions pack their own bags off-screen.
		insert.run(
			id,
			tripId,
			t.kind,
			t.label,
			label,
			t.shared ?? 0,
			i,
			base - i * 100,
			t.kind === 'packing' ? roster[0] : null
		);
		for (const w of t.who) insertAssignee.run(id, roster[w]);
		for (const w of t.doneWho ?? []) insertDone.run(id, roster[w], base);
	});
}
