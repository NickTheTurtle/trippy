import { EVENT_TYPES, TRANSPORT_MODES, type EventType } from '@trippy/core/types';
import type { Option } from '../../components/ui/Select';
import type { Cell, SavedPoi } from './types';

/* --- Board geometry -------------------------------------------------------
 *
 * The board ends at midnight and starts at six in the morning, which is where a
 * day is read from: drawing the small hours on every ordinary day would spend a
 * third of the column on time nobody schedules.
 *
 * Six is a floor rather than a wall. A day holding something earlier opens back
 * to the hour that holds it, so nothing is clamped onto the top edge and read as
 * happening at six. `windowStart` is the whole of that rule, and everything that
 * puts a minute on the board takes its answer.
 *
 * `windowStart` answers for the day at rest: what it holds as saved, plus the
 * draft in an open dialog. A drag opens the board further, but continuously and
 * to the minute rather than through here, so the two are kept apart: this one
 * snaps to the hour, which is right for a board that has settled and is exactly
 * what makes a board lurch while it is being dragged over.
 */
export const DEFAULT_START = 6 * 60;
export const DAY_END = 24 * 60;
/** The shortest event the server will store, and so the shortest one offerable. */
export { MIN_EVENT_MINS } from '@trippy/core/types';
/** One pixel a minute: a 15-minute event, the shortest the server allows, is 15px. */
export const PX_PER_MIN = 1;
/** Width of the hour gutter, and of the lane journeys are drawn in. */
export const GUTTER_PX = 56;

/**
 * The id a block being added stands under until it has one of its own.
 *
 * It is board-level, not dialog-level: the day is replanned around the block
 * while it is still being described, so the page finds its journeys under this
 * id and the dialog reports its preview under it.
 */
export const DRAFT_ID = 'draft';

/** The first minute the board draws, given every minute it has to hold. */
export function windowStart(mins: readonly number[]): number {
	const earliest = mins.reduce((a, b) => Math.min(a, b), DEFAULT_START);
	return Math.min(DEFAULT_START, Math.max(0, Math.floor(earliest / 60) * 60));
}

/**
 * The hour lines the axis draws, from the window's first whole hour to midnight.
 *
 * The window itself need not be a whole hour: a drag opens it to the minute, and
 * an axis is still only ever marked on the hour.
 */
