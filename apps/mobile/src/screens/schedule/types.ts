import type { EventType, PoiKind } from '@trippy/core/types';
import type { Crew } from '../PeopleSheets';

export type { Crew };

export type ViewMode = 'day' | 'agenda';

export type Member = { id: string; name: string; role: string };

export type Cell = {
	id: string;
	name: string;
	tz: string;
	lat: number | null;
	lng: number | null;
};

export type EventRow = {
	id: string;
	day: string;
	end_day: string | null;
	title: string;
	type: EventType;
	start_min: number;
	end_min: number;
	poi_id: string | null;
	lodging_id: string | null;
	place_text: string | null;
	city_id: string | null;
	lat: number | null;
	lng: number | null;
	notes: string | null;
	travel_mode: string | null;
	people: string[];
	version: number;
};

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
	title: string | null;
	autoMode: string | null;
	autoMins: number | null;
	mode: string | null;
	mins: number | null;
	resolvedMode: string;
	resolvedMins: number;
	km: number;
	manual: boolean;
	startMin: number;
	endMin: number;
	tight: boolean;
};

export type SavedPoi = {
	id: string;
	name: string;
	city_id: string;
	lat: number | null;
	lng: number | null;
	votes: number;
	kind?: PoiKind;
};

export type BoardDay = {
	day: string;
	city: Cell | null;
	events: EventRow[];
	stays: EventRow[];
	incoming: EventRow[];
	legs: LegRow[];
};

export type ScheduleData = {
	days: string[];
	day: string;
	firstDay: string;
	lastDay: string;
	dayCount: number;
	prevDay: string | null;
	nextDay: string | null;
	view: ViewMode;
	board: BoardDay[];
	members: Member[];
	me: string;
	crews: Crew[];
	saved: SavedPoi[];
	stays: SavedPoi[];
	cities: (Cell | null)[];
	provider: 'google' | 'osm';
	mapsKey: string;
};
