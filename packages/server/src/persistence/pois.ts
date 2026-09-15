import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { publish, publishMany } from '../events';
import { poiKindFromCategory, toPoiKind, type PoiKind } from '@trippy/core/types';
import { cityInTrip, isMember } from './membership';

export interface PoiRow {
	id: string;
	name: string;
	category: string;
	/** Discover bucket: 'attraction' or 'food'. Stored, not derived from category. */
	kind: PoiKind;
	notes: string | null;
	url: string | null;
	lat: number | null;
	lng: number | null;
	rating: number | null;
	rating_count: number | null;
	price_level: number | null;
	hours: string | null;
	photo: string | null;
	saved: number;
	votes: number;
	you_voted: number;
	voters: string[]; // names, most-recent-agnostic, alphabetical
	linked: number; // scheduled calendar items pointing at this place
}

export interface CityPois {
	id: string;
	name: string;
	lat: number | null;
	lng: number | null;
	pois: PoiRow[];
}

export function cityPois(tripId: string, userId: string): CityPois[] {
	const cities = db
		.prepare(`SELECT id, name, lat, lng FROM cities WHERE trip_id = ? ORDER BY sort`)
		.all(tripId) as unknown as {
		id: string;
		name: string;
		lat: number | null;
		lng: number | null;
	}[];
	// Voter names in one pass for the whole trip rather than a subquery per row:
	// `group_concat` would need a separator that cannot appear in a person's name,
	// and there is no such character.
	const voterRows = db
		.prepare(
			`SELECT v.poi_id, u.name
			 FROM poi_votes v
			 JOIN users u ON u.id = v.user_id
			 JOIN pois p ON p.id = v.poi_id
			 WHERE p.trip_id = ?
			 ORDER BY u.name COLLATE NOCASE`
		)
		.all(tripId) as unknown as { poi_id: string; name: string }[];
	const voters = new Map<string, string[]>();
	for (const r of voterRows) {
		const list = voters.get(r.poi_id);
		if (list) list.push(r.name);
		else voters.set(r.poi_id, [r.name]);
	}
	return cities.map((c) => ({
		...c,
		pois: (
			db
				.prepare(
					`SELECT p.id, p.name, p.category, p.kind, p.notes, p.url, p.lat, p.lng,
				        p.rating, p.rating_count, p.price_level, p.hours, p.saved, p.photo,
				        (SELECT COUNT(*) FROM poi_votes v WHERE v.poi_id = p.id) AS votes,
				        (SELECT COUNT(*) FROM poi_votes v WHERE v.poi_id = p.id AND v.user_id = ?) AS you_voted,
				        (SELECT COUNT(*) FROM events s WHERE s.poi_id = p.id) AS linked
				 FROM pois p WHERE p.city_id = ?
				 ORDER BY votes DESC, p.created_at`
				)
				.all(userId, c.id) as unknown as Omit<PoiRow, 'voters'>[]
		).map((p) => ({ ...p, voters: voters.get(p.id) ?? [] }))
	}));
}

/** POIs available to schedule onto the calendar (all discovered places for the trip). */
export function savedPoisForTrip(tripId: string): {
	id: string;
	name: string;
	city_id: string;
	lat: number | null;
	lng: number | null;
	votes: number;
}[] {
	return db
		.prepare(
			`SELECT id, name, city_id, lat, lng,
			        (SELECT COUNT(*) FROM poi_votes v WHERE v.poi_id = p.id) AS votes
			 FROM pois p WHERE trip_id = ? ORDER BY name`
		)
		.all(tripId) as unknown as {
		id: string;
		name: string;
		city_id: string;
		lat: number | null;
		lng: number | null;
		votes: number;
	}[];
}

export interface PoiDetails {
	rating?: number | null;
	ratingCount?: number | null;
	priceLevel?: number | null;
	hours?: string[] | null;
	photo?: string | null;
}

/**
 * Whether this city already holds a place with this exact card title. One venue
 * can legitimately appear several times: the Acropolis at sunrise and again for
 * the museum. Duplicates are only a mistake when the *activity* repeats too,
 * which is precisely when the resulting titles collide.
 */
export function poiTitleExists(tripId: string, cityId: string, name: string): boolean {
	const row = db
		.prepare(
			`SELECT 1 FROM pois
			 WHERE trip_id = ? AND city_id = ? AND lower(trim(name)) = lower(trim(?))`
		)
		.get(tripId, cityId, name);
	return !!row;
}

/**
 * Add a discovered place.
 *
 * `kind` is the Discover bucket and is never trusted from the caller: anything
 * that is not one of the two legal values is ignored. When it is omitted
 * entirely the place is bucketed from its provider `category`, which yields
 * `attraction` for anything unknown or ambiguous, so a food venue added through
 * a client that does not send `kind` yet still lands in the right bucket
 * instead of silently piling into Attractions.
 */
