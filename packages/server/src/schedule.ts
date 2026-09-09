import { randomUUID } from 'node:crypto';
import { db } from './db';
import { defaultPartyId, partyMemberIdsForDay } from './parties';

export interface ItemRow {
	id: string;
	title: string;
	type: string;
	start_min: number;
	end_min: number;
	booking: string | null;
	travel_mode: string | null;
	travel_mins: number | null;
	travel_before_min: number | null;
	poi_id: string | null;
	lat: number | null;
	lng: number | null;
	assignees: string[];
}

export interface TrackWithItems {
	id: string;
	name: string;
	color: string;
	partyId: string | null;
	partyName: string | null;
	partyColor: string | null;
	partyMembers: string[];
	items: ItemRow[];
}

const TRACK_COLORS = ['#2f6d5e', '#b4682a', '#4a6d8c', '#8c5a86'];

/** Drag/resize snap granularity, in minutes. */
const SNAP = 5;

/** Great-circle distance in km. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
	const R = 6371;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLng = toRad(lng2 - lng1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

/** Rough door-to-door estimate from a straight-line distance. */
function estimateTravel(km: number): { mode: string; mins: number } {
	// Real roads are longer than straight lines; pad the distance a little.
	const dist = km * 1.3;
	if (dist < 1.1) return { mode: 'walk', mins: Math.max(3, Math.round((dist / 4.8) * 60)) };
	if (dist < 8) return { mode: 'transit', mins: Math.max(8, Math.round((dist / 16) * 60) + 6) };
	return { mode: 'drive', mins: Math.max(10, Math.round((dist / 30) * 60) + 5) };
}

/** Estimated travel between two coordinates (used for cross-crew split bridges). */
export function estimateCityTravel(
	lat1: number,
	lng1: number,
	lat2: number,
	lng2: number
): { mode: string; mins: number } {
	return estimateTravel(haversineKm(lat1, lng1, lat2, lng2));
}

/** Distinct days that have any track, ordered. */
export function scheduleDays(tripId: string): string[] {
	const rows = db
		.prepare(`SELECT DISTINCT day FROM tracks WHERE trip_id = ? ORDER BY day`)
		.all(tripId) as unknown as { day: string }[];
	return rows.map((r) => r.day);
}

export function tracksForDay(tripId: string, day: string): TrackWithItems[] {
	const tracks = db
		.prepare(
			`SELECT t.id, t.name, t.color, t.party_id,
			        p.name AS party_name, p.color AS party_color
			 FROM tracks t
			 LEFT JOIN parties p ON p.id = t.party_id
			 WHERE t.trip_id = ? AND t.day = ? ORDER BY t.sort`
		)
		.all(tripId, day) as unknown as {
		id: string;
		name: string;
		color: string;
		party_id: string | null;
		party_name: string | null;
		party_color: string | null;
	}[];
	const assigneeStmt = db.prepare(
		`SELECT user_id FROM item_assignees WHERE item_id = ?`
	);
	return tracks.map((t) => {
		const items = db
			.prepare(
				`SELECT id, title, type, start_min, end_min, booking, travel_mode, travel_mins, travel_before_min, poi_id, lat, lng
				 FROM schedule_items WHERE track_id = ? ORDER BY start_min`
			)
			.all(t.id) as unknown as ItemRow[];

		for (const it of items) {
			it.assignees = (assigneeStmt.all(it.id) as unknown as { user_id: string }[]).map(
				(r) => r.user_id
			);
			// Free time is location-agnostic: nobody is committed to a place, so it
			// never contributes travel and resets the onward chain.
			if (it.type === 'freetime') {
				it.lat = null;
				it.lng = null;
			}
		}

		// Fill in travel to the next located stop. Free time breaks the chain.
		for (let i = 0; i < items.length - 1; i++) {
			const a = items[i];
			const b = items[i + 1];
			if (a.type === 'freetime' || b.type === 'freetime') continue;
			if (a.lat != null && a.lng != null && b.lat != null && b.lng != null) {
				const est = estimateTravel(haversineKm(a.lat, a.lng, b.lat, b.lng));
				a.travel_mode = est.mode;
				a.travel_mins = est.mins;
			}
		}
		// The last stop of a track has no onward leg.
		if (items.length > 0) {
			const last = items[items.length - 1];
			last.travel_mode = null;
			last.travel_mins = null;
		}
		const partyMembers = t.party_id
			? partyMemberIdsForDay(tripId, t.party_id, day)
			: [];
		return {
			id: t.id,
			name: t.name,
			color: t.color,
			partyId: t.party_id,
			partyName: t.party_name,
			partyColor: t.party_color,
			partyMembers,
			items
		};
	});
}

