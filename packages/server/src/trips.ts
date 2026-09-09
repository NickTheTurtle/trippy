import { randomUUID } from 'node:crypto';
import { db } from './db';
import { defaultPartyId } from './parties';

export interface TripRow {
	id: string;
	name: string;
	dates: string;
	cover: string;
	home_currency: string;
	start_date: string | null;
	end_date: string | null;
	role: string;
}

export interface CityRow {
	id: string;
	name: string;
	country: string;
	tz: string;
	arrive: string;
	depart: string;
	lat: number | null;
	lng: number | null;
	photo: string | null;
}

export function listTripsForUser(userId: string): (TripRow & {
	cities: CityRow[];
	memberCount: number;
})[] {
	const trips = db
		.prepare(
			`SELECT t.id, t.name, t.dates, t.cover, t.home_currency, t.start_date, t.end_date, m.role,
			        (SELECT COUNT(*) FROM memberships x WHERE x.trip_id = t.id) AS memberCount
			 FROM trips t JOIN memberships m ON m.trip_id = t.id
			 WHERE m.user_id = ?
			 ORDER BY t.created_at DESC`
		)
		.all(userId) as unknown as (TripRow & { memberCount: number })[];
	return trips.map((t) => ({ ...t, cities: listCities(t.id) }));
}

/** A city still waiting on a cover photo lookup. */
export interface CityNeedingPhoto {
	id: string;
	name: string;
	country: string;
	lat: number | null;
	lng: number | null;
}

/**
 * First cities of the user's trips that have never had a photo looked up.
 *
 * Only the first city of each trip is worth a lookup, because that is the only
 * one a trip card shows. Restricting it also keeps the cost of opening the trip
 * list proportional to the number of trips rather than to the number of cities
 * in them.
 */
export function citiesNeedingPhotos(userId: string): CityNeedingPhoto[] {
	return db
		.prepare(
			`SELECT c.id, c.name, c.country, c.lat, c.lng
			 FROM cities c
			 JOIN memberships m ON m.trip_id = c.trip_id AND m.user_id = ?
			 WHERE c.photo IS NULL
			   AND c.sort = (SELECT MIN(x.sort) FROM cities x WHERE x.trip_id = c.trip_id)`
		)
		.all(userId) as unknown as CityNeedingPhoto[];
}

/** Records the result of a photo lookup (a resource name, or the miss sentinel). */
export function setCityPhoto(cityId: string, photo: string): void {
	db.prepare(`UPDATE cities SET photo = ? WHERE id = ?`).run(photo, cityId);
}

export function getTripForUser(
	tripId: string,
	userId: string
): (TripRow & { cities: CityRow[]; members: string[]; memberList: TripMember[] }) | null {
	const trip = db
		.prepare(
			`SELECT t.id, t.name, t.dates, t.cover, t.home_currency, t.start_date, t.end_date, m.role
			 FROM trips t JOIN memberships m ON m.trip_id = t.id
			 WHERE t.id = ? AND m.user_id = ?`
		)
		.get(tripId, userId) as unknown as TripRow | undefined;
	if (!trip) return null;
	const memberList = listMembersFull(trip.id);
	return {
		...trip,
		cities: listCities(trip.id),
		members: memberList.map((m) => m.name),
		memberList
	};
}

export interface TripMember {
	id: string;
	name: string;
	role: string;
}

/** Members of a trip with their ids and roles (organizer first, then by name). */
export function listMembersFull(tripId: string): TripMember[] {
	return db
		.prepare(
			`SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
			 WHERE m.trip_id = ? ORDER BY m.role DESC, u.name`
		)
		.all(tripId) as unknown as TripMember[];
}

function listCities(tripId: string): CityRow[] {
	return db
		.prepare(
			`SELECT id, name, country, tz, arrive, depart, lat, lng, photo
			 FROM cities WHERE trip_id = ? ORDER BY sort`
		)
		.all(tripId) as unknown as CityRow[];
}

export function createTrip(
	userId: string,
	name: string,
	dates: string,
	homeCurrency: string
): string {
	const id = randomUUID();
	const cover = 'linear-gradient(135deg, #2f6d5e, #7ba697)';
	db.prepare(
		`INSERT INTO trips (id, organizer_id, name, dates, cover, home_currency, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(id, userId, name, dates, cover, homeCurrency, Date.now());
	db.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'organizer')`).run(
		id,
		userId
	);
	// Every trip starts with the default "Everyone" party (the multi-schedule base).
	defaultPartyId(id);
	return id;
}

