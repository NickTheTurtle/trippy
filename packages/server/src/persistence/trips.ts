import { randomUUID } from 'node:crypto';
import { formatDayRange, normalizeDay } from '@trippy/core/tz';
import { db } from '../db';
import { publish, publishMany } from '../events';
import { isOrganizer } from './membership';

export interface TripRow {
	id: string;
	name: string;
	dates: string;
	cover: string;
	home_currency: string;
	start_date: string;
	end_date: string;
	role: string;
}

export interface CityRow {
	id: string;
	name: string;
	country: string;
	/**
	 * State / province, or null when the geocoder had none (city-states) or the
	 * row predates the column. Never the string 'undefined'.
	 */
	region: string | null;
	tz: string;
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
	region: string | null;
	lat: number | null;
	lng: number | null;
}

/**
 * First cities of the user's trips that have never had a photo looked up.
 *
 * Only the first city of each trip is worth a lookup, because that is the only
 * one a trip card shows. Restricting it also keeps the cost of opening the trip
 * list proportional to the number of trips rather than to the number of cities
 * in them, and `limit` caps what a single request may spend on top of that.
 */
export function citiesNeedingPhotos(userId: string, limit = 24): CityNeedingPhoto[] {
	return db
		.prepare(
			`SELECT c.id, c.name, c.country, c.region, c.lat, c.lng
			 FROM cities c
			 JOIN memberships m ON m.trip_id = c.trip_id AND m.user_id = ?
			 WHERE c.photo IS NULL
			   AND c.sort = (SELECT MIN(x.sort) FROM cities x WHERE x.trip_id = c.trip_id)
			 LIMIT ?`
		)
		.all(userId, limit) as unknown as CityNeedingPhoto[];
}

/**
 * Records the result of a photo lookup (a resource name, or the miss sentinel).
 *
 * Deliberately does not publish: this is a cosmetic backfill that runs up to
 * `limit` times per page load, so publishing would turn one page view into a
 * burst of invalidations that send every other tab to refetch the trip.
 */
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

/**
 * Where a city is, but only if it belongs to this trip. Null otherwise.
 *
 * The trip check is the point: this feeds place search, which biases its query
 * by the city, so an id from another trip must not be able to steer it.
 *
 * The region and coordinates come with the name because the name alone is
 * ambiguous. Searching a Nashville, Georgia trip returned Nashville, Tennessee
 * until the state travelled with it (see `SearchNear` in `providers/places`).
 */
export function citySearchContext(tripId: string, cityId: string): CitySearchContext | null {
	const row = db
		.prepare(`SELECT name, country, region, lat, lng FROM cities WHERE id = ? AND trip_id = ?`)
		.get(cityId, tripId) as CitySearchContext | undefined;
	return row ?? null;
}

export interface CitySearchContext {
	name: string;
	country: string;
	region: string | null;
	lat: number | null;
	lng: number | null;
}

function listCities(tripId: string): CityRow[] {
	return db
		.prepare(
			`SELECT id, name, country, region, tz, lat, lng, photo
			 FROM cities WHERE trip_id = ? ORDER BY sort`
		)
		.all(tripId) as unknown as CityRow[];
}

export interface TripCreate {
	name: string;
	startDate: string;
	endDate: string;
	homeCurrency?: string;
}

/**
 * Either the new trip's id or the reason it could not be created. Creation
 * validates the same things an edit does, so it reports them the same way
 * `updateTrip` does rather than collapsing every problem into a null.
 */
export type TripCreateResult = { id: string; error: null } | { id: null; error: string };

/**
 * Create a trip owned by `userId`. Both dates are required and validated here,
 * never trusted: every dated surface downstream (the schedule, per-day costs,
 * travel fit) reads them as given.
 */
