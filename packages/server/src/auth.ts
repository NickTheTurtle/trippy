import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db';
import { consumeInvites } from './members';
import { seedAthensTrip } from './seed-athens';
import { trips as sampleTrips, sampleDay } from '@trippy/core/sample';

const SESSION_DAYS = 30;

export interface SessionUser {
	id: string;
	email: string;
	name: string;
	homeTz: string;
}

export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	const derived = scryptSync(password, salt, 64);
	return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const [saltHex, keyHex] = stored.split(':');
	if (!saltHex || !keyHex) return false;
	const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
	const expected = Buffer.from(keyHex, 'hex');
	return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function createUser(email: string, name: string, password: string): SessionUser {
	const id = randomUUID();
	db.prepare(
		`INSERT INTO users (id, email, name, password_hash, home_tz, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, email.toLowerCase(), name, hashPassword(password), 'UTC', Date.now());
	consumeInvites(id, email);
	return { id, email: email.toLowerCase(), name, homeTz: 'UTC' };
}

/**
 * Dev convenience: make sure a known demo account exists, pre-loaded with the two
 * sample trips, so there is something to click around in without hand-building data.
 * Real registrations start empty (see `createUser`). Only invoked in dev.
 */
export const DEMO_EMAIL = 'demo@waypoint.test';
export const DEMO_PASSWORD = 'WaypointDemo2026!';

export function ensureDemoAccount(): void {
	const existing = findUserByEmail(DEMO_EMAIL);
	if (existing) return;
	const id = randomUUID();
	db.prepare(
		`INSERT INTO users (id, email, name, password_hash, home_tz, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, DEMO_EMAIL, 'Demo Traveller', hashPassword(DEMO_PASSWORD), 'UTC', Date.now());
	seedExampleTrips(id);
}

export function findUserByEmail(email: string) {
	return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase()) as
		| { id: string; email: string; name: string; password_hash: string; home_tz: string }
		| undefined;
}

export function findUserById(id: string) {
	return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
		| { id: string; email: string; name: string; password_hash: string; home_tz: string }
		| undefined;
}

/** Update a user's display name, email, and home time zone. Email must stay unique. */
export function updateProfile(
	userId: string,
	name: string,
	email: string,
	homeTz: string
): { ok: true } | { ok: false; error: string } {
	const cleanName = name.trim();
	const cleanEmail = email.trim().toLowerCase();
	if (!cleanName) return { ok: false, error: 'Name is required.' };
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail))
		return { ok: false, error: 'Enter a valid email address.' };
	const clash = findUserByEmail(cleanEmail);
	if (clash && clash.id !== userId)
		return { ok: false, error: 'Another account already uses that email.' };
	db.prepare(`UPDATE users SET name = ?, email = ?, home_tz = ? WHERE id = ?`).run(
		cleanName,
		cleanEmail,
		homeTz,
		userId
	);
	return { ok: true };
}

/** Change a user's password after verifying their current one. */
export function changePassword(
	userId: string,
	currentPassword: string,
	newPassword: string
): { ok: true } | { ok: false; error: string } {
	const user = findUserById(userId);
	if (!user) return { ok: false, error: 'Account not found.' };
	if (!verifyPassword(currentPassword, user.password_hash))
		return { ok: false, error: 'Your current password is incorrect.' };
	if (newPassword.length < 8)
		return { ok: false, error: 'New password must be at least 8 characters.' };
	db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(
		hashPassword(newPassword),
		userId
	);
	return { ok: true };
}

export function createSession(userId: string): string {
	const id = randomUUID();
	const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
	db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).run(
		id,
		userId,
		expires
	);
	return id;
}

export function getSessionUser(sessionId: string): SessionUser | null {
	const row = db
		.prepare(
			`SELECT u.id, u.email, u.name, u.home_tz AS homeTz, s.expires_at AS expiresAt
			 FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.id = ?`
		)
		.get(sessionId) as
		| { id: string; email: string; name: string; homeTz: string; expiresAt: number }
		| undefined;
	if (!row) return null;
	if (row.expiresAt < Date.now()) {
		deleteSession(sessionId);
		return null;
	}
	return { id: row.id, email: row.email, name: row.name, homeTz: row.homeTz };
}

export function deleteSession(sessionId: string): void {
	db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
}

