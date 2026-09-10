import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { publish } from '../events';
import { cityInTrip, isMember } from './membership';

export interface Party {
	id: string;
	name: string;
	color: string;
	isSolo: boolean;
	isDefault: boolean;
	sort: number;
}

export interface MembershipSegment {
	partyId: string;
	userId: string;
	day: string;
	startMin: number;
	endMin: number;
}

/** All parties for a trip, default first. */
export function partiesForTrip(tripId: string): Party[] {
	const rows = db
		.prepare(
			`SELECT id, name, color, is_solo, is_default, sort
			 FROM parties WHERE trip_id = ? ORDER BY is_default DESC, sort, created_at`
		)
		.all(tripId) as unknown as {
		id: string;
		name: string;
		color: string;
		is_solo: number;
		is_default: number;
		sort: number;
	}[];
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		color: r.color,
		isSolo: !!r.is_solo,
		isDefault: !!r.is_default,
		sort: r.sort
	}));
}

/** The trip's Everyone party id, creating it if somehow absent. */
export function defaultPartyId(tripId: string): string {
	const row = db
		.prepare(`SELECT id FROM parties WHERE trip_id = ? AND is_default = 1`)
		.get(tripId) as { id: string } | undefined;
	if (row) return row.id;
	const id = randomUUID();
	db.prepare(
		`INSERT INTO parties (id, trip_id, name, color, is_solo, is_default, sort, created_at)
		 VALUES (?, ?, 'Everyone', '#2f6d5e', 0, 1, 0, ?)`
	).run(id, tripId, Date.now());
	return id;
}

/** Trip member ids. */
function tripMemberIds(tripId: string): string[] {
	const rows = db
		.prepare(`SELECT user_id FROM memberships WHERE trip_id = ?`)
		.all(tripId) as unknown as { user_id: string }[];
	return rows.map((r) => r.user_id);
}

/** Membership segments for a trip on a given day. */
export function membershipForDay(tripId: string, day: string): MembershipSegment[] {
	const rows = db
		.prepare(
			`SELECT pm.party_id, pm.user_id, pm.day, pm.start_min, pm.end_min
			 FROM party_membership pm
			 JOIN parties p ON p.id = pm.party_id
			 WHERE p.trip_id = ? AND pm.day = ?`
		)
		.all(tripId, day) as unknown as {
		party_id: string;
		user_id: string;
		day: string;
		start_min: number;
		end_min: number;
	}[];
	return rows.map((r) => ({
		partyId: r.party_id,
		userId: r.user_id,
		day: r.day,
		startMin: r.start_min,
		endMin: r.end_min
	}));
}

/**
 * Member ids that belong to a party on a given day (for track visibility).
 * The default party implicitly contains every member; a non-default party
 * contains whoever has a membership segment in it that day.
 */
export function partyMemberIdsForDay(tripId: string, partyId: string, day: string): string[] {
	const def = db
		.prepare(`SELECT is_default FROM parties WHERE id = ? AND trip_id = ?`)
		.get(partyId, tripId) as { is_default: number } | undefined;
	if (!def) return [];
	if (def.is_default) return tripMemberIds(tripId);
	const rows = db
		.prepare(`SELECT DISTINCT user_id FROM party_membership WHERE party_id = ? AND day = ?`)
		.all(partyId, day) as unknown as { user_id: string }[];
	return rows.map((r) => r.user_id);
}

/** City/lodging a party is on for a day, if set. */
export function partyDay(
	partyId: string,
	day: string
): { cityId: string | null; lodgingOptionId: string | null } | null {
	const row = db
		.prepare(`SELECT city_id, lodging_option_id FROM party_day WHERE party_id = ? AND day = ?`)
		.get(partyId, day) as { city_id: string | null; lodging_option_id: string | null } | undefined;
	return row ? { cityId: row.city_id, lodgingOptionId: row.lodging_option_id } : null;
}

