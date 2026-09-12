import { EVENT_TYPES, TRANSPORT_MODES, type EventType } from '@trippy/core/types';
import type { Option } from '../../components/ui/Select';

/* --- Board geometry -------------------------------------------------------
 *
 * The visible window is fixed rather than fitted to the day's contents, so a
 * block sits at the same height whatever else is scheduled and the eye can
 * compare two day columns side by side.
 *
 * It runs 6:00 to midnight, where the old calendar stopped at 18:00. A stay
 * checks in at 21:00 by default and runs to the end of its day, so an evening
 * cut off at six would have drawn the one event that anchors both ends of the
 * day nowhere at all. Anything outside the window is clamped onto its edge.
 */
export const DAY_START = 6 * 60;
export const DAY_END = 24 * 60;
/** One pixel a minute: a 15-minute event, the shortest the server allows, is 15px. */
export const PX_PER_MIN = 1;
/** Width of the hour gutter, and of the lane journeys are drawn in. */
export const GUTTER_PX = 56;

export const HOURS = Array.from(
	{ length: (DAY_END - DAY_START) / 60 + 1 },
	(_, i) => DAY_START / 60 + i
);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Tue, Apr 16". Built from UTC parts so it never shifts by the reader's zone. */
export function dayLabel(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	return `${WEEKDAYS[wd]}, ${MONTHS[m - 1]} ${d}`;
}

export function hhmm(min: number): string {
	const h = Math.floor(min / 60);
	const m = min % 60;
	return `${h}:${String(m).padStart(2, '0')}`;
}

/** Shift an ISO day, in UTC so a DST boundary cannot move it. */
export function shiftDay(iso: string, delta: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

export function clampMin(v: number): number {
	return Math.max(DAY_START, Math.min(v, DAY_END));
}

export function topPx(min: number): number {
	return (clampMin(min) - DAY_START) * PX_PER_MIN;
}

export function heightPx(from: number, to: number): number {
	return Math.max(3, (clampMin(to) - clampMin(from)) * PX_PER_MIN);
}

/** Fraction across the window, for the horizontal people view. */
export function pctLeft(min: number): number {
	return ((clampMin(min) - DAY_START) / (DAY_END - DAY_START)) * 100;
}

export function pctWidth(from: number, to: number): number {
	return ((clampMin(to) - clampMin(from)) / (DAY_END - DAY_START)) * 100;
}

/* --- Vocabulary ----------------------------------------------------------- */

const TYPE_LABELS: Record<EventType, string> = {
	activity: 'Activity',
	food: 'Food',
	stay: 'Stay',
	travel: 'Travel',
	freetime: 'Free time'
};

/** Rendered straight from core's list, so a new type cannot be missed here. */
export const TYPE_OPTIONS: Option[] = EVENT_TYPES.map((t) => ({
	value: t,
	label: TYPE_LABELS[t]
}));

export function typeLabel(t: string): string {
	return TYPE_LABELS[t as EventType] ?? t;
}

const MODE_LABELS: Record<string, string> = {
	walk: 'Walk',
	cycle: 'Cycle',
	transit: 'Transit',
	drive: 'Drive',
	ferry: 'Ferry',
	flight: 'Flight'
};

export const MODE_OPTIONS: Option[] = TRANSPORT_MODES.map((m) => ({
	value: m,
	label: MODE_LABELS[m]
}));

export function modeLabel(m: string | null): string {
	return m ? (MODE_LABELS[m] ?? m) : '';
}

/** 15-minute steps keep the picker short; dragging still snaps to 5. */
export const START_OPTIONS: Option[] = Array.from(
	{ length: (DAY_END - DAY_START) / 15 },
	(_, i) => DAY_START + i * 15
).map((s) => ({ value: String(s), label: hhmm(s) }));

export const DURATION_OPTIONS: Option[] = [
	{ value: '15', label: '15m' },
	{ value: '30', label: '30m' },
	{ value: '45', label: '45m' },
	{ value: '60', label: '1h' },
	{ value: '90', label: '1h 30m' },
	{ value: '120', label: '2h' },
	{ value: '180', label: '3h' },
	{ value: '240', label: '4h' }
];

/** "1h 15m", for a duration that is not one of the offered ones. */
export function lengthLabel(mins: number): string {
	if (mins < 60) return `${mins}m`;
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Guarantees the picker can render the value it is holding.
 *
 * The option lists are round numbers, but the real values are not: dragging
 * snaps to five minutes against a 15-minute start list, and resizing produces
 * lengths like 75m. A `Select` given a value no option matches falls back to
 * its placeholder, so the field reads "Select..." on a perfectly valid event
 * and looks unset. Offer the actual value too.
 */
export function withCurrent(
	options: Option[],
	value: string,
	label: (v: number) => string
): Option[] {
	if (options.some((o) => o.value === value)) return options;
	const n = Number(value);
	if (!Number.isFinite(n)) return options;
	return [...options, { value, label: label(n) }].sort((a, b) => Number(a.value) - Number(b.value));
}

/**
 * Blocks clip their overflow, so on a busy morning names end up sliced in half.
 * Budget the space instead: the title is clamped to `trows` lines and the
 * people chips to `wrows` rows, both 15px, so the content is guaranteed to fit.
 * Anything past the budget collapses into a `+N` chip.
 */
export function whoBudget(widthFrac: number, mins: number, title: string, lanePx: number) {
	const px = Math.max(36, widthFrac * lanePx - 16);
	const trows = Math.min(3, Math.max(1, Math.ceil((title.length * 7) / px)));
	const perRow = Math.max(1, Math.floor(px / 48));
	const free = mins * PX_PER_MIN - 14 - 16 - trows * 15;
	const wrows = Math.max(0, Math.min(4, Math.floor(free / 15)));
	return {
		trows,
		wrows,
		fit: wrows * perRow,
		compact: px < 150,
		// Below this the clock is sliced mid-digit, which reads as a different
		// time rather than as a truncation. The grid still says when the block is.
		showTime: px >= 92
	};
}
