import type { EventType } from '@trippy/core/types';
import type { Crew } from '../people/types';

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

export type EventRow = {
	id: string;
	day: string;
	/**
	 * The morning a stay is checked out of, exclusive. Null on everything else.
	 *
	 * A stay is the one event that is a range rather than a point: it covers
	 * every day from `day` up to but not including this one, which is how
	 * lodging has always read.
	 */
	end_day: string | null;
	title: string;
	type: EventType;
	/** Minutes from midnight, in the city's zone. */
	start_min: number;
	/** Minutes from midnight, in the city's zone, on the same day as the start. */
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

/**
 * An unsaved event, drawn on the board while its dialog is open.
 *
 * Both dialogs report one. An edit names an event that exists and overwrites
 * these fields on it; an add names one that does not yet, and it is inserted
 * into its day instead. `day` is what tells the board which one it is looking
 * at, and it also lets an edit be ignored on the days it is not on.
 *
 * The place is carried as coordinates rather than as a poi id, because that is
 * what the board, the map and the planner all actually read.
 */
export type EventDraft = Pick<
	EventRow,
	'id' | 'day' | 'end_day' | 'title' | 'type' | 'start_min' | 'end_min' | 'people' | 'lat' | 'lng'
>;

export type LegRow = {
	id: string;
	day: string;
	key: string;
	fromEventId: string;
	toEventId: string;
	people: string[];
	/** What somebody called this journey. Null means the board names it. */
	title: string | null;
	/** What the router said. Null until it has answered once. */
	autoMode: string | null;
	autoMins: number | null;
	/** What a person pinned by hand, which wins when set. */
	mode: string | null;
	mins: number | null;
	resolvedMode: string;
	resolvedMins: number;
	/** Straight-line distance, which is what a re-estimate for another mode uses. */
	km: number;
	manual: boolean;
	/** Where the journey sits on the clock: anchored to its arrival. */
	startMin: number;
	endMin: number;
	/** The journey does not fit the gap, so the day as planned is not achievable. */
	tight: boolean;
};

/** A crew belongs to the roster, not to a day. Re-exported so the board's own
    components keep importing their types from one file. */
export type { Crew };

export type SavedPoi = {
	id: string;
	name: string;
	city_id: string;
	lat: number | null;
	lng: number | null;
	/** How many people have voted for it in Discover. */
	votes: number;
};

export type BoardDay = {
	day: string;
	city: Cell | null;
	events: EventRow[];
	/** Tonight's lodgings, drawn as bands. More than one when the group splits. */
	stays: EventRow[];
	/** Last night's stays, where the morning starts. Never drawn: they are on yesterday. */
	incoming: EventRow[];
	legs: LegRow[];
};

export type ScheduleData = {
	days: string[];
	day: string;
	view: ViewMode;
	board: BoardDay[];
	members: Member[];
	me: string;
	crews: Crew[];
	saved: SavedPoi[];
	cities: (Cell | null)[];
	mapsKey: string;
};