/** All party_day rows for a trip on a day, keyed by party id. */
export function partyDayMap(
	tripId: string,
	day: string
): Map<string, { cityId: string | null; lodgingOptionId: string | null }> {
	const rows = db
		.prepare(
			`SELECT pd.party_id, pd.city_id, pd.lodging_option_id
			 FROM party_day pd JOIN parties p ON p.id = pd.party_id
			 WHERE p.trip_id = ? AND pd.day = ?`
		)
		.all(tripId, day) as unknown as {
		party_id: string;
		city_id: string | null;
		lodging_option_id: string | null;
	}[];
	return new Map(
		rows.map((r) => [r.party_id, { cityId: r.city_id, lodgingOptionId: r.lodging_option_id }])
	);
}

function partyInTrip(tripId: string, partyId: string): boolean {
	return !!db.prepare(`SELECT 1 FROM parties WHERE id = ? AND trip_id = ?`).get(partyId, tripId);
}

/** The city a lodging option belongs to, but only if the option is this trip's. */
function lodgingCityInTrip(tripId: string, optionId: string): string | null {
	const row = db
		.prepare(`SELECT city_id FROM lodging_options WHERE id = ? AND trip_id = ?`)
		.get(optionId, tripId) as { city_id: string } | undefined;
	return row?.city_id ?? null;
}

/**
 * Set (or clear) a crew's city and lodging for a day. Any member may edit.
 *
 * The foreign keys only prove the referenced rows exist, not that they belong
 * to this trip, so a caller who knows an id from another trip could otherwise
 * pin a crew to someone else's city or hotel. Both references are checked
 * against the trip here (and the stay against the chosen city), and a mismatch
 * is a plain `false` like every other rejection on this module.
 */
export function setPartyDay(
	tripId: string,
	actorId: string,
	partyId: string,
	day: string,
	cityId: string | null,
	lodgingOptionId: string | null
): boolean {
	if (!isMember(tripId, actorId)) return false;
	if (!partyInTrip(tripId, partyId)) return false;
	if (cityId === null && lodgingOptionId === null) {
		db.prepare(`DELETE FROM party_day WHERE party_id = ? AND day = ?`).run(partyId, day);
		publish(tripId, 'schedule');
		return true;
	}
	if (cityId !== null && !cityInTrip(tripId, cityId)) return false;
	if (lodgingOptionId !== null) {
		const stayCity = lodgingCityInTrip(tripId, lodgingOptionId);
		if (!stayCity) return false;
		if (cityId !== null && stayCity !== cityId) return false;
	}
	db.prepare(
		`INSERT INTO party_day (party_id, day, city_id, lodging_option_id) VALUES (?, ?, ?, ?)
		 ON CONFLICT(party_id, day) DO UPDATE SET city_id = excluded.city_id, lodging_option_id = excluded.lodging_option_id`
	).run(partyId, day, cityId, lodgingOptionId);
	publish(tripId, 'schedule');
	return true;
}

