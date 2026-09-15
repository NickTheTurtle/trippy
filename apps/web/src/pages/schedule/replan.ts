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
import { guessLeg, placeLeg, planLegs, type PlannerEvent } from '@trippy/core/travel';
import { isLocatedType } from '@trippy/core/types';
import type { BoardDay, EventDraft, EventRow, LegRow } from './types';
import { shiftDay } from './shared';

/**
 * Free time is deliberately nowhere, so a block switched to it loses its
 * location for planning without losing the place it was at: switch it back and
 * the place is still there. This mirrors `toPlanner` on the server.
 */
function plannerEvent(e: EventRow): PlannerEvent {
	return {
		id: e.id,
		type: e.type,
		startMin: e.start_min,
		endMin: e.end_min,
		lat: isLocatedType(e.type) ? e.lat : null,
		lng: isLocatedType(e.type) ? e.lng : null,
		people: e.people
	};
}

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

function sorted(rows: EventRow[]): EventRow[] {
	return [...rows].sort((a, b) => a.start_min - b.start_min || (a.id < b.id ? -1 : 1));
}

/** The day a stay is checked out of, which is one day past its last night. */
export function stayEndOf(row: { day: string; end_day: string | null }): string {
	return row.end_day ?? shiftDay(row.day, 1);
}

/** Whether a stay is slept in on the night of `day`, as opposed to left that morning. */
export function isNightOf(row: { day: string; end_day: string | null }, day: string): boolean {
	return row.day <= day && day < stayEndOf(row);
}

/**
 * The bands a day draws, mirroring `staysOnBoard` on the server.
 *
 * A checkout and a check-in can land on the same day. That reads as a change of
 * hotel, so it is kept when the room really changes and dropped when it does
 * not: two identical chips naming the same room twice say nothing twice.
 */
function boardStays(rows: EventRow[], day: string): EventRow[] {
	const key = (r: EventRow) =>
		`${r.lodging_id ?? r.poi_id ?? `${r.title}|${r.lat}|${r.lng}`}\u0000${[...r.people].sort().join(',')}`;
	const tonight = new Set(rows.filter((r) => isNightOf(r, day)).map(key));
	return sorted(rows.filter((r) => isNightOf(r, day) || !tonight.has(key(r))));
}

/**
 * The journeys a day implies, as the board and the dialogs read them.
 *
 * `draft` is the edit in progress, or null. Stored rows are matched by key,
 * which is what a pin survives on; anything else is planned fresh at its
 * straight-line estimate, the same one the server falls back to.
 *
 * Tonight's lodgings enter the plan as the end of the day, and last night's are
 * the morning's origins, one per group that slept somewhere of its own. A stay
 * being checked out of this morning is drawn on the day but is not a night of
 * it, so it is an origin only: nobody travels back to a room they have left.
 * This mirrors `planFor` on the server exactly; if it did not, the preview
 * would disagree with the board that arrives a moment later.
 */
export function replanLegs(entry: BoardDay, draft: EventDraft | null): LegRow[] {
	const { events, stays } = applyDraft(entry, draft);
	const tonight = stays
		.filter((s) => isNightOf(s, entry.day))
		.map((s) => ({
			...plannerEvent(s),
			startMin: 24 * 60,
			endMin: 24 * 60
		}));
	const planned = planLegs(
		[...events.map(plannerEvent), ...tonight],
		entry.incoming.map(plannerEvent)
	);

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