export function createTrack(tripId: string, day: string, name: string, partyId?: string): string {
	const count = (
		db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE trip_id = ? AND day = ?`).get(tripId, day) as
			| { n: number }
			| undefined
	)?.n ?? 0;
	const id = randomUUID();
	const party = partyId ?? defaultPartyId(tripId);
	db.prepare(
		`INSERT INTO tracks (id, trip_id, day, name, color, sort, party_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(id, tripId, day, name, TRACK_COLORS[count % TRACK_COLORS.length], count, party);
	return id;
}

/**
 * Delete a track and, by cascade, everything scheduled on it.
 *
 * Tracks were created freely and could never be removed, so a typo or a split
 * that never happened stayed on the day forever and kept appearing in the event
 * form's track picker. Returns false when the track is not this trip's or the
 * caller is not a member. A day with no tracks is a legitimate state, which it
 * has to be since that is how every day starts, so unlike cities there is no
 * last-one rule here.
 */
export function removeTrack(trackId: string, tripId: string, userId: string): boolean {
	if (!userTrack(trackId, tripId, userId)) return false;
	db.prepare(`DELETE FROM tracks WHERE id = ? AND trip_id = ?`).run(trackId, tripId);
	return true;
}

/** True when the user is a member of the trip that owns the item. */
function userOwnsItem(itemId: string, userId: string): boolean {
	const row = db
		.prepare(
			`SELECT 1 FROM schedule_items i
			 JOIN tracks t ON t.id = i.track_id
			 JOIN memberships m ON m.trip_id = t.trip_id
			 WHERE i.id = ? AND m.user_id = ?`
		)
		.get(itemId, userId);
	return !!row;
}

/** Track that belongs to the trip and has the user as a member. */
function userTrack(trackId: string, tripId: string, userId: string): { day: string } | null {
	const row = db
		.prepare(
			`SELECT t.day FROM tracks t
			 JOIN memberships m ON m.trip_id = t.trip_id
			 WHERE t.id = ? AND t.trip_id = ? AND m.user_id = ?`
		)
		.get(trackId, tripId, userId) as { day: string } | undefined;
	return row ?? null;
}

export interface NewItem {
	title: string;
	startMin: number;
	endMin: number;
	type?: string;
	poiId?: string | null;
	lat?: number | null;
	lng?: number | null;
	travelBefore?: number | null;
	assignees?: string[];
}

/** Members of the trip that owns a track, used to validate assignees. */
function tripMemberIds(tripId: string): Set<string> {
	const rows = db
		.prepare(`SELECT user_id FROM memberships WHERE trip_id = ?`)
		.all(tripId) as unknown as { user_id: string }[];
	return new Set(rows.map((r) => r.user_id));
}

/** Replace an item's assignee set with the given (validated) member ids. */
function writeAssignees(itemId: string, tripId: string, userIds: string[]): void {
	const members = tripMemberIds(tripId);
	const clean = [...new Set(userIds)].filter((id) => members.has(id));
	db.prepare(`DELETE FROM item_assignees WHERE item_id = ?`).run(itemId);
	const ins = db.prepare(`INSERT INTO item_assignees (item_id, user_id) VALUES (?, ?)`);
	for (const id of clean) ins.run(itemId, id);
}

/** Add a scheduled item to a track. Returns its id, or null if not permitted. */
export function createItem(
	trackId: string,
	tripId: string,
	userId: string,
	item: NewItem
): string | null {
	if (!userTrack(trackId, tripId, userId)) return null;
	const start = Math.max(0, Math.min(Math.round(item.startMin), 24 * 60 - 15));
	const end = Math.max(start + 15, Math.min(Math.round(item.endMin), 24 * 60));
	const isFree = item.type === 'freetime';
	const travelBefore =
		!isFree && item.travelBefore != null && Number.isFinite(item.travelBefore)
			? Math.max(0, Math.min(Math.round(item.travelBefore), 24 * 60))
			: null;
	const id = randomUUID();
	db.prepare(
		`INSERT INTO schedule_items
		 (id, track_id, title, type, start_min, end_min, booking, travel_mode, travel_mins, travel_before_min, poi_id, lat, lng)
		 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`
	).run(
		id,
		trackId,
		item.title,
		item.type ?? 'poi',
		start,
		end,
		isFree ? null : 'unbooked',
		travelBefore,
		isFree ? null : (item.poiId ?? null),
		isFree ? null : (item.lat ?? null),
		isFree ? null : (item.lng ?? null)
	);
	if (item.assignees && item.assignees.length) writeAssignees(id, tripId, item.assignees);
	return id;
}

/** Replace the members assigned to an item. Any trip member may edit. */
export function setAssignees(
	itemId: string,
	tripId: string,
	userId: string,
	assignees: string[]
): boolean {
	if (!userOwnsItem(itemId, userId)) return false;
	writeAssignees(itemId, tripId, assignees);
	return true;
}

export function deleteItem(itemId: string, userId: string): boolean {
	if (!userOwnsItem(itemId, userId)) return false;
	const res = db.prepare(`DELETE FROM schedule_items WHERE id = ?`).run(itemId);
	return res.changes > 0;
}

/** Move an item to a new start, preserving its duration. Snaps and clamps to the day. */
export function moveItem(itemId: string, userId: string, startMin: number): boolean {
	if (!userOwnsItem(itemId, userId)) return false;
	const item = db
		.prepare(`SELECT start_min, end_min FROM schedule_items WHERE id = ?`)
		.get(itemId) as { start_min: number; end_min: number } | undefined;
	if (!item) return false;

	const duration = item.end_min - item.start_min;
	const snapped = Math.round(startMin / SNAP) * SNAP;
	const clampedStart = Math.max(0, Math.min(snapped, 24 * 60 - duration));
	db.prepare(`UPDATE schedule_items SET start_min = ?, end_min = ? WHERE id = ?`).run(
		clampedStart,
		clampedStart + duration,
		itemId
	);
	return true;
}

/** Resize an item by moving its end, keeping the start. Snaps and clamps to the day. */
export function resizeItem(itemId: string, userId: string, endMin: number): boolean {
	if (!userOwnsItem(itemId, userId)) return false;
	const item = db
		.prepare(`SELECT start_min FROM schedule_items WHERE id = ?`)
		.get(itemId) as { start_min: number } | undefined;
	if (!item) return false;

	const snapped = Math.round(endMin / SNAP) * SNAP;
	const clampedEnd = Math.max(item.start_min + 15, Math.min(snapped, 24 * 60));
	db.prepare(`UPDATE schedule_items SET end_min = ? WHERE id = ?`).run(clampedEnd, itemId);
	return true;
}

const ITEM_TYPES = ['poi', 'food', 'transport', 'travel', 'lodging', 'freetime'];

export interface ItemEdit {
	title?: string;
	type?: string;
	travelBefore?: number | null;
}

/** Rename an item and/or change its type. Empty/invalid fields are ignored. */
export function editItem(itemId: string, userId: string, edit: ItemEdit): boolean {
	if (!userOwnsItem(itemId, userId)) return false;
	const sets: string[] = [];
	const args: (string | number | null)[] = [];

	const title = edit.title?.trim();
	if (title) {
		sets.push('title = ?');
		args.push(title);
	}
	if (edit.type && ITEM_TYPES.includes(edit.type)) {
		sets.push('type = ?');
		args.push(edit.type);
		// Free time has no booking, place, or travel; everything else defaults to
		// unbooked when switched into.
		if (edit.type === 'freetime') {
			sets.push('booking = NULL');
			sets.push('lat = NULL');
			sets.push('lng = NULL');
			sets.push('poi_id = NULL');
			sets.push('travel_before_min = NULL');
			sets.push('travel_mode = NULL');
			sets.push('travel_mins = NULL');
		} else {
			sets.push(`booking = COALESCE(booking, 'unbooked')`);
		}
	}
	if (edit.travelBefore !== undefined && edit.type !== 'freetime') {
		const tb =
			edit.travelBefore != null && Number.isFinite(edit.travelBefore) && edit.travelBefore > 0
				? Math.min(Math.round(edit.travelBefore), 24 * 60)
				: null;
		sets.push('travel_before_min = ?');
		args.push(tb);
	}
	if (sets.length === 0) return false;

	args.push(itemId);
	db.prepare(`UPDATE schedule_items SET ${sets.join(', ')} WHERE id = ?`).run(...args);
	return true;
}

const BOOKING_CYCLE = ['unbooked', 'tentative', 'booked'];

/** Advance booking status: unbooked -> tentative -> booked -> unbooked. */
export function cycleBooking(itemId: string, userId: string): boolean {
	if (!userOwnsItem(itemId, userId)) return false;
	const row = db.prepare(`SELECT booking FROM schedule_items WHERE id = ?`).get(itemId) as
		| { booking: string | null }
		| undefined;
	if (!row) return false;
	const idx = BOOKING_CYCLE.indexOf(row.booking ?? 'unbooked');
	const next = BOOKING_CYCLE[(idx + 1) % BOOKING_CYCLE.length];
	db.prepare(`UPDATE schedule_items SET booking = ? WHERE id = ?`).run(next, itemId);
	return true;
}
