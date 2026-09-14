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
 * The day's events with the draft applied.
 *
 * A draft whose id is on the day overwrites that event; one whose id is not is
 * a block being added, so it is appended. Everything downstream then reads one
 * list, and an add previews exactly the way an edit does.
 */
export function applyDraft(entry: BoardDay, draft: EventDraft | null): EventRow[] {
	if (!draft || draft.day !== entry.day) return entry.events;
	if (entry.events.some((e) => e.id === draft.id))
		return entry.events.map((e) => (e.id === draft.id ? { ...e, ...draft } : e));
	return [
		...entry.events,
		{
			poi_id: null,
			lodging_id: null,
			city_id: entry.city?.id ?? null,
			notes: null,
			travel_mode: null,
			...draft
		}
		// The same total order the planner and the layout read days in, so a block
		// being added sits where it will sit rather than on the end.
	].sort((a, b) => a.start_min - b.start_min || (a.id < b.id ? -1 : 1));
}

/**
 * The journeys a day implies, as the board and the dialogs read them.
 *
 * `draft` is the edit in progress, or null. Stored rows are matched by key,
 * which is what a pin survives on; anything else is planned fresh at its
 * straight-line estimate, the same one the server falls back to.
 */
export function replanLegs(entry: BoardDay, draft: EventDraft | null): LegRow[] {
	const events = applyDraft(entry, draft);
	const planned = planLegs(
		events.map(plannerEvent),
		entry.incoming ? plannerEvent(entry.incoming) : null
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
