import type { EventType } from '@trippy/core/types';

/**
 * The wire shapes of `GET /trips/:id/schedule`.
 *
 * Rows read out of SQLite keep their snake_case column names (`start_min`,
 * `poi_id`), while anything the API composes is camelCase (`resolvedMins`,
 * `fromEventId`). That split is the house convention recorded in
 * `lib/api-types.ts`, and these types say what the payload actually is rather
 * than tidying it on the way in.
 */

export type ViewMode = 'day' | '3day' | 'people';

export type Member = { id: string; name: string; role: string };

export type Cell = {
	id: string;
	name: string;
	/** IANA zone. Every time on this page is read in it, never in the browser's. */
	tz: string;
	lat: number | null;
	lng: number | null;
};

export type Lodging = { name: string; tag: string; locked: number; url: string | null };

export type EventRow = {
	id: string;
	day: string;
	title: string;
	type: EventType;
	/** Minutes from midnight, in the city's zone. */
	start_min: number;
	/**
	 * Minutes from midnight. For a stay this is checkout on the FOLLOWING
	 * morning, so `end_min < start_min` is normal and is never corrected.
	 */
	end_min: number;
	poi_id: string | null;
	lodging_id: string | null;
	city_id: string | null;
	lat: number | null;
	lng: number | null;
	notes: string | null;
	travel_mode: string | null;
	/** Trip member ids. Empty means the whole group. */
	people: string[];
};

export type LegRow = {
	id: string;
	day: string;
	key: string;
	fromEventId: string;
	toEventId: string;
	people: string[];
	/** What the router said. Null until it has answered once. */
	autoMode: string | null;
	autoMins: number | null;
	/** What a person pinned by hand, which wins when set. */
	mode: string | null;
	mins: number | null;
	resolvedMode: string;
	resolvedMins: number;
	manual: boolean;
	/** Where the journey sits on the clock: anchored to its arrival. */
	startMin: number;
	endMin: number;
	/** The journey does not fit the gap, so the day as planned is not achievable. */
	tight: boolean;
};

export type Crew = { id: string; name: string; color: string; members: string[] };

export type SavedPoi = {
	id: string;
	name: string;
	city_id: string;
	lat: number | null;
	lng: number | null;
};

export type BoardDay = {
	day: string;
	city: Cell | null;
	lodging: Lodging | null;
	events: EventRow[];
	/** Last night's stay. Only its tail (midnight to checkout) lands on this day. */
	incoming: EventRow | null;
	legs: LegRow[];
};

export type ScheduleData = {
	days: string[];
	day: string;
	view: ViewMode;
	board: BoardDay[];
	members: Member[];
	crews: Crew[];
	saved: SavedPoi[];
	cities: (Cell | null)[];
	defaults: { checkIn: number; checkOut: number };
	mapsKey: string;
};