export function createTrip(userId: string, input: TripCreate): TripCreateResult {
	const name = input.name.trim();
	if (!name) return { id: null, error: 'Enter a name.' };
	const range = validateDates(input.startDate, input.endDate);
	if (typeof range === 'string') return { id: null, error: range };
	const currency = (input.homeCurrency ?? 'USD').trim().toUpperCase() || 'USD';
	if (!/^[A-Z]{3}$/.test(currency)) return { id: null, error: 'Pick a currency.' };

	const id = randomUUID();
	const cover = 'linear-gradient(135deg, #2f6d5e, #7ba697)';
	db.prepare(
		`INSERT INTO trips (id, organizer_id, name, dates, cover, home_currency, start_date, end_date, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		userId,
		name,
		tripLabel(range.start, range.end),
		cover,
		currency,
		range.start,
		range.end,
		Date.now()
	);
	db.prepare(`INSERT INTO memberships (trip_id, user_id, role) VALUES (?, ?, 'organizer')`).run(
		id,
		userId
	);
	return { id, error: null };
}

/**
 * The two endpoints as real days, or the message explaining why they are not.
 *
 * Both are required. A trip without dates cannot be scheduled, costed per day
 * or checked for travel fit, and the "Dates TBD" placeholder it used to produce
 * was a label pretending to be data. A missing date and an unparseable one are
 * still reported separately, because they are different mistakes.
 */
function validateDates(
	startInput: string | null | undefined,
	endInput: string | null | undefined
): { start: string; end: string } | string {
	const rawStart = (startInput ?? '').trim();
	const rawEnd = (endInput ?? '').trim();
	if (!rawStart) return 'Pick a start date.';
	if (!rawEnd) return 'Pick an end date.';
	const start = normalizeDay(rawStart);
	const end = normalizeDay(rawEnd);
	if (!start) return 'Pick a valid start date.';
	if (!end) return 'Pick a valid end date.';
	if (end < start) return 'The end date must be on or after the start date.';
	return { start, end };
}

/**
 * The stored `dates` label, always derived from the endpoints so it cannot
 * drift from them. It exists only because the header and the trip card render
 * a formatted string; the endpoints remain the source of truth.
 */
function tripLabel(start: string, end: string): string {
	return formatDayRange(start, end);
}

const TZ_RE = /^[A-Za-z]+\/[A-Za-z0-9_+-]+$/;

export interface TripEdit {
	name: string;
	startDate: string;
	endDate: string;
	currency: string;
}

/**
 * Rename / re-date / re-denominate a trip. Organizer only. The `dates` label is
 * always derived from the endpoints, so it cannot drift from them.
 */
export function updateTrip(tripId: string, actorId: string, e: TripEdit): string | null {
	if (!isOrganizer(tripId, actorId)) return 'Only the organizer can edit this trip.';
	const name = e.name.trim();
	if (!name) return 'Enter a name.';
	const dates = validateDates(e.startDate, e.endDate);
	if (typeof dates === 'string') return dates;
	const currency = e.currency.trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(currency)) return 'Pick a currency.';

	db.prepare(
		`UPDATE trips SET name = ?, start_date = ?, end_date = ?, dates = ?, home_currency = ?
		 WHERE id = ?`
	).run(name, dates.start, dates.end, tripLabel(dates.start, dates.end), currency, tripId);
	// The home currency is part of every balance figure, so the ledger is stale too.
	publishMany(tripId, ['trip', 'expenses']);
	return null;
}

/**
 * Delete a trip and everything on it. Organizer only.
 *
 * Every trip-scoped table references `trips(id)` ON DELETE CASCADE, so the one
 * statement takes the cities, places, stays, votes, schedule, crews, expenses,
 * budget and tasks with it. Two things do not cascade and are handled here:
 *
 *  - **Placeholder users**, the accounts an invite creates before the person
 *    registers. `trip_invites` cascades, so the invite itself goes, but the
 *    `users` row is not owned by the trip and would be left behind with no
 *    membership, invisible and unreachable. A placeholder exists only for the
 *    trip that invited it, so any that has no membership left is deleted too.
 *    The sweep looks for them through the ledger as well as through
 *    memberships, because a placeholder who was removed while owing money is
 *    kept as a tombstone with no membership at all, and searching only the
 *    membership table would walk straight past it.
 *  - **Registered members** keep their accounts, obviously, and their rows in
 *    this trip are simply gone with it.
 *
 * Runs in one transaction: a failure between the trip and the placeholder sweep
 * would leave accounts nobody can see or clean up.
 */ export function deleteTrip(tripId: string, actorId: string): boolean {
	if (!isOrganizer(tripId, actorId)) return false;
	const placeholders = db
		.prepare(
			`SELECT u.id FROM users u
			 WHERE u.password_hash LIKE 'placeholder:%'
			   AND (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.trip_id = ?)
			        OR EXISTS (SELECT 1 FROM expenses e WHERE e.trip_id = ? AND e.payer_id = u.id)
			        OR EXISTS (SELECT 1 FROM expense_participants p
			                     JOIN expenses e ON e.id = p.expense_id
			                    WHERE e.trip_id = ? AND p.user_id = u.id))`
		)
		.all(tripId, tripId, tripId) as unknown as { id: string }[];

	let deleted = false;
	db.exec('BEGIN');
	try {
		deleted = db.prepare(`DELETE FROM trips WHERE id = ?`).run(tripId).changes > 0;
		if (deleted) {
			const orphaned = db.prepare(
				`DELETE FROM users
				 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = ?)`
			);
			for (const p of placeholders) orphaned.run(p.id, p.id);
		}
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	// After COMMIT: anyone still watching is looking at a page with nothing
	// behind it, and the reload this provokes is what tells them so.
	if (deleted) publish(tripId, 'trip');
	return deleted;
}

/**
 * Leave a trip. Anyone but the organizer, who would orphan it.
 *
 * Deliberately destroys nothing else. Expenses they paid, shares they owe and
 * votes they cast all stay: the ledger has to keep balancing, and a departure
 * is not a reason to rewrite what the group already agreed. This is the same
 * effect `removeMember` has on a registered member, reached by the member
 * rather than the organizer.
 */
export function leaveTrip(tripId: string, userId: string): boolean {
	const row = db
		.prepare(`SELECT role FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.get(tripId, userId) as { role: string } | undefined;
	if (!row || row.role === 'organizer') return false;
	const res = db
		.prepare(`DELETE FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.run(tripId, userId);
	// Settlement is per member, so the balances everyone else sees change.
	if (res.changes > 0) publishMany(tripId, ['members', 'expenses', 'schedule']);
	return res.changes > 0;
}

export interface CityInput {
	name: string;
	country: string;
	/**
	 * State / province. Optional the same way coordinates are: a hand-entered
	 * city may have none, and some places genuinely have none. Anything empty
	 * or blank is stored as NULL rather than ''.
	 */
	region?: string | null;
	tz: string;
	lat?: number | null;
	lng?: number | null;
}

/** Trimmed region, or null for absent/blank. Keeps '' out of the column. */
function cityRegion(c: CityInput): string | null {
	const r = c.region?.trim();
	return r ? r : null;
}

function validCity(c: CityInput): boolean {
	if (!c.name.trim() || !c.country.trim()) return false;
	if (!TZ_RE.test(c.tz)) return false;
	return true;
}

/**
 * Whether the trip already holds this city.
 *
 * Identity is name + country + region, compared trimmed and case-insensitively,
 * because that is what a person means by "already on the trip". The region has
 * to be part of it rather than the name alone: Nashville, Tennessee and
 * Nashville, Georgia are two different places a trip can legitimately visit
 * both of. Coordinates are deliberately not the test. They come from whichever
 * geocoder row was picked, so the same city reached by two different searches
 * can carry slightly different numbers and would slip past.
 *
 * `exclude` is the city being edited, so renaming a city to its own name is not
 * a collision with itself.
 */
export function cityOnTrip(tripId: string, c: CityInput, exclude?: string): boolean {
	const row = db
		.prepare(
			`SELECT 1 FROM cities
			 WHERE trip_id = ?
			   AND lower(trim(name)) = lower(trim(?))
			   AND lower(trim(country)) = lower(trim(?))
			   AND coalesce(lower(trim(region)), '') = ?
			   AND id IS NOT ?`
		)
		.get(tripId, c.name, c.country, (cityRegion(c) ?? '').toLowerCase(), exclude ?? null);
	return !!row;
}

/**
 * Add a city to the end of the trip's itinerary. Organizer only.
 *
 * Returns null for a refusal, which now includes a city the trip already has:
 * a second Paris splits one city's places, stays and costs across two sidebar
 * rows that look identical, and nothing in the app can tell them apart. The
 * column pair is left without a UNIQUE index on purpose, because one trip in
 * the real database already holds a duplicate and creating the index would
 * either fail or require deleting somebody's data; this is the only writer.
 */
export function addCity(tripId: string, actorId: string, c: CityInput): string | null {
	if (!isOrganizer(tripId, actorId)) return null;
	if (!validCity(c)) return null;
	if (cityOnTrip(tripId, c)) return null;
	const next =
		((
			db.prepare(`SELECT MAX(sort) AS m FROM cities WHERE trip_id = ?`).get(tripId) as
				{ m: number | null } | undefined
		)?.m ?? -1) + 1;
	const id = randomUUID();
	db.prepare(
		`INSERT INTO cities (id, trip_id, name, country, region, tz, lat, lng, sort)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		tripId,
		c.name.trim(),
		c.country.trim(),
		cityRegion(c),
		c.tz,
		c.lat ?? null,
		c.lng ?? null,
		next
	);
	// A city is the spine of the itinerary: places, stays and budget cells are
	// all scoped to it.
	publishMany(tripId, ['trip', 'schedule', 'lodging', 'costs']);
	return id;
}