/** Create a named crew. Returns its id. Organizer or any member may create. */
export function createParty(
	tripId: string,
	actorId: string,
	name: string,
	isSolo = false
): string | null {
	if (!isMember(tripId, actorId)) return null;
	const count =
		(
			db.prepare(`SELECT COUNT(*) AS n FROM parties WHERE trip_id = ?`).get(tripId) as
				{ n: number } | undefined
		)?.n ?? 0;
	const id = randomUUID();
	const color = PARTY_COLORS[count % PARTY_COLORS.length];
	db.prepare(
		`INSERT INTO parties (id, trip_id, name, color, is_solo, is_default, sort, created_at)
		 VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
	).run(id, tripId, name.trim() || 'Crew', color, isSolo ? 1 : 0, count, Date.now());
	// Crews are part of the calendar payload, so they invalidate `schedule`
	// rather than carrying a topic of their own.
	publish(tripId, 'schedule');
	return id;
}

/** Rename / recolor a crew (not the default Everyone party's core identity). */
export function editParty(
	tripId: string,
	actorId: string,
	partyId: string,
	name?: string,
	color?: string
): boolean {
	if (!isMember(tripId, actorId)) return false;
	const sets: string[] = [];
	const args: string[] = [];
	if (name && name.trim()) {
		sets.push('name = ?');
		args.push(name.trim());
	}
	if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
		sets.push('color = ?');
		args.push(color);
	}
	if (!sets.length) return false;
	args.push(partyId, tripId);
	const res = db
		.prepare(
			`UPDATE parties SET ${sets.join(', ')} WHERE id = ? AND trip_id = ? AND is_default = 0`
		)
		.run(...args);
	if (res.changes > 0) publish(tripId, 'schedule');
	return res.changes > 0;
}

/** Delete a non-default crew. Its tracks fall back to Everyone. */
export function deleteParty(tripId: string, actorId: string, partyId: string): boolean {
	if (!isMember(tripId, actorId)) return false;
	const row = db
		.prepare(`SELECT is_default FROM parties WHERE id = ? AND trip_id = ?`)
		.get(partyId, tripId) as { is_default: number } | undefined;
	if (!row || row.is_default) return false;
	const fallback = defaultPartyId(tripId);
	db.prepare(`UPDATE tracks SET party_id = ? WHERE party_id = ?`).run(fallback, partyId);
	db.prepare(`DELETE FROM parties WHERE id = ?`).run(partyId);
	publish(tripId, 'schedule');
	return true;
}

/**
 * Assign a member to a crew for a time window on a day. Overlapping segments of
 * the same user are trimmed/removed so per-(user, day) segments never overlap;
 * this is the primitive behind "split off" and "rejoin".
 */
export function assignMembership(
	tripId: string,
	actorId: string,
	partyId: string,
	userId: string,
	day: string,
	startMin: number,
	endMin: number
): boolean {
	if (!isMember(tripId, actorId)) return false;
	if (!partyInTrip(tripId, partyId)) return false;
	if (!isMember(tripId, userId)) return false;
	const s = Math.max(0, Math.min(Math.round(startMin), 24 * 60));
	const e = Math.max(s + 1, Math.min(Math.round(endMin), 24 * 60));

	// Clear the user's existing coverage across [s, e) on this day, splitting any
	// segment that straddles the new window so nothing overlaps.
	const existing = db
		.prepare(
			`SELECT pm.id, pm.party_id, pm.start_min, pm.end_min
			 FROM party_membership pm JOIN parties p ON p.id = pm.party_id
			 WHERE p.trip_id = ? AND pm.user_id = ? AND pm.day = ?
			   AND pm.start_min < ? AND pm.end_min > ?`
		)
		.all(tripId, userId, day, e, s) as unknown as {
		id: string;
		party_id: string;
		start_min: number;
		end_min: number;
	}[];
	const del = db.prepare(`DELETE FROM party_membership WHERE id = ?`);
	const ins = db.prepare(
		`INSERT INTO party_membership (id, party_id, user_id, day, start_min, end_min) VALUES (?, ?, ?, ?, ?, ?)`
	);
	for (const seg of existing) {
		del.run(seg.id);
		if (seg.start_min < s) ins.run(randomUUID(), seg.party_id, userId, day, seg.start_min, s);
		if (seg.end_min > e) ins.run(randomUUID(), seg.party_id, userId, day, e, seg.end_min);
	}
	ins.run(randomUUID(), partyId, userId, day, s, e);
	publish(tripId, 'schedule');
	return true;
}

/**
 * The same for a group of people at once, which is what a "split off" is.
 *
 * One transaction, because the callers were looping over `assignMembership` and
 * stopping at the first refusal: a throw or a late refusal partway through left
 * some of the group moved and the rest behind, which is a state the board has no
 * way to show and the user has no way to undo. All or none.
 */
export function assignMemberships(
	tripId: string,
	actorId: string,
	partyId: string,
	userIds: string[],
	day: string,
	startMin: number,
	endMin: number
): boolean {
	db.exec('BEGIN');
	try {
		for (const userId of userIds) {
			if (!assignMembership(tripId, actorId, partyId, userId, day, startMin, endMin)) {
				db.exec('ROLLBACK');
				return false;
			}
		}
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	publish(tripId, 'schedule');
	return true;
}

const PARTY_COLORS = ['#b4682a', '#4a6d8c', '#8c5a86', '#2f6d5e', '#a0522d', '#556b2f'];

/** The first track of a party on a day, if any (for placing auto-travel bridges). */
export function firstTrackOfParty(partyId: string, day: string): string | null {
	const row = db
		.prepare(`SELECT id FROM tracks WHERE party_id = ? AND day = ? ORDER BY sort LIMIT 1`)
		.get(partyId, day) as { id: string } | undefined;
	return row?.id ?? null;
}
