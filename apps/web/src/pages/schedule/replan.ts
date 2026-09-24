/**
 * The day's journeys, worked out on the client while an edit is open.
 *
 * The server owns the stored legs: it plans them after every write and keeps
 * whatever somebody pinned. But an unsaved edit is not a write, and who is on
 * an event is the whole of splitting and rejoining, so an edit to it changes
 * which journeys exist before anything is saved. The board used to drop the
 * journeys around such an edit and wait for the answer, which showed a day with
 * holes in it exactly while the reader was deciding.
 *
 * The same `planLegs` the server plans with is in core and runs anywhere, so
 * the client can answer the question itself. A planned journey that matches a
 * stored one keeps it, pin and all; one that only exists because of the edit is
 * shown with the estimate it would get, and gets a real row the moment the edit
 * is saved.
 *
 * That is also why the schedule payload carries `incoming`, last night's stay:
 * without it the first journey of the morning has no origin and the client
 * would plan a day the server does not.
 */
import { guessLeg, placeLeg } from '@trippy/core/travel';
import { planDay, stayBand, stayEndOf, isNightOf } from '@trippy/core/plan';
import type { BoardDay, EventDraft, EventRow, LegRow } from './types';

export { stayEndOf, isNightOf };

/**
 * The day's events and lodgings with the draft applied.
 *
 * A draft whose id is on the day overwrites that event; one whose id is not is
 * a block being added, so it is appended. Everything downstream then reads one
 * list, and an add previews exactly the way an edit does.
 *
 * Stays are held apart because they are not on the clock: a stay is a range of
 * nights, so it lands on this day only if the range covers it, the morning of
 * checkout included. That also makes the two interesting drafts work: changing
 * a block's type to a stay lifts it out of the day into the band, and dragging
 * a stay's dates off this day takes it off the board entirely while the dialog
 * is still open.
 */
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
		// A draft that is not on the day yet has no stored row behind it, so it
		// has no version either. This block is only ever drawn, never saved
		// through here, so the placeholder is not a version anyone writes back.
		version: 0,
		...(entry.events.find((e) => e.id === draft.id) ?? entry.stays.find((s) => s.id === draft.id)),
		...draft
	};

	if (row.type === 'stay') {
		const covers = row.day <= entry.day && entry.day <= stayEndOf(row);
		return { events, stays: boardStays(covers ? [...stays, row] : stays, entry.day) };
	}
	if (row.day !== entry.day) return { events, stays };
	// The same total order the planner and the layout read days in, so a block
	// being added sits where it will sit rather than on the end.
	return { events: sorted([...events, row]), stays };
}

function sorted(rows: readonly EventRow[]): EventRow[] {
	return [...rows].sort((a, b) => a.start_min - b.start_min || (a.id < b.id ? -1 : 1));
}

/** The bands a day draws, sorted the way the board reads them. */
function boardStays(rows: EventRow[], day: string): EventRow[] {
	return sorted(stayBand(rows, day));
}

/**
 * The journeys a day implies, as the board and the dialogs read them.
 *
 * `draft` is the edit in progress, or null. Stored rows are matched by key,
 * which is what a pin survives on; anything else is planned fresh at its
 * straight-line estimate, the same one the server falls back to.
 *
 * `planDay` in core is what actually plans it, which is the same call the
 * server makes: last night's lodgings are the morning's origins, one per group
 * that slept somewhere of its own, and nothing is planned to a stay. This used
 * to be a second copy of those rules, and the copy is exactly what drifts: a
 * preview that disagrees with the board arriving a moment later reads as the
 * board being wrong.
 *
 * `roster` is the trip's member ids, which is what "Everyone" means at this
 * moment.
 */
export function replanLegs(
	entry: BoardDay,
	draft: EventDraft | null,
	roster: readonly string[]
): LegRow[] {
	const { events } = applyDraft(entry, draft);
	const planned = planDay({ day: entry.day, events, incoming: entry.incoming }, roster);

	const stored = new Map(entry.legs.map((l) => [l.key, l]));
	return planned.map((leg) => {
		const row = stored.get(leg.key);
		const auto = guessLeg(leg.km);
		const resolvedMode = row?.mode ?? row?.autoMode ?? auto.mode;
		const resolvedMins = row?.mins ?? row?.autoMins ?? auto.mins;
		return {
			// A journey that only the edit implies has no row yet, so it has no id.
			// Saving is by key, which both ends compute the same way.
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