/** Give each new account the two example trips so the workspace is populated. */
function seedExampleTrips(userId: string): void {
	const insertTrip = db.prepare(
		`INSERT INTO trips (id, organizer_id, name, dates, cover, home_currency, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	);
	const insertMember = db.prepare(
		`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'organizer')`
	);
	const insertCity = db.prepare(
		`INSERT INTO cities (id, trip_id, name, country, tz, arrive, depart, lat, lng, sort)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	for (const t of sampleTrips) {
		if (t.id === 'athens-2026') {
			// Fully seeded elsewhere (20-person roster, four days of rooms).
			seedAthensTrip(db, userId);
			continue;
		}
		const tripId = randomUUID();
		insertTrip.run(tripId, userId, t.name, t.dates, t.cover, t.homeCurrency, Date.now());
		insertMember.run(tripId, userId);
		const cityIds: string[] = t.cities.map((c, i) => {
			const cityId = randomUUID();
			insertCity.run(cityId, tripId, c.name, c.country, c.tz, c.arrive, c.depart, c.lat ?? null, c.lng ?? null, i);
			return cityId;
		});
		if (t.id === 'china-2026') {
			seedSampleDay(tripId, cityIds[0]);
			const may = seedCompanion(tripId, 'May');
			const jordan = seedCompanion(tripId, 'Jordan');
			const priya = seedCompanion(tripId, 'Priya');
			const roster = [userId, may, jordan, priya];
			seedExpenses(tripId, roster);
			seedLodging(tripId, cityIds[0], roster);
			seedPois(tripId, cityIds, roster);
			seedBudget(tripId, cityIds);
			seedTasks(tripId, roster);
		}
	}
}

/** Create a companion account that fills out a trip's roster (cannot be logged into). */
function seedCompanion(tripId: string, name: string): string {
	const id = randomUUID();
	const email = `${name.toLowerCase()}+${tripId}@example.invalid`;
	db.prepare(
		`INSERT INTO users (id, email, name, password_hash, home_tz, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, email, name, `seed:${randomUUID()}`, 'UTC', Date.now());
	db.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'member')`).run(
		tripId,
		id
	);
	return id;
}