export function hoursFrom(start: number): number[] {
	const first = Math.ceil(start / 60);
	return Array.from({ length: DAY_END / 60 - first + 1 }, (_, i) => first + i);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Tue, Apr 16". Built from UTC parts so it never shifts by the reader's zone. */
export function dayLabel(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	return `${WEEKDAYS[wd]}, ${MONTHS[m - 1]} ${d}`;
}

/**
 * "Apr 17 to Apr 19", the span a stay covers.
 *
 * Weekdayless where `dayLabel` carries one: two of them on a line is more date
 * than a subtitle can hold, and the day of the week is not what a reader is
 * checking when they are reading a range.
 */
export function rangeLabel(from: string, to: string): string {
	const short = (iso: string) => {
		const [, m, d] = iso.split('-').map(Number);
		return `${MONTHS[m - 1]} ${d}`;
	};
	return `${short(from)} to ${short(to)}`;
}

/* --- The clock ------------------------------------------------------------
 *
 * Every wall-clock time the board shows is drawn here, so the app has one
 * answer to "what does a time look like" rather than one per call site.
 *
 * The board speaks minutes past midnight in the destination's own zone: the
 * minute is already local to the city being read, so there is no conversion
 * left to do here and none is attempted. Formatting is done in UTC for exactly
 * that reason, since letting `Intl` apply the reader's zone would shift a time
 * that is already in the right one.
 *
 * `en-US` is named rather than left to the reader's locale, the same way
 * `dayLabel` above and core's date helpers already name it. A locale-driven
 * clock would be the better end state, but it has to arrive with the rest of
 * the app's wording, not on its own on one page: see docs/DESIGN.md.
 */

/** Minutes past midnight as an instant on a fixed UTC day, for `Intl`. */
const at = (min: number) => new Date(Date.UTC(2000, 0, 1, 0, ((min % 1440) + 1440) % 1440));

const CLOCK = new Intl.DateTimeFormat('en-US', {
	timeZone: 'UTC',
	hour: 'numeric',
	minute: '2-digit',
	hour12: true
});

const HOUR = new Intl.DateTimeFormat('en-US', {
	timeZone: 'UTC',
	hour: 'numeric',
	hour12: true
});

/**
 * A time on the board, e.g. "7:00 PM". Midnight reads "12:00 AM" and noon
 * "12:00 PM", which is the whole reason this goes through `Intl` rather than
 * through arithmetic on the hour: a hand-rolled twelve-hour clock prints a bare
 * "0:00 AM" for both ends of the day and the mistake is invisible until
 * somebody is standing outside a closed restaurant.
 *
 * The board's last minute is 1440, midnight at the *end* of the day, and it
 * reads "12:00 AM" like any other midnight. Nothing is lost: it is only ever
 * shown as the far end of a range that started earlier the same day.
 */
export function clock(min: number): string {
	return CLOCK.format(at(min));
}

/**
 * A span, e.g. "9:00 - 11:00 AM" or "11:30 AM - 1:00 PM".
 *
 * The meridiem is said once when both ends share it. Blocks are narrow and
 * "9:00 AM - 11:00 AM" spends a third of the line repeating a word that has not
 * changed, which is also how anyone would write it down.
 *
 * A range that crosses noon or midnight keeps both, because there the meridiem
 * is the information.
 */
export function clockRange(from: number, to: number): string {
	const a = clock(from);
	const b = clock(to);
	const meridiem = a.slice(-2);
	return meridiem === b.slice(-2) ? `${a.slice(0, -3)} - ${b}` : `${a} - ${b}`;
}

/**
 * An hour line's label, e.g. "6 AM", "12 PM", "11 PM".
 *
 * Minuteless because an hour line is always on the hour, and ":00" under every
 * one of them is nineteen repetitions of nothing. It also keeps the label
 * inside the gutter it has always had: "6 AM" is narrower than "6:00 AM" and no
 * wider than the "6:00" it replaces, so the grid does not move.
 */
export function hourLabel(hour: number): string {
	return HOUR.format(at(hour * 60));
}

/** Shift an ISO day, in UTC so a DST boundary cannot move it. */
export function shiftDay(iso: string, delta: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

export function clampMin(v: number, start: number): number {
	return Math.max(start, Math.min(v, DAY_END));
}

export function topPx(min: number, start: number): number {
	return (clampMin(min, start) - start) * PX_PER_MIN;
}

export function heightPx(from: number, to: number, start: number): number {
	return Math.max(3, (clampMin(to, start) - clampMin(from, start)) * PX_PER_MIN);
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

/**
 * Discover's saved places, for the location picker.
 *
 * Grouped by city with the day's own city first, because a trip that visits
 * four cities has a list four times longer than the one the reader wants, and
 * the place they mean is almost always in the city they are looking at. The
 * grouping is an order plus a section name: `Select` draws a heading wherever
 * the section changes.
 *
 * Each place carries its Discover votes, because scheduling is where the group's
 * shortlist is spent: the question being answered is "what are we doing", and
 * how many people asked for a place is the trip's own answer to it.
 */
export function placeOptions(
	saved: SavedPoi[],
	cities: (Cell | null)[],
	currentCityId: string | null
): Option[] {
	const known = cities.filter((c): c is Cell => c != null);
	const names = new Map(known.map((c) => [c.id, c.name]));
	const rank = (id: string) =>
		id === currentCityId ? -1 : known.findIndex((c) => c.id === id) + 1 || known.length + 1;

	const sorted = [...saved].sort(
		(a, b) => rank(a.city_id) - rank(b.city_id) || b.votes - a.votes || a.name.localeCompare(b.name)
	);

	return [
		{ value: '', label: 'No location' },
		...sorted.map((p) => ({
			value: p.id,
			label: p.name,
			hint: p.votes ? `${p.votes} ${p.votes === 1 ? 'vote' : 'votes'}` : undefined,
			// A place whose city has been removed from the trip still exists and
			// still has coordinates, so it is offered rather than hidden.
			section: names.get(p.city_id) ?? 'Elsewhere'
		}))
	];
}

/**
 * What the place field is called for a given type.
 *
 * The event's own noun, so the field says what is being picked: an activity
 * block is picking the activity, and a stay is picking the stay. A journey is
 * the exception, since its place is where it puts you rather than where it is.
 */
export function placeLabel(type: EventType): string {
	return type === 'travel' ? 'Ends at' : typeLabel(type);
}

/**
 * What an unnamed block will end up called.
 *
 * Picking a place is how a block is usually added, so the name is optional and
 * the server names the ones that arrive without one: the place, else the first
 * line of the notes, else the type's own noun. This mirrors that order so the
 * preview on the board shows the name that is about to be saved rather than a
 * placeholder the reader never asked for.
 *
 * It is a mirror and nothing more. The server derives the stored name and wins
 * every disagreement; this only has to be close enough that the block does not
 * appear to rename itself the moment it is saved.
 */
export function deriveTitle(
	typed: string,
	placeName: string | null,
	notes: string,
	type: EventType
): string {
	const named = typed.trim();
	if (named) return named;
	if (placeName) return placeName;
	const line = notes.split('\n').find((l) => l.trim());
	if (line) return line.trim();
	if (type === 'travel' || type === 'freetime') return typeLabel(type);
	return 'New event';
}

/**
 * Whether a place already picked survives a change of type.
 *
 * A stay picks from the stays the group is voting on and every other type picks
 * from Discover's saved places, so crossing that line leaves the field holding
 * an id from the wrong list: it would show as blank and save as a link to
 * something the block is not.
 */
export function keepsPick(from: EventType, to: EventType): boolean {
	return (from === 'stay') === (to === 'stay');
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