function isOrganizer(tripId: string, userId: string): boolean {
	const row = db
		.prepare(`SELECT role FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.get(tripId, userId) as { role: string } | undefined;
	return row?.role === 'organizer';
}

const TZ_RE = /^[A-Za-z]+\/[A-Za-z0-9_+-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Human label for a date range, e.g. "Apr 16 – 20, 2026" when the month and year
 * match, "Apr 28 – May 3, 2026" across months, "Dec 30, 2026 – Jan 2, 2027"
 * across years. Built from UTC parts so it never shifts by the server's zone.
 */
export function formatDateRange(start: string | null, end: string | null): string {
	if (!start && !end) return 'Dates to be set';
	if (!start || !end) return niceDate(start ?? end!, true);
	const [sy, sm] = start.split('-');
	const [ey, em] = end.split('-');
	if (sy !== ey) return `${niceDate(start, true)} – ${niceDate(end, true)}`;
	if (sm !== em) return `${niceDate(start, false)} – ${niceDate(end, true)}`;
	return `${niceDate(start, false)} – ${Number(end.slice(8, 10))}, ${ey}`;
}

function niceDate(iso: string, withYear: boolean): string {
	const d = new Date(`${iso}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		...(withYear ? { year: 'numeric' } : {}),
		timeZone: 'UTC'
	});
}

export interface TripEdit {
	name: string;
	startDate: string | null;
	endDate: string | null;
	currency: string;
}

/**
 * Rename / re-date / re-denominate a trip. Organizer only. The `dates` label is
 * always derived so it cannot drift from the stored endpoints.
 */
export function updateTrip(tripId: string, actorId: string, e: TripEdit): string | null {
	if (!isOrganizer(tripId, actorId)) return 'Only the organizer can edit this trip.';
	const name = e.name.trim();
	if (!name) return 'Give your trip a name.';
	if (e.startDate && !DATE_RE.test(e.startDate)) return 'Enter a valid start date.';
	if (e.endDate && !DATE_RE.test(e.endDate)) return 'Enter a valid end date.';
	if (e.startDate && e.endDate && e.startDate > e.endDate) {
		return 'The end date must be on or after the start date.';
	}
	const currency = e.currency.trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(currency)) return 'Pick a currency.';

	db.prepare(
		`UPDATE trips SET name = ?, start_date = ?, end_date = ?, dates = ?, home_currency = ?
		 WHERE id = ?`
	).run(name, e.startDate, e.endDate, formatDateRange(e.startDate, e.endDate), currency, tripId);
	return null;
}

export interface CityInput {
	name: string;
	country: string;
	tz: string;
	arrive: string;
	depart: string;
	lat?: number | null;
	lng?: number | null;
}

function validCity(c: CityInput): boolean {
	if (!c.name.trim() || !c.country.trim()) return false;
	if (!TZ_RE.test(c.tz)) return false;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(c.arrive) || !/^\d{4}-\d{2}-\d{2}$/.test(c.depart)) return false;
	return c.arrive <= c.depart;
}

/** Add a city to the end of the trip's itinerary. Organizer only. */
export function addCity(tripId: string, actorId: string, c: CityInput): string | null {
	if (!isOrganizer(tripId, actorId)) return null;
	if (!validCity(c)) return null;
	const next =
		((
			db.prepare(`SELECT MAX(sort) AS m FROM cities WHERE trip_id = ?`).get(tripId) as
				| { m: number | null }
				| undefined
		)?.m ?? -1) + 1;
	const id = randomUUID();
	db.prepare(
		`INSERT INTO cities (id, trip_id, name, country, tz, arrive, depart, lat, lng, sort)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		tripId,
		c.name.trim(),
		c.country.trim(),
		c.tz,
		c.arrive,
		c.depart,
		c.lat ?? null,
		c.lng ?? null,
		next
	);
	return id;
}

/** Update an existing city. Organizer only. */
export function updateCity(
	tripId: string,
	actorId: string,
	cityId: string,
	c: CityInput
): boolean {
	if (!isOrganizer(tripId, actorId)) return false;
	if (!validCity(c)) return false;
	const res = db
		.prepare(
			`UPDATE cities SET name = ?, country = ?, tz = ?, arrive = ?, depart = ?, lat = ?, lng = ?
			 WHERE id = ? AND trip_id = ?`
		)
		.run(
			c.name.trim(),
			c.country.trim(),
			c.tz,
			c.arrive,
			c.depart,
			c.lat ?? null,
			c.lng ?? null,
			cityId,
			tripId
		);
	return res.changes > 0;
}

/** Remove a city (and its dependent data via cascade). Organizer only; keeps at least one city. */
export function removeCity(tripId: string, actorId: string, cityId: string): boolean {
	if (!isOrganizer(tripId, actorId)) return false;
	const count =
		(db.prepare(`SELECT COUNT(*) AS n FROM cities WHERE trip_id = ?`).get(tripId) as
			| { n: number }
			| undefined)?.n ?? 0;
	if (count <= 1) return false;
	const res = db.prepare(`DELETE FROM cities WHERE id = ? AND trip_id = ?`).run(cityId, tripId);
	return res.changes > 0;
}


