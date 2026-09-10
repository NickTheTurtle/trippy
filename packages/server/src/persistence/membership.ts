import { db } from '../db';

/**
 * The lookups every trip-scoped module has to make before it writes anything.
 *
 * These four had been copied into each persistence module as it was written:
 * `isMember` into six, `isOrganizer` and `cityInTrip` into three apiece. They
 * were still identical, which is the only reason nothing had gone wrong yet.
 * An authorization predicate that exists six times is six places a future
 * change has to land, and the one that gets missed is a security bug rather
 * than a rendering glitch, so they live here now and are imported.
 *
 * They stay deliberately narrow: a boolean, no throwing, no shaping of an
 * error. The caller knows which refusal its endpoint owes the client.
 */

/** Is this user on this trip at all? The precondition for every read and write. */
export function isMember(tripId: string, userId: string): boolean {
	return !!db
		.prepare(`SELECT 1 FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.get(tripId, userId);
}

/** Is this user allowed to make the decisions the group does not vote on? */
export function isOrganizer(tripId: string, userId: string): boolean {
	const row = db
		.prepare(`SELECT role FROM memberships WHERE trip_id = ? AND user_id = ?`)
		.get(tripId, userId) as { role: string } | undefined;
	return row?.role === 'organizer';
}

/**
 * Does this city belong to this trip?
 *
 * Every city-scoped write takes both ids and checks them together, so a valid
 * city id from another trip is refused rather than quietly written into this
 * one.
 */
export function cityInTrip(tripId: string, cityId: string): boolean {
	return !!db.prepare(`SELECT 1 FROM cities WHERE id = ? AND trip_id = ?`).get(cityId, tripId);
}

/**
 * The currency the trip totals in, used when an amount arrives without one.
 *
 * Read rather than stored on each row: a blank currency means "home", so the
 * amount keeps following the trip if the organizer changes it.
 */
export function homeCurrency(tripId: string): string {
	const row = db.prepare(`SELECT home_currency FROM trips WHERE id = ?`).get(tripId) as
		{ home_currency: string } | undefined;
	return row?.home_currency ?? 'USD';
}
