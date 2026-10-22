/**
 * What the event sheet's "Getting here" section says about a journey, as pure
 * functions the sheet and the board's preview both read.
 *
 * An edit holds only the fields the reader touched. The sheet used to copy the
 * whole journey (mode and minutes) into its edit on the first keystroke in any
 * field, so naming a journey and then moving the event pinned the old minutes:
 * the bar stayed at the old length and the save wrote it. Holding only what was
 * touched lets everything else follow the event as it is edited.
 */
import { minsByMode } from '@trippy/core/travel';
import type { LegRow } from './types';

export type JourneyEdit = { title?: string; mode?: string; mins?: string };

export type JourneyEdits = Readonly<Record<string, JourneyEdit>>;

/** The journey's three fields as the sheet shows them and a save compares them. */
export type JourneyFields = { title: string; mode: string; mins: string };

type Estimable = Pick<LegRow, 'autoMode' | 'autoMins' | 'km'>;

/**
 * What a journey takes by `mode`: the routed answer when it was for that mode,
 * else the straight-line estimate the server falls back on. `autoMode` and
 * `autoMins` are read after `resolveLeg`, so an answer for two points the
 * journey no longer joins is already gone.
 */
export function estimateFor(leg: Estimable, mode: string): number {
	return mode === leg.autoMode && leg.autoMins != null ? leg.autoMins : minsByMode(leg.km, mode);
}

/** The journey as it stands, nothing edited. */
export function legFields(leg: LegRow): JourneyFields {
	return { title: leg.title ?? '', mode: leg.resolvedMode, mins: String(leg.resolvedMins) };
}

/**
 * The journey as the sheet shows it: each touched field as typed, the rest
 * from the journey itself. A mode picked without minutes shows that mode's
 * estimate, so it follows the event if the event is then moved.
 */
export function journeyFields(leg: LegRow, edit: JourneyEdit | undefined): JourneyFields {
	if (!edit) return legFields(leg);
	const mode = edit.mode ?? leg.resolvedMode;
	return {
		title: edit.title ?? leg.title ?? '',
		mode,
		mins:
			edit.mins ?? (edit.mode != null ? String(estimateFor(leg, mode)) : String(leg.resolvedMins))
	};
}

export function sameFields(a: JourneyFields, b: JourneyFields): boolean {
	return a.mode === b.mode && a.mins === b.mins && a.title.trim() === b.title.trim();
}

/** Minutes as the server stores them (`editLeg`), or null for anything it would drop. */
export function parseMins(text: string): number | null {
	const value = text.trim() === '' ? NaN : Number(text);
	return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), 48 * 60) : null;
}

/**
 * The pin an unsaved edit puts on the board's preview. Typed minutes win;
 * minutes left blank (or not a number) are the estimate for the mode shown,
 * which is what a mode picked on its own already reads as. A journey whose
 * mode and minutes are untouched (only renamed) pins nothing, so it keeps
 * following the event. Null is "as stored".
 */
export function journeyPin(
	leg: LegRow,
	edit: JourneyEdit
): { title: string | null; mode: string | null; mins: number | null } {
	const shown = journeyFields(leg, edit);
	const title = shown.title.trim() || null;
	if (edit.mode == null && edit.mins == null) return { title, mode: null, mins: null };
	return {
		title,
		mode: shown.mode,
		mins: parseMins(shown.mins) ?? estimateFor(leg, shown.mode)
	};
}
