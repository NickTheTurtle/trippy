import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { publish, publishMany } from '../events';

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
	photo: string | null;
	votes: number;
	you_voted: number; // 1 if the viewer picked this option
}

export interface CityLodging {
	id: string;
	name: string;
	country: string;
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

/** The trip's home currency, used when a price arrives without one. */
function homeCurrency(tripId: string): string {
	const row = db.prepare(`SELECT home_currency FROM trips WHERE id = ?`).get(tripId) as
		{ home_currency: string } | undefined;
	return row?.home_currency ?? 'USD';
}

/** Cities of a trip with their lodging options, vote counts, and the viewer's pick. */
export function cityLodging(tripId: string, userId: string): CityLodging[] {
	const cities = db
		.prepare(`SELECT id, name, country FROM cities WHERE trip_id = ? ORDER BY sort`)
		.all(tripId) as unknown as {
		id: string;
		name: string;
		country: string;
	}[];

	return cities.map((c) => {
		const options = db
			.prepare(
				`SELECT o.id, o.name, o.tag, o.price_cents, o.currency, o.url, o.locked, o.check_in, o.check_out, o.photo,
				        (SELECT COUNT(*) FROM lodging_votes v WHERE v.option_id = o.id) AS votes,
				        (SELECT COUNT(*) FROM lodging_votes v WHERE v.option_id = o.id AND v.user_id = ?) AS you_voted
				 FROM lodging_options o WHERE o.city_id = ?
				 ORDER BY o.locked DESC, votes DESC, o.created_at`
			)
			.all(userId, c.id) as unknown as LodgingOption[];
		const voted =
			(
				db
					.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM lodging_votes WHERE city_id = ?`)
					.get(c.id) as { n: number } | undefined
			)?.n ?? 0;
		return { ...c, options, voted };
	});
}

/**
 * Add a candidate stay for a city.
 *
 * A stay is worth proposing with nothing but a name and what it costs per
 * night, so everything after the name is optional: `tag`, `url`, the night
 * range and the photo all default to empty, and an empty `currency` falls back
 * to the trip's home currency, which is what a price typed on the Discover page
 * is denominated in anyway. `priceCents` is the per-night price (the `price_cents`
 * column); it stays nullable because "we have not priced it yet" is a real state.
 *
 * Check-in / check-out are set later from the stay's own editor (`setDates`);
 * a stay with no range applies to the whole city stay.
 */
export function addOption(
	tripId: string,
	actorId: string,
	cityId: string,
	name: string,
	tag = '',
	priceCents: number | null = null,
	currency = '',
	url: string | null = null,
	checkIn: string | null = null,
	checkOut: string | null = null,
	photo: string | null = null
): string | null {
	if (!isMember(tripId, actorId)) return null;
	if (!cityInTrip(tripId, cityId)) return null;
	const clean = name.trim();
	if (!clean) return null;
	const price = priceCents == null || !Number.isFinite(priceCents) ? null : Math.round(priceCents);
	const id = randomUUID();
	db.prepare(
		`INSERT INTO lodging_options (id, trip_id, city_id, name, tag, price_cents, currency, url, locked, check_in, check_out, photo, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
	).run(
		id,
		tripId,
		cityId,
		clean,
		tag,
		price,
		currency.trim().toUpperCase() || homeCurrency(tripId),
		url,
		checkIn,
		checkOut,
		photo,
		Date.now()
	);
	publish(tripId, 'lodging');
	return id;
}

/** A stay still waiting on a cover photo lookup, with the context to find it. */
export interface LodgingNeedingPhoto {
	id: string;
	name: string;
	city: string;
	country: string;
	region: string | null;
	/** The city's coordinates, since a stay carries none of its own. */
	lat: number | null;
	lng: number | null;
}

/**
 * Stays in a trip that have never had a photo looked up. As with places,
 * `photo IS NULL` means "never asked" and the miss sentinel means "asked, and
 * Google had nothing", so each stay costs at most one lookup ever.
 *
 * Capped like the places query: each row costs a billed provider call, so the
 * caller decides how much of the backlog one request is allowed to pay for.
 */
export function lodgingNeedingPhotos(tripId: string, limit = 24): LodgingNeedingPhoto[] {
	return db
		.prepare(
			`SELECT o.id, o.name, c.name AS city, c.country, c.region, c.lat, c.lng
			 FROM lodging_options o JOIN cities c ON c.id = o.city_id
			 WHERE o.trip_id = ? AND o.photo IS NULL
			 ORDER BY o.created_at LIMIT ?`
		)
		.all(tripId, limit) as unknown as LodgingNeedingPhoto[];
}

/**
 * Records the result of a photo lookup (a resource name, or the miss sentinel).
 * Does not publish: cosmetic backfill, same reasoning as the other two.
 */
export function setLodgingPhoto(optionId: string, photo: string): void {
	db.prepare(`UPDATE lodging_options SET photo = ? WHERE id = ?`).run(photo, optionId);
}

/**
 * Lodging that applies to a given day: the locked pick first, otherwise the
 * top-voted option, restricted to stays whose night range covers `day` (or
 * that have no range set, meaning they apply to the whole city stay).
 *
 * `tripId` narrows the query as well as the city: the city id alone is enough
 * to identify the stays, but scoping to the trip means a mismatched pair can
 * never return another trip's hotel.
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
			 FROM lodging_options o WHERE o.city_id = ? AND o.trip_id = ?
			 ORDER BY o.locked DESC, votes DESC, o.created_at`
		)
		.all(cityId, tripId) as unknown as {
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
		.prepare(`SELECT name, tag, locked, url FROM lodging_options WHERE id = ? AND trip_id = ?`)
		.get(optionId, tripId) as
		{ name: string; tag: string; locked: number; url: string | null } | undefined;
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
		publish(tripId, 'lodging');
		return true;
	}
	db.prepare(
		`INSERT INTO lodging_votes (city_id, user_id, option_id) VALUES (?, ?, ?)
		 ON CONFLICT(city_id, user_id) DO UPDATE SET option_id = excluded.option_id`
	).run(opt.city_id, actorId, optionId);
	publish(tripId, 'lodging');
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
	// The calendar renders the day's stay, so a lock changes that board too.
	publishMany(tripId, ['lodging', 'schedule']);
	return true;
}

export function removeOption(tripId: string, actorId: string, optionId: string): boolean {
	if (!isMember(tripId, actorId)) return false;
	const res = db
		.prepare(`DELETE FROM lodging_options WHERE id = ? AND trip_id = ?`)
		.run(optionId, tripId);
	// `party_day.lodging_option_id` is ON DELETE SET NULL, so a crew pinned to
	// this stay silently loses it: the calendar has to refetch as well.
	if (res.changes > 0) publishMany(tripId, ['lodging', 'schedule']);
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
	if (res.changes > 0) publishMany(tripId, ['lodging', 'schedule']);
	return res.changes > 0;
}

/** What a stay's editor may change. Everything a proposer typed, and nothing else. */
export interface OptionEdit {
	name: string;
	tag: string;
	priceCents: number | null;
	/** Blank falls back to the trip's home currency, as on `addOption`. */
	currency: string;
	url: string | null;
	checkIn: string | null;
	checkOut: string | null;
}

/**
 * Edit a proposed stay.
 *
 * Any trip member may edit, on the same reasoning as `removeOption` and
 * `setDates`: a stay is a shared proposal rather than one person's property,
 * and the alternative to fixing a wrong price is deleting the stay, which
 * throws away everyone's votes with it.
 *
 * Votes and the lock are deliberately untouched. A corrected price or a fixed
 * typo is the same stay, and re-opening the vote every time somebody tidies a
 * name would make the board unusable. The photo is untouched too: it is
 * provider-derived and refreshed from the provider, as on places.
 *
 * `schedule` is published alongside `lodging` because the calendar renders the
 * day's stay by name, and the night range decides which days it covers.
 */
export function updateOption(
	tripId: string,
	actorId: string,
	optionId: string,
	edit: OptionEdit
): boolean {
	if (!isMember(tripId, actorId)) return false;
	const clean = edit.name.trim();
	if (!clean) return false;
	const price =
		edit.priceCents == null || !Number.isFinite(edit.priceCents)
			? null
			: Math.round(edit.priceCents);
	const res = db
		.prepare(
			`UPDATE lodging_options
			 SET name = ?, tag = ?, price_cents = ?, currency = ?, url = ?, check_in = ?, check_out = ?
			 WHERE id = ? AND trip_id = ?`
		)
		.run(
			clean,
			edit.tag,
			price,
			edit.currency.trim().toUpperCase() || homeCurrency(tripId),
			edit.url,
			edit.checkIn,
			edit.checkOut,
			optionId,
			tripId
		);
	if (res.changes > 0) publishMany(tripId, ['lodging', 'schedule']);
	return res.changes > 0;
}