export function addPoi(
	tripId: string,
	actorId: string,
	cityId: string,
	name: string,
	category: string,
	notes: string | null,
	url: string | null,
	lat: number | null,
	lng: number | null,
	details: PoiDetails = {},
	kind?: string | null
): string | null {
	if (!isMember(tripId, actorId)) return null;
	if (!cityInTrip(tripId, cityId)) return null;
	const id = randomUUID();
	const hours = details.hours && details.hours.length ? JSON.stringify(details.hours) : null;
	const bucket: PoiKind =
		kind == null || kind === '' ? poiKindFromCategory(category) : toPoiKind(kind);
	db.prepare(
		`INSERT INTO pois
		 (id, trip_id, city_id, name, category, kind, notes, url, lat, lng, rating, rating_count, price_level, hours, photo, saved, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
	).run(
		id,
		tripId,
		cityId,
		name,
		category,
		bucket,
		notes,
		url,
		lat,
		lng,
		details.rating ?? null,
		details.ratingCount ?? null,
		details.priceLevel ?? null,
		hours,
		details.photo ?? null,
		Date.now()
	);
	publish(tripId, 'pois');
	return id;
}

export function toggleVote(tripId: string, actorId: string, poiId: string): boolean {
	if (!isMember(tripId, actorId)) return false;
	const poi = db.prepare(`SELECT 1 FROM pois WHERE id = ? AND trip_id = ?`).get(poiId, tripId);
	if (!poi) return false;
	const existing = db
		.prepare(`SELECT 1 FROM poi_votes WHERE poi_id = ? AND user_id = ?`)
		.get(poiId, actorId);
	if (existing) {
		db.prepare(`DELETE FROM poi_votes WHERE poi_id = ? AND user_id = ?`).run(poiId, actorId);
	} else {
		db.prepare(`INSERT INTO poi_votes (poi_id, user_id) VALUES (?, ?)`).run(poiId, actorId);
	}
	publish(tripId, 'pois');
	return true;
}

/**
 * How many scheduled events point at this place. Surfaced in the delete
 * confirmation, because removing a place also removes what was scheduled there.
 */
export function linkedItemCount(tripId: string, poiId: string): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n FROM events WHERE poi_id = ? AND trip_id = ?`
		)
		.get(poiId, tripId) as { n: number } | undefined;
	return row?.n ?? 0;
}

/**
 * Delete a place and everything scheduled from it. The FK is ON DELETE SET NULL,
 * which would otherwise leave orphaned blocks with no location, so the dependent
 * events are removed explicitly and atomically.
 */
export function removePoi(tripId: string, actorId: string, poiId: string): boolean {
	if (!isMember(tripId, actorId)) return false;
	db.exec('BEGIN');
	try {
		db.prepare(`DELETE FROM events WHERE poi_id = ? AND trip_id = ?`).run(poiId, tripId);
		const res = db.prepare(`DELETE FROM pois WHERE id = ? AND trip_id = ?`).run(poiId, tripId);
		db.exec('COMMIT');
		// After COMMIT, and both sections: the schedule loses the events that were
		// scheduled from this place.
		if (Number(res.changes) > 0) publishMany(tripId, ['pois', 'schedule']);
		return Number(res.changes) > 0;
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

/**
 * Edits the traveller-authored fields of a place. Provider-derived data
 * (rating, hours, photo, coordinates) is not editable, because it belongs to the
 * provider and is refreshed from it, not typed by hand.
 *
 * `kind` is optional and follows patch semantics: omitting it leaves the
 * existing bucket alone. It has to work that way, because a client that only
 * sends a renamed title would otherwise reclassify every food place it touched
 * back to `attraction`. When it is present but not a legal value it falls back
 * to `attraction` rather than being written through.
 */
export function updatePoi(
	tripId: string,
	actorId: string,
	poiId: string,
	fields: { name: string; notes: string | null; url: string | null; kind?: string | null }
): boolean {
	if (!isMember(tripId, actorId)) return false;
	const sets = ['name = ?', 'notes = ?', 'url = ?'];
	const args: (string | number | null)[] = [fields.name, fields.notes, fields.url];
	if (fields.kind != null && fields.kind !== '') {
		sets.push('kind = ?');
		args.push(toPoiKind(fields.kind));
	}
	args.push(poiId, tripId);
	const res = db
		.prepare(`UPDATE pois SET ${sets.join(', ')} WHERE id = ? AND trip_id = ?`)
		.run(...args);
	if (Number(res.changes) > 0) publish(tripId, 'pois');
	return Number(res.changes) > 0;
}

/** A place still waiting on a cover photo lookup, with the context to find it. */
export interface PhotolessPoi {
	id: string;
	name: string;
	lat: number | null;
	lng: number | null;
	city: string;
	country: string;
	region: string | null;
}

/**
 * Places in a trip that have never had a photo looked up. `photo IS NULL` means
 * "not asked yet"; the NO_PHOTO sentinel means "asked, none exists", so misses
 * are not retried on every page load.
 */
export function poisNeedingPhotos(tripId: string, limit = 24): PhotolessPoi[] {
	return db
		.prepare(
			`SELECT p.id, p.name, p.lat, p.lng, c.name AS city, c.country, c.region
			 FROM pois p JOIN cities c ON c.id = p.city_id
			 WHERE p.trip_id = ? AND p.photo IS NULL
			 ORDER BY p.created_at LIMIT ?`
		)
		.all(tripId, limit) as unknown as PhotolessPoi[];
}

/**
 * Records the result of a photo lookup (a resource name, or the miss sentinel).
 * Does not publish, for the same reason as `setCityPhoto`: it is a cosmetic
 * backfill loop, not an edit someone made.
 */
export function setPoiPhoto(poiId: string, photo: string): void {
	db.prepare(`UPDATE pois SET photo = ? WHERE id = ?`).run(photo, poiId);
}
