import { randomUUID } from 'node:crypto';
import { formatDayRange, isDayString, normalizeDay } from '@trippy/core/tz';
import { db } from '../db';
import { defaultPartyId } from './parties';
import { publish, publishMany } from '../events';

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
 * in them, and `limit` caps what a single request may spend on top of that.
 */
export function citiesNeedingPhotos(userId: string, limit = 24): CityNeedingPhoto[] {
	return db
		.prepare(
			`SELECT c.id, c.name, c.country, c.lat, c.lng
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
 * Name and country of a city, but only if it belongs to this trip. Null otherwise.
 *
 * The trip check is the point: this feeds place search, which biases its query
 * by the city, so an id from another trip must not be able to steer it.
 */
export function citySearchContext(
	tripId: string,
	cityId: string
): { name: string; country: string } | null {
	const row = db
		.prepare(`SELECT name, country FROM cities WHERE id = ? AND trip_id = ?`)
		.get(cityId, tripId) as { name: string; country: string } | undefined;
	return row ?? null;
}

function listCities(tripId: string): CityRow[] {
	return db
		.prepare(
			`SELECT id, name, country, tz, arrive, depart, lat, lng, photo
			 FROM cities WHERE trip_id = ? ORDER BY sort`
		)
		.all(tripId) as unknown as CityRow[];
}

export interface TripCreate {
	name: string;
	/** Optional free-text label, only used when no real dates are given. */
	dates?: string;
	startDate?: string | null;
	endDate?: string | null;
	homeCurrency?: string;
}

/**
 * Either the new trip's id or the reason it could not be created. Creation
 * validates the same things an edit does, so it reports them the same way
 * `updateTrip` does rather than collapsing every problem into a null.
 */
export type TripCreateResult = { id: string; error: null } | { id: null; error: string };

/**
 * Create a trip owned by `userId`. Dates are optional in both directions: a trip
 * may have neither endpoint (the common "we know where, not when" case) or a
 * start with no end. Whatever is given is validated here, never trusted.
 */
export function createTrip(userId: string, input: TripCreate): TripCreateResult {
	const name = input.name.trim();
	if (!name) return { id: null, error: 'Give your trip a name.' };
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
		tripLabel(range.start, range.end, input.dates),
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
	// Every trip starts with the default "Everyone" party (the multi-schedule base).
	defaultPartyId(id);
	return { id, error: null };
}

/**
 * The two endpoints as real days, or the message explaining why they are not.
 *
 * A blank value means "not set" and is accepted; a value that is present but is
 * not a day that exists on the calendar is a mistake worth reporting, so the
 * two cases are deliberately distinguished before `normalizeDay` flattens them.
 */
function validateDates(
	startInput: string | null | undefined,
	endInput: string | null | undefined
): { start: string | null; end: string | null } | string {
	const start = normalizeDay(startInput);
	const end = normalizeDay(endInput);
	if (!start && (startInput ?? '').trim()) return 'Enter a valid start date.';
	if (!end && (endInput ?? '').trim()) return 'Enter a valid end date.';
	if (start && end && end < start) return 'The end date must be on or after the start date.';
	return { start, end };
}

/**
 * The stored `dates` label. Derived from the endpoints whenever there are any,
 * so there is one source of truth; the free-text `fallback` only covers a trip
 * that has no real dates at all.
 */
function tripLabel(start: string | null, end: string | null, fallback?: string): string {
	if (start || end) return formatDayRange(start, end);
	return (fallback ?? '').trim() || 'Dates to be set';
}

function isOrganizer(tripId: string, userId: string): boolean {
	const row = db
		.prepare(`SELECT role FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.get(tripId, userId) as { role: string } | undefined;
	return row?.role === 'organizer';
}

const TZ_RE = /^[A-Za-z]+\/[A-Za-z0-9_+-]+$/;

/**
 * Human label for a date range. Kept as a named export because it is the trip
 * card's wording; the formatting itself lives in `@trippy/core/tz` so a client
 * can produce the identical string without a round trip.
 */
export const formatDateRange = formatDayRange;

export interface TripEdit {
	name: string;
	startDate: string | null;
	endDate: string | null;
	currency: string;
}

/**
 * Rename / re-date / re-denominate a trip. Organizer only. Whenever the trip has
 * real endpoints the `dates` label is derived from them, so it cannot drift.
 *
 * The one case that keeps its old text is a trip that had no endpoints before
 * and still has none: its label is legacy free text somebody typed, and an edit
 * that never touched the dates must not silently replace it with a placeholder.
 */
export function updateTrip(tripId: string, actorId: string, e: TripEdit): string | null {
	if (!isOrganizer(tripId, actorId)) return 'Only the organizer can edit this trip.';
	const name = e.name.trim();
	if (!name) return 'Give your trip a name.';
	const dates = validateDates(e.startDate, e.endDate);
	if (typeof dates === 'string') return dates;
	const currency = e.currency.trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(currency)) return 'Pick a currency.';

	const prior = db
		.prepare(`SELECT dates, start_date, end_date FROM trips WHERE id = ?`)
		.get(tripId) as
		| { dates: string; start_date: string | null; end_date: string | null }
		| undefined;
	const keepLegacyLabel =
		!dates.start && !dates.end && !prior?.start_date && !prior?.end_date ? prior?.dates : undefined;

	db.prepare(
		`UPDATE trips SET name = ?, start_date = ?, end_date = ?, dates = ?, home_currency = ?
		 WHERE id = ?`
	).run(
		name,
		dates.start,
		dates.end,
		tripLabel(dates.start, dates.end, keepLegacyLabel),
		currency,
		tripId
	);
	// The home currency is part of every balance figure, so the ledger is stale too.
	publishMany(tripId, ['trip', 'expenses']);
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
	// Real calendar days, not just the right shape: a city arriving on Feb 31st
	// would otherwise become a schedule day that never happens.
	if (!isDayString(c.arrive) || !isDayString(c.depart)) return false;
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
	// A city is the spine of the itinerary: the calendar's days, the stays
	// portal and the budget's columns are all derived from it.
	publishMany(tripId, ['trip', 'schedule', 'lodging', 'costs']);
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
	if (res.changes > 0) publishMany(tripId, ['trip', 'schedule', 'lodging', 'costs']);
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
	// Removing a city cascades into its places, stays, lodging votes and budget
	// cells, and nulls the crew/day city, so every section that reads a city is
	// invalidated rather than just the header.
	if (res.changes > 0) publishMany(tripId, ['trip', 'pois', 'lodging', 'costs', 'schedule']);
	return res.changes > 0;
}


