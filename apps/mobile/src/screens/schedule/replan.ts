import { guessLeg, placeLeg } from '@trippy/core/travel';
import { planDay, stayBand, stayEndOf } from '@trippy/core/plan';
import type { BoardDay, EventDraft, EventRow, LegRow } from './types';

export function applyDraft(
	entry: BoardDay,
	draft: EventDraft | null
): { events: EventRow[]; stays: EventRow[] } {
	const events = entry.events.filter((e) => e.id !== draft?.id);
	const stays = entry.stays.filter((s) => s.id !== draft?.id);
	if (!draft) return { events: entry.events, stays: entry.stays };

	const row: EventRow = {
		poi_id: null,
		lodging_id: null,
		place_text: null,
		city_id: entry.city?.id ?? null,
		notes: null,
		travel_mode: null,
		version: 0,
		...(entry.events.find((e) => e.id === draft.id) ?? entry.stays.find((s) => s.id === draft.id)),
		...draft
	};

	if (row.type === 'stay') {
		const covers = row.day <= entry.day && entry.day <= stayEndOf(row);
		return { events, stays: boardStays(covers ? [...stays, row] : stays, entry.day) };
	}
	if (row.day !== entry.day) return { events, stays };
	return { events: sorted([...events, row]), stays };
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
	known?: ReadonlyMap<string, LegRow>
): LegRow[] {
	const { events } = applyDraft(entry, draft);
	const planned = planDay({ day: entry.day, events, incoming: entry.incoming }, roster);
	const stored = new Map(entry.legs.map((l) => [l.key, l]));
	return planned.map((leg) => {
		const row = stored.get(leg.key) ?? known?.get(leg.key);
		const auto = guessLeg(leg.km);
		const resolvedMode = row?.mode ?? row?.autoMode ?? auto.mode;
		const resolvedMins = row?.mins ?? row?.autoMins ?? auto.mins;
		return {
			id: row?.id ?? '',
			day: entry.day,
			key: leg.key,
			fromEventId: leg.fromEventId,
			toEventId: leg.toEventId,
			people: leg.people,
			title: row?.title ?? null,
			autoMode: row?.autoMode ?? null,
			autoMins: row?.autoMins ?? null,
			mode: row?.mode ?? null,
			mins: row?.mins ?? null,
			resolvedMode,
			resolvedMins,
			km: leg.km,
			manual: row?.mode != null || row?.mins != null,
			...placeLeg(leg, resolvedMins)
		};
	});
}
