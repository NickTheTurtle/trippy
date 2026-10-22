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
import { minsByMode, type PlannedLeg } from '@trippy/core/travel';
import { planDay, resolveLeg, stayBand, stayEndOf, type LegOverride } from '@trippy/core/plan';
import { coversDay, segmentOn, type ZoneOf } from '@trippy/core/span';
import type { BoardDay, EventDraft, EventRow, LegDraft, LegDrafts, LegRow } from './types';

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
	draft: EventDraft | null,
	cityOf?: (day: string) => string | null
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
		// A draft that is not on the day yet has no stored row behind it, so it
		// has no version either. This block is only ever drawn, never saved
		// through here, so the placeholder is not a version anyone writes back.
		version: 0,
		...stored,
		...draft,
		// The dialog's departure when it has one; otherwise the city of the day
		// the block starts on, not of this one: a block being added that runs
		// into tomorrow is still leaving from today's city, and that is the
		// clock its start is read on.
		city_id: draft.city_id ?? stored?.city_id ?? cityOf?.(draft.day) ?? entry.city?.id ?? null
	};

	if (row.type === 'stay') {
		const covers = row.day <= entry.day && entry.day <= stayEndOf(row);
		return { events, stays: boardStays(covers ? [...stays, row] : stays, entry.day) };
	}
	// Every day the draft covers, the same rule the server lists a span by, so
	// stretching the end date in the dialog draws the block onto the days it
	// now reaches while the dialog is still open.
	if (!coversDay(row, entry.day)) return { events, stays };
	// The same total order the planner and the layout read days in, so a block
	// being added sits where it will sit rather than on the end.
	return { events: sorted([...events, row], entry.day), stays };
}

/** By where each block sits on `day`, which for a span carried in from yesterday is midnight. */
function sorted(rows: readonly EventRow[], day: string): EventRow[] {
	const at = (r: EventRow) => segmentOn(r, day)?.start ?? r.start_min;
	return [...rows].sort((a, b) => at(a) - at(b) || (a.id < b.id ? -1 : 1));
}

/** The bands a day draws, sorted the way the board reads them. */
function boardStays(rows: EventRow[], day: string): EventRow[] {
	return [...stayBand(rows, day)].sort(
		(a, b) => a.start_min - b.start_min || (a.id < b.id ? -1 : 1)
	);
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
 *
 * `known` is every stored journey the page has loaded, keyed by leg key, across
 * all the days of the window rather than this one. A journey is identified by
 * its two events (`from>to`), not by its day, and the server carries a
 * row across dates when a block moves (`recomputeLegs` claims it from the day
 * it left), pin and all. Matching only this day's rows made a block being sent
 * to tomorrow in the dialog preview its journeys at the bare estimate, and then
 * snap to the pinned ferry once saved. The window is what the client has; a
 * move beyond it still previews the estimate until the save comes back.
 *
 * `said` is what the open dialog's journey cards say, by leg key, before it is
 * saved. Changing a walk to a taxi is an edit to the day like any other, so the
 * bar, where it sits and whether it is tight follow the cards as they are
 * typed rather than after the save.
 */
export function replanLegs(
	entry: BoardDay,
	draft: EventDraft | null,
	roster: readonly string[],
	known?: ReadonlyMap<string, LegRow>,
	cityOf?: (day: string) => string | null,
	zoneOf?: ZoneOf,
	said?: LegDrafts
): LegRow[] {
	const { events } = applyDraft(entry, draft, cityOf);
	// The zones are what place a same-day journey across clocks; a span is
	// planned on this day by its part of it, which `planDay` reads off the rows.
	const planned = planDay({ day: entry.day, events, incoming: entry.incoming, zoneOf }, roster);

	const stored = new Map(entry.legs.map((l) => [l.key, l]));
	return planned.map((leg) => {
		const row = stored.get(leg.key) ?? known?.get(leg.key);
		const override: LegOverride | null = row
			? {
					title: row.title,
					autoMode: row.autoMode,
					autoMins: row.autoMins,
					autoKey: row.autoKey,
					mode: row.mode,
					mins: row.mins
				}
			: null;
		const edit = said?.[leg.key];
		return {
			// A journey that only the edit implies has no row yet, so it has no id.
			// Saving is by key, which both ends compute the same way.
			id: row?.id ?? '',
			day: entry.day,
			// The same ladder the server resolves the stored row with, stale
			// routing included, so the preview and the board agree.
			...resolveLeg(leg, edit ? withEdit(leg, override, edit) : override)
		};
	});
}

/**
 * A stored journey with what the open dialog says about it laid over the top.
 *
 * Typed minutes win as a pin, which is what saving them would make them. A mode
 * with no usable minutes is answered the way the mode picker answers it: the
 * router's time when the router was asked about that mode, otherwise the
 * distance at that mode's pace. The router's answer is read after the stale
 * check, so a block moved in the same dialog does not lend its old drive time
 * to the new mode.
 */
function withEdit(leg: PlannedLeg, stored: LegOverride | null, edit: LegDraft): LegOverride {
	const kept: LegOverride = {
		title: edit.title,
		autoMode: stored?.autoMode ?? null,
		autoMins: stored?.autoMins ?? null,
		autoKey: stored?.autoKey ?? null,
		mode: stored?.mode ?? null,
		mins: stored?.mins ?? null
	};
	// A rename alone: how the journey is made is what it already was.
	if (edit.mode == null) return kept;
	const routed = resolveLeg(leg, stored);
	const mins =
		edit.mins ??
		(edit.mode === routed.autoMode && routed.autoMins != null
			? routed.autoMins
			: minsByMode(leg.km, edit.mode));
	return { ...kept, mode: edit.mode, mins };
}
