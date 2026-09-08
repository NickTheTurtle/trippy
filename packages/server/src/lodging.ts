import { randomUUID } from 'node:crypto';
import { db } from './db';

export interface LodgingOption {
	id: string;
	name: string;
	tag: string;
	price_cents: number | null;
	currency: string;
	url: string | null;
	locked: number;
	check_in: string | null;
	check_out: string | null;
	votes: number;
	you_voted: number; // 1 if the viewer picked this option
}

export interface CityLodging {
	id: string;
	name: string;
	country: string;
	arrive: string;
	depart: string;
	options: LodgingOption[];
	voted: number; // distinct members who voted in this city
}

function isMember(tripId: string, userId: string): boolean {
	return !!db
		.prepare(`SELECT 1 FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.get(tripId, userId);
}

function isOrganizer(tripId: string, userId: string): boolean {
	const row = db
		.prepare(`SELECT role FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.get(tripId, userId) as { role: string } | undefined;
	return row?.role === 'organizer';
}

function cityInTrip(tripId: string, cityId: string): boolean {
	return !!db.prepare(`SELECT 1 FROM cities WHERE id = ? AND trip_id = ?`).get(cityId, tripId);
}

/** Cities of a trip with their lodging options, vote counts, and the viewer's pick. */
export function cityLodging(tripId: string, userId: string): CityLodging[] {
	const cities = db
		.prepare(`SELECT id, name, country, arrive, depart FROM cities WHERE trip_id = ? ORDER BY sort`)
		.all(tripId) as unknown as {
		id: string;
		name: string;
		country: string;
		arrive: string;
		depart: string;
	}[];

	return cities.map((c) => {
		const options = db
			.prepare(
				`SELECT o.id, o.name, o.tag, o.price_cents, o.currency, o.url, o.locked, o.check_in, o.check_out,
				        (SELECT COUNT(*) FROM lodging_votes v WHERE v.option_id = o.id) AS votes,
				        (SELECT COUNT(*) FROM lodging_votes v WHERE v.option_id = o.id AND v.user_id = ?) AS you_voted
				 FROM lodging_options o WHERE o.city_id = ?
				 ORDER BY o.locked DESC, votes DESC, o.created_at`
			)
			.all(userId, c.id) as unknown as LodgingOption[];
		const voted = (
			db
				.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM lodging_votes WHERE city_id = ?`)
				.get(c.id) as { n: number } | undefined
		)?.n ?? 0;
		return { ...c, options, voted };
	});
}

export function addOption(
	tripId: string,
	actorId: string,
	cityId: string,
	name: string,
	tag: string,
	priceCents: number | null,
	currency: string,
	url: string | null,
	checkIn: string | null = null,
	checkOut: string | null = null
): string | null {
	if (!isMember(tripId, actorId)) return null;
	if (!cityInTrip(tripId, cityId)) return null;
	const id = randomUUID();
	db.prepare(
		`INSERT INTO lodging_options (id, trip_id, city_id, name, tag, price_cents, currency, url, locked, check_in, check_out, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
	).run(id, tripId, cityId, name, tag, priceCents, currency, url, checkIn, checkOut, Date.now());
	return id;
}

/**
 * Lodging that applies to a given day: the locked pick first, otherwise the
 * top-voted option, restricted to stays whose night range covers `day` (or
 * that have no range set, meaning they apply to the whole city stay).
 */
export interface DayLodging {
	name: string;
	tag: string;
	locked: number;
	url: string | null;
}
export function lodgingForDay(tripId: string, cityId: string, day: string): DayLodging | null {
	const rows = db
		.prepare(
			`SELECT name, tag, locked, url, check_in, check_out,
			        (SELECT COUNT(*) FROM lodging_votes v WHERE v.option_id = o.id) AS votes
			 FROM lodging_options o WHERE o.city_id = ?
			 ORDER BY o.locked DESC, votes DESC, o.created_at`
		)
		.all(cityId) as unknown as {
		name: string;
		tag: string;
		locked: number;
		url: string | null;
		check_in: string | null;
		check_out: string | null;
		votes: number;
	}[];
	const covers = (o: { check_in: string | null; check_out: string | null }) => {
		if (!o.check_in && !o.check_out) return true; // whole-stay option
		const afterStart = !o.check_in || day >= o.check_in;
		// check_out is the departure morning; the last night is check_out - 1.
		const beforeEnd = !o.check_out || day < o.check_out;
		return afterStart && beforeEnd;
	};
	const match = rows.find(covers);
	return match ? { name: match.name, tag: match.tag, locked: match.locked, url: match.url } : null;
}

/** Summary for a specific option id (for per-crew lodging overrides). */
export function lodgingOptionById(tripId: string, optionId: string): DayLodging | null {
	const row = db
		.prepare(
			`SELECT name, tag, locked, url FROM lodging_options WHERE id = ? AND trip_id = ?`
		)
		.get(optionId, tripId) as
		| { name: string; tag: string; locked: number; url: string | null }
		| undefined;
	return row ? { name: row.name, tag: row.tag, locked: row.locked, url: row.url } : null;
}

/** Cast the viewer's single vote for a city. Clicking the current pick clears it. */
export function vote(tripId: string, actorId: string, optionId: string): boolean {
	if (!isMember(tripId, actorId)) return false;
	const opt = db
		.prepare(`SELECT city_id FROM lodging_options WHERE id = ? AND trip_id = ?`)
		.get(optionId, tripId) as { city_id: string } | undefined;
	if (!opt) return false;

	const existing = db
		.prepare(`SELECT option_id FROM lodging_votes WHERE city_id = ? AND user_id = ?`)
		.get(opt.city_id, actorId) as { option_id: string } | undefined;

	if (existing?.option_id === optionId) {
		db.prepare(`DELETE FROM lodging_votes WHERE city_id = ? AND user_id = ?`).run(
			opt.city_id,
			actorId
		);
		return true;
	}
	db.prepare(
		`INSERT INTO lodging_votes (city_id, user_id, option_id) VALUES (?, ?, ?)
		 ON CONFLICT(city_id, user_id) DO UPDATE SET option_id = excluded.option_id`
	).run(opt.city_id, actorId, optionId);
	return true;
}

/** Organizer locks one option as the choice for its city (clears any other lock there). */
export function lockOption(tripId: string, actorId: string, optionId: string): boolean {
	if (!isOrganizer(tripId, actorId)) return false;
	const opt = db
		.prepare(`SELECT city_id, locked FROM lodging_options WHERE id = ? AND trip_id = ?`)
		.get(optionId, tripId) as { city_id: string; locked: number } | undefined;
	if (!opt) return false;

	db.prepare(`UPDATE lodging_options SET locked = 0 WHERE city_id = ?`).run(opt.city_id);
	if (!opt.locked) {
		db.prepare(`UPDATE lodging_options SET locked = 1 WHERE id = ?`).run(optionId);
	}
	return true;
}

export function removeOption(tripId: string, actorId: string, optionId: string): boolean {
	if (!isMember(tripId, actorId)) return false;
	const res = db
		.prepare(`DELETE FROM lodging_options WHERE id = ? AND trip_id = ?`)
		.run(optionId, tripId);
	return res.changes > 0;
}

/** Update the check-in / check-out range of an option. Any trip member may edit. */
export function setDates(
	tripId: string,
	actorId: string,
	optionId: string,
	checkIn: string | null,
	checkOut: string | null
): boolean {
	if (!isMember(tripId, actorId)) return false;
	const res = db
		.prepare(`UPDATE lodging_options SET check_in = ?, check_out = ? WHERE id = ? AND trip_id = ?`)
		.run(checkIn, checkOut, optionId, tripId);
	return res.changes > 0;
}