/** Update an existing city. Organizer only. */
export function updateCity(tripId: string, actorId: string, cityId: string, c: CityInput): boolean {
	if (!isOrganizer(tripId, actorId)) return false;
	if (!validCity(c)) return false;
	if (cityOnTrip(tripId, c, cityId)) return false;
	const res = db
		.prepare(
			`UPDATE cities SET name = ?, country = ?, region = ?, tz = ?, lat = ?, lng = ?
			 WHERE id = ? AND trip_id = ?`
		)
		.run(
			c.name.trim(),
			c.country.trim(),
			cityRegion(c),
			c.tz,
			c.lat ?? null,
			c.lng ?? null,
			cityId,
			tripId
		);
	if (res.changes > 0) publishMany(tripId, ['trip', 'schedule', 'lodging', 'costs']);
	return res.changes > 0;
}

/** Remove a city (and its dependent data via cascade). Organizer only; keeps at least one city. */
export function removeCity(tripId: string, actorId: string, cityId: string): boolean {
	if (!isOrganizer(tripId, actorId)) return false;
	const count =
		(
			db.prepare(`SELECT COUNT(*) AS n FROM cities WHERE trip_id = ?`).get(tripId) as
				{ n: number } | undefined
		)?.n ?? 0;
	if (count <= 1) return false;
	const res = db.prepare(`DELETE FROM cities WHERE id = ? AND trip_id = ?`).run(cityId, tripId);
	// Removing a city cascades into its places, stays, lodging votes and budget
	// cells, and nulls the crew/day city, so every section that reads a city is
	// invalidated rather than just the header.
	if (res.changes > 0) publishMany(tripId, ['trip', 'pois', 'lodging', 'costs', 'schedule']);
	return res.changes > 0;
}