/** Seed a few shared expenses split across the whole roster so settling has something to show. */
function seedExpenses(tripId: string, roster: string[]): void {
	const [organizerId, may, jordan, priya] = roster;

	const insertExpense = db.prepare(
		`INSERT INTO expenses (id, trip_id, payer_id, description, amount_cents, currency, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	);
	const insertPart = db.prepare(
		`INSERT INTO expense_participants (expense_id, user_id) VALUES (?, ?)`
	);
	const seed = (payer: string, desc: string, cents: number, at: number, currency = 'USD') => {
		const id = randomUUID();
		insertExpense.run(id, tripId, payer, desc, cents, currency, at);
		for (const p of roster) insertPart.run(id, p);
	};
	const base = Date.now();
	seed(organizerId, 'Beijing hotel, 4 nights', 56000, base - 4000);
	seed(may, 'Great Wall tour', 24000, base - 3000);
	// Paid in local currency to show conversion in the settle-up view.
	seed(jordan, 'Group dinner, Guijie', 68000, base - 2000, 'CNY');
	seed(priya, 'High-speed rail x4', 32000, base - 1000);
}

/** Seed lodging options for a city plus a few votes so the ranking is populated. */
function seedLodging(tripId: string, cityId: string, roster: string[]): void {
	if (!cityId) return;
	const insertOption = db.prepare(
		`INSERT INTO lodging_options (id, trip_id, city_id, name, tag, price_cents, currency, url, locked, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
	);
	const insertVote = db.prepare(
		`INSERT INTO lodging_votes (city_id, user_id, option_id) VALUES (?, ?, ?)`
	);
	const base = Date.now();
	const add = (name: string, tag: string, cents: number, at: number) => {
		const id = randomUUID();
		insertOption.run(id, tripId, cityId, name, tag, cents, 'USD', null, at);
		return id;
	};
	const courtyard = add('Courtyard hutong house', 'Central', 14000, base - 3000);
	add('Riverside apartment', 'Quiet', 11000, base - 2000);
	add('Downtown hotel', 'Business', 16500, base - 1000);

	// Three of four have voted; the courtyard leads.
	insertVote.run(cityId, roster[0], courtyard);
	insertVote.run(cityId, roster[1], courtyard);
	insertVote.run(cityId, roster[2], courtyard);
}

/** Seed one day with two parallel tracks so the calendar has real data to move. */
function seedSampleDay(tripId: string, cityId: string): void {
	const day = '2026-10-26';
	const coords: Record<string, [number, number]> = {
		'Forbidden City': [39.9163, 116.3972],
		'Tiananmen Square': [39.9055, 116.3976],
		'Lunch, Wangfujing': [39.9149, 116.4108],
		'Temple of Heaven': [39.8822, 116.4066],
		'Hutong food walk': [39.9368, 116.403],
		'Boba, 1点点': [39.937, 116.4035],
		'Lunch, Guijie': [39.9469, 116.4189]
	};
	const insertTrack = db.prepare(
		`INSERT INTO tracks (id, trip_id, day, name, color, sort) VALUES (?, ?, ?, ?, ?, ?)`
	);
	const insertItem = db.prepare(
		`INSERT INTO schedule_items
		 (id, track_id, title, type, start_min, end_min, booking, travel_mode, travel_mins, poi_id, lat, lng)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const toMin = (hhmm: string) => {
		const [h, m] = hhmm.split(':').map(Number);
		return h * 60 + m;
	};
	sampleDay.tracks.forEach((track, ti) => {
		const trackId = randomUUID();
		insertTrack.run(trackId, tripId, day, track.name, track.color, ti);
		for (const b of track.blocks) {
			const c = coords[b.title] ?? null;
			insertItem.run(
				randomUUID(),
				trackId,
				b.title,
				b.type,
				toMin(b.start),
				toMin(b.end),
				b.booking ?? null,
				b.travelToNext?.mode ?? null,
				b.travelToNext?.mins ?? null,
				null,
				c ? c[0] : null,
				c ? c[1] : null
			);
		}
	});
}

/** Seed discover POIs per city, with Beijing places carrying coordinates and a few saved. */
function seedPois(tripId: string, cityIds: string[], roster: string[]): void {
	const insertPoi = db.prepare(
		`INSERT INTO pois (id, trip_id, city_id, name, category, notes, url, lat, lng, saved, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const insertVote = db.prepare(`INSERT INTO poi_votes (poi_id, user_id) VALUES (?, ?)`);
	const base = Date.now();
	type Seed = {
		name: string;
		category: string;
		notes: string | null;
		lat: number | null;
		lng: number | null;
		saved: number;
		votes: number;
	};
	// Beijing (cityIds[0]) with coordinates; a few saved so they show on the calendar picker.
	const perCity: Record<number, Seed[]> = {
		0: [
			{ name: 'Summer Palace', category: 'History', notes: 'Half day, go early', lat: 39.9998, lng: 116.2755, saved: 1, votes: 3 },
			{ name: 'Great Wall, Mutianyu', category: 'Sights', notes: 'Book a car', lat: 40.4319, lng: 116.5704, saved: 1, votes: 4 },
			{ name: '798 Art District', category: 'Sights', notes: null, lat: 39.9847, lng: 116.4956, saved: 0, votes: 2 },
			{ name: 'Jingshan Park', category: 'Nature', notes: 'Sunset over the Forbidden City', lat: 39.9281, lng: 116.3961, saved: 0, votes: 1 }
		],
		1: [
			{ name: 'Hongya Cave', category: 'Sights', notes: 'Night views', lat: null, lng: null, saved: 0, votes: 2 },
			{ name: 'Ciqikou Old Town', category: 'History', notes: null, lat: null, lng: null, saved: 0, votes: 1 }
		],
		2: [
			{ name: 'Li River cruise', category: 'Nature', notes: 'Guilin to Yangshuo', lat: null, lng: null, saved: 0, votes: 3 },
			{ name: 'Reed Flute Cave', category: 'Nature', notes: null, lat: null, lng: null, saved: 0, votes: 1 }
		],
		3: [
			{ name: 'West Lake', category: 'Nature', notes: 'Rent bikes', lat: null, lng: null, saved: 0, votes: 2 }
		],
		4: [
			{ name: 'The Bund', category: 'Sights', notes: 'Evening walk', lat: null, lng: null, saved: 0, votes: 3 },
			{ name: 'Yu Garden', category: 'History', notes: null, lat: null, lng: null, saved: 0, votes: 1 }
		]
	};
	for (const [idxStr, seeds] of Object.entries(perCity)) {
		const cityId = cityIds[Number(idxStr)];
		if (!cityId) continue;
		seeds.forEach((s, i) => {
			const id = randomUUID();
			insertPoi.run(id, tripId, cityId, s.name, s.category, s.notes, null, s.lat, s.lng, s.saved, base - i * 100);
			for (let v = 0; v < Math.min(s.votes, roster.length); v++) insertVote.run(id, roster[v]);
		});
	}
}

/** Seed a per-city budget so the costs view opens with real numbers. */
function seedBudget(tripId: string, cityIds: string[]): void {
	const insert = db.prepare(
		`INSERT INTO cost_estimates (trip_id, city_id, category, amount_cents) VALUES (?, ?, ?, ?)`
	);
	const insertItem = db.prepare(
		`INSERT INTO cost_items (id, trip_id, city_id, category, label, amount_cents, sort, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	// lodging, activities, food, travel (in cents) per city.
	const perCity: [number, number, number, number][] = [
		[56000, 24000, 18000, 32000],
		[33000, 15000, 14000, 12000],
		[27000, 20000, 12000, 16000],
		[22000, 10000, 11000, 9000],
		[38000, 16000, 20000, 14000]
	];
	const labels: [string, string, string, string] = [
		'Hotel nights',
		'Tickets & tours',
		'Meals',
		'Local transport'
	];
	let sort = 0;
	cityIds.forEach((cityId, i) => {
		const row = perCity[i] ?? [30000, 15000, 12000, 12000];
		insert.run(tripId, cityId, 'lodging', row[0]);
		insert.run(tripId, cityId, 'activities', row[1]);
		insert.run(tripId, cityId, 'food', row[2]);
		insert.run(tripId, cityId, 'travel', row[3]);
		const cats: [string, number][] = [
			['lodging', row[0]],
			['activities', row[1]],
			['food', row[2]],
			['travel', row[3]]
		];
		cats.forEach(([cat, cents], j) => {
			insertItem.run(randomUUID(), tripId, cityId, cat, labels[j], cents, sort++, Date.now());
		});
	});
}

/** Seed a starter checklist so the pre-trip view is not empty. */
function seedTasks(tripId: string, roster: string[]): void {
	const insert = db.prepare(
		`INSERT INTO trip_tasks (id, trip_id, kind, label, assignee, done, sort, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const insertAssignee = db.prepare(
		`INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)`
	);
	const insertDone = db.prepare(
		`INSERT OR IGNORE INTO task_done (task_id, user_id, done_at) VALUES (?, ?, ?)`
	);
	const base = Date.now();
	// roster is [you, May, Jordan, Priya]. `who` holds roster indices; a visa is
	// per-person, so it isn't finished until every traveller has their own.
	const tasks: { kind: string; label: string; who: number[]; doneWho?: number[]; shared?: number }[] =
		[
			{ kind: 'task', label: 'Apply for China visa', who: [0, 1, 2, 3], doneWho: [0, 1] },
			{ kind: 'task', label: 'Buy travel insurance', who: [0, 1, 2, 3], doneWho: [0] },
			{ kind: 'task', label: 'Book Beijing to Chongqing flight', who: [2] },
			{ kind: 'task', label: 'Reserve Great Wall car', who: [1] },
			{ kind: 'packing', label: 'Passport and visa', who: [], shared: 1 },
			{ kind: 'packing', label: 'Power adapter (type A/C/I)', who: [] },
			{ kind: 'packing', label: 'Comfortable walking shoes', who: [] },
			{ kind: 'packing', label: 'Rain jacket', who: [] }
		];
	const names = ['You', 'May', 'Jordan', 'Priya'];
	tasks.forEach((t, i) => {
		const id = randomUUID();
		insert.run(
			id,
			tripId,
			t.kind,
			t.label,
			t.who.map((w) => names[w]).join(', '),
			t.shared ?? 0,
			i,
			base - i * 100
		);
		for (const w of t.who) insertAssignee.run(id, roster[w]);
		for (const w of t.doneWho ?? []) insertDone.run(id, roster[w], base);
	});
}
