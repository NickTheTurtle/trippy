import { planDay, resolveLeg, stayBand, stayEndOf, type LegOverride } from '@trippy/core/plan';
import { coversDay, segmentOn, type ZoneOf } from '@trippy/core/span';
import { journeyPin, type JourneyEdits } from './journeys';
import type { BoardDay, EventDraft, EventRow, LegRow } from './types';

export function applyDraft(
	entry: BoardDay,
	draft: EventDraft | null,
	zoneOf?: ZoneOf
): { events: EventRow[]; stays: EventRow[] } {
	const events = entry.events.filter((e) => e.id !== draft?.id);
	const stays = entry.stays.filter((s) => s.id !== draft?.id);
	if (!draft) return { events: entry.events, stays: entry.stays };

	const stored =
		entry.events.find((e) => e.id === draft.id) ?? entry.stays.find((s) => s.id === draft.id);
	const row: EventRow = {
		poi_id: null,
		lodging_id: null,
		place_text: null,
		notes: null,
		travel_mode: null,
		version: 0,
		...stored,
		...draft,
		// The sheet's city when it knows one, else the row's, else this day's.
		city_id: draft.city_id ?? stored?.city_id ?? entry.city?.id ?? null
	};

	if (row.type === 'stay') {
		const covers = row.day <= entry.day && entry.day <= stayEndOf(row);
		return { events, stays: boardStays(covers ? [...stays, row] : stays, entry.day) };
	}
	// A draft that now runs over several days is on each of them, ordered by
	// where its part of the day begins, as the server orders the board.
	if (!coversDay(row, entry.day)) return { events, stays };
	return { events: sortedOn([...events, row], entry.day, zoneOf), stays };
}

function sortedOn(rows: readonly EventRow[], day: string, zoneOf?: ZoneOf): EventRow[] {
	const at = (row: EventRow) => segmentOn(row, day, zoneOf)?.start ?? row.start_min;
	return [...rows].sort((a, b) => at(a) - at(b) || (a.id < b.id ? -1 : 1));
}

function sorted(rows: readonly EventRow[]): EventRow[] {
	return [...rows].sort((a, b) => a.start_min - b.start_min || (a.id < b.id ? -1 : 1));
}

function boardStays(rows: EventRow[], day: string): EventRow[] {
	return sorted(stayBand(rows, day));
}

export function replanLegs(
	entry: BoardDay,
	draft: EventDraft | null,
	roster: readonly string[],
	known?: ReadonlyMap<string, LegRow>,
	zoneOf?: ZoneOf,
	journeys?: JourneyEdits | null
): LegRow[] {
	const { events } = applyDraft(entry, draft, zoneOf);
	// The zones are what the server plans a same-day journey west by; without
	// them the preview and the saved board would disagree about its length.
	const planned = planDay({ day: entry.day, events, incoming: entry.incoming, zoneOf }, roster);
	const stored = new Map(entry.legs.map((l) => [l.key, l]));
	return planned.map((leg) => {
		const row = stored.get(leg.key) ?? known?.get(leg.key);
		// The ladder is core's (`resolveLeg`), which also drops a routed answer
		// for two points the journey no longer joins: an event moved to another
		// place in the sheet keeps its leg key, and used to keep the old drive.
		const override: LegOverride | null = row
			? {
					title: row.title,
					autoMode: row.autoMode,
					autoMins: row.autoMins,
					autoKey: row.autoKey ?? null,
					mode: row.mode,
					mins: row.mins
				}
			: null;
		const base: LegRow = { id: row?.id ?? '', day: entry.day, ...resolveLeg(leg, override) };
		const edit = journeys?.[leg.key];
		if (!edit) return base;
		// What the sheet has typed about this journey but not saved, applied as a
		// pin over the same answer, so the bar, its place and `tight` follow it.
		const pin = journeyPin(base, edit);
		return {
			...base,
			...resolveLeg(leg, {
				title: pin.title,
				autoMode: base.autoMode,
				autoMins: base.autoMins,
				autoKey: base.autoKey,
				mode: pin.mode ?? base.mode,
				mins: pin.mins ?? base.mins
			})
		};
	});
}
