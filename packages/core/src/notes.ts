/**
 * The trip's shared notepad: one block of free text per trip that every member
 * edits (see DESIGN.md 5.0.4, "Notes").
 *
 * Pure: no I/O, no DOM, no `Intl`. The web app, the native app and the API all
 * import this, so the length ceiling, the merge a client runs after a 409 and
 * the "edited 2 min ago" wording exist once.
 */

/**
 * The longest notepad the API stores, in characters as JavaScript counts them
 * (`string.length`, so UTF-16 code units).
 *
 * Far above `MAX_NOTES_LENGTH` in `validate.ts`, which caps the note on one
 * event or place. This is the whole trip's scratchpad: packing reminders, the
 * door code, a pasted itinerary. Twenty thousand is a few printed pages, past
 * which someone is pasting a document rather than writing notes.
 */
export const MAX_NOTES_BODY = 20000;

/** Whether a notepad body is short enough to store. Blank is allowed. */
export function isNotesBodyLength(body: string): boolean {
	return body.length <= MAX_NOTES_BODY;
}

/**
 * What an over-long notepad is told. The same sentence as
 * `copy.preparation.notes.tooLong`, so the API's 400 and a client's own check
 * read alike; a route test holds the two together.
 */
export function notesBodyTooLong(): string {
	return `Notes can be at most ${groupThousands(MAX_NOTES_BODY)} characters.`;
}

/** "20000" to "20,000" without `Intl`, which not every runtime this ships to has. */
function groupThousands(n: number): string {
	return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The notepad as `GET /api/trips/:tripId/pretrip/notes` answers it. */
export interface TripNotes {
	body: string;
	/** 0 until the first save. Send it back with a PUT; a stale one is a 409. */
	version: number;
	/** Milliseconds since the epoch of the last save, or null when never saved. */
	updatedAt: number | null;
	/** Who saved last, or null when never saved or that account is gone. */
	updatedBy: { id: string; name: string } | null;
}

// --- Three-way merge ---------------------------------------------------------

/**
 * One change on one side: base lines `[start, end)` became `lines`. An
 * insertion has `start === end`.
 */
interface Hunk {
	start: number;
	end: number;
	lines: string[];
	side: 0 | 1;
}

/**
 * The most cells the LCS table may hold after the common head and tail are
 * trimmed. Past it the changed middle is treated as one replaced block, which
 * the merge still resolves without losing a line, only more coarsely. Two
 * million 32-bit cells is 8 MB, which a phone can spare for the length of a
 * merge; a typical edit trims to a handful of lines and never comes near it.
 */
const MAX_LCS_CELLS = 2_000_000;

/**
 * The text as lines, split on "\n" and nothing else.
 *
 * The piece after the last "\n" is kept as a line of its own, so "a\n" is
 * `['a', '']` and "a" is `['a']`. That makes `join('\n')` the exact inverse, so
 * a trailing newline is just another line that one side can keep or drop, and
 * two lines can never be glued together by a merge. A "\r" stays on its line.
 *
 * The empty notepad is no lines at all rather than one empty line. Both join
 * back to "", but only this way round is clearing the notepad a deletion of
 * every line, which is what it is; as `['']` it was a rewrite of the whole text
 * into one blank line, and a merge against it left a stray blank line behind.
 */
function toLines(text: string): string[] {
	return text === '' ? [] : text.split('\n');
}

/**
 * The changes that turn `a` into `b`, as maximal runs of unmatched lines.
 *
 * Because each run is maximal, two hunks from one side are always separated by
 * at least one line that side left alone. The merge relies on that.
 */
function diff(a: string[], b: string[], side: 0 | 1): Hunk[] {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	) {
		tail++;
	}
	const n = a.length - head - tail;
	const m = b.length - head - tail;
	if (n === 0 && m === 0) return [];
	if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_LCS_CELLS) {
		return [{ start: head, end: head + n, lines: b.slice(head, head + m), side }];
	}

	// lcs[i * w + j]: the LCS length of a[head+i..] and b[head+j..] in the middle.
	const w = m + 1;
	const lcs = new Uint32Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i * w + j] =
				a[head + i] === b[head + j]
					? lcs[(i + 1) * w + j + 1] + 1
					: Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
		}
	}

	const hunks: Hunk[] = [];
	let i = 0;
	let j = 0;
	let gapA = 0;
	let gapB = 0;
	const flush = () => {
		if (i > gapA || j > gapB) {
			hunks.push({
				start: head + gapA,
				end: head + i,
				lines: b.slice(head + gapB, head + j),
				side
			});
		}
	};
	while (i < n && j < m) {
		if (a[head + i] === b[head + j]) {
			flush();
			i++;
			j++;
			gapA = i;
			gapB = j;
		} else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	i = n;
	j = m;
	flush();
	return hunks;
}

/**
 * Whether a hunk overlaps the block `[start, end)` that the merge is building.
 *
 * Two changes that only touch (one ends on the line where the other starts, or
 * one inserts right at the other's edge) are independent and both apply. Two
 * insertions at the same place are not: neither side's line has a right to go
 * first, so they are resolved as a conflict, ours then theirs.
 */
function overlaps(start: number, end: number, h: Hunk): boolean {
	if (start === end && h.start === h.end) return h.start === start;
	if (start === end) return start > h.start && start < h.end;
	if (h.start === h.end) return h.start > start && h.start < end;
	return h.start < end && h.end > start;
}

function sameLines(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((line, k) => line === b[k]);
}

/**
 * The longer of two versions when one is the other with more typed on the
 * end, or null. Compared as text (lines joined with "\n"), so "LONE ONE" is
 * covered by "LONE ONE TWO" and by "LONE ONE" followed by more lines. Keeping
 * only the longer is lossless: every character of the shorter is in it.
 *
 * Except when the shorter is base's text cut short ("Buy milk and eggs" to
 * "Buy milk"): that is somebody trimming the line on purpose, and the longer,
 * which still has what they cut, would silently undo it. Both are kept.
 */
function extension(a: string[], b: string[], base: string[]): string[] | null {
	const x = a.join('\n');
	const y = b.join('\n');
	const z = base.join('\n');
	const trimmed = (s: string) => s.length < z.length && z.startsWith(s);
	if (y.startsWith(x)) return trimmed(x) ? null : b;
	if (x.startsWith(y)) return trimmed(y) ? null : a;
	return null;
}

/**
 * Both sides' text for a block, without losing either.
 *
 * `ours` and `theirs` are the lines each side wrote in the block (either may be
 * empty, when only one side changed it or a side only deleted), and `base` the
 * block's lines before either. Identical versions are written once. So is a
 * version that the other merely continues: when one side's text is a prefix of
 * the other's, only the longer is kept (unless the shorter is base's text cut
 * short; see `extension`). That is the shape of one person's typing reaching
 * the server twice, a late save of "LONE ONE" landing after a later save of
 * "LONE ONE TWO", and keeping both would write the line out twice. Otherwise
 * the lines the two open and
 * close with in common are written once (and the prefix rule is applied again
 * to what is left between them), and between them ours goes first, then
 * theirs, with no conflict markers: in a notepad a marker is just more text
 * somebody has to find and delete, and the person who saves next sees both
 * versions and can keep the one they meant.
 */
function resolve(ours: string[], theirs: string[], base: string[]): string[] {
	if (sameLines(ours, theirs)) return ours;
	const whole = extension(ours, theirs, base);
	if (whole) return whole;
	let head = 0;
	while (head < ours.length && head < theirs.length && ours[head] === theirs[head]) head++;
	let tail = 0;
	while (
		tail < ours.length - head &&
		tail < theirs.length - head &&
		ours[ours.length - 1 - tail] === theirs[theirs.length - 1 - tail]
	) {
		tail++;
	}
	const mine = ours.slice(head, ours.length - tail);
	const yours = theirs.slice(head, theirs.length - tail);
	// Base's part of the middle, for the trim test in `extension`: the shared
	// lines come off it too, where base has them.
	let lo = 0;
	while (lo < head && lo < base.length && base[lo] === ours[lo]) lo++;
	let hi = 0;
	while (
		hi < tail &&
		hi < base.length - lo &&
		base[base.length - 1 - hi] === ours[ours.length - 1 - hi]
	) {
		hi++;
	}
	const was = base.slice(lo, base.length - hi);
	return [
		...ours.slice(0, head),
		...(extension(mine, yours, was) ?? [...mine, ...yours]),
		...ours.slice(ours.length - tail)
	];
}

/**
 * A line-based three-way merge of two edits of the same notepad.
 *
 * `base` is the text both edits started from, `ours` the local edit and
 * `theirs` what the server now holds. The rules:
 *
 * - a change made on one side only is applied;
 * - the same change made on both sides is applied once;
 * - where the two sides changed overlapping lines differently, both versions
 *   are kept, ours then theirs, with no conflict markers; unless one version's
 *   text is a prefix of the other's, when only the longer is kept, since it
 *   already holds every character of the shorter (but not when the shorter is
 *   base's text cut short, which is a deliberate trim the longer would undo).
 *
 * No line of either side is ever dropped, unless both sides dropped it or one
 * side dropped it and the other left it alone. Lines are split on "\n" and the
 * result is joined with "\n", so a trailing newline survives the way any other
 * line does, and an empty string is a notepad with no lines.
 *
 * Changes that only touch (one side edits line 3, the other line 4) are not a
 * conflict and both apply. A plain diff3 would stop there; a notepad that
 * duplicated two neighbouring lines whenever two people typed near each other
 * would be worse than useless.
 */
export function mergeNotes(base: string, ours: string, theirs: string): string {
	if (ours === theirs) return ours;
	if (base === ours) return theirs;
	if (base === theirs) return ours;

	const b = toLines(base);
	const o = toLines(ours);
	const t = toLines(theirs);
	// Ties: by position, then insertions before the change they sit in front of,
	// then ours before theirs, so two insertions at one place land ours-first.
	const hunks = [...diff(b, o, 0), ...diff(b, t, 1)].sort(
		(x, y) =>
			x.start - y.start || Number(x.end !== x.start) - Number(y.end !== y.start) || x.side - y.side
	);

	const out: string[] = [];
	let at = 0;
	let k = 0;
	while (k < hunks.length) {
		const group = [hunks[k]];
		let start = hunks[k].start;
		let end = hunks[k].end;
		k++;
		while (k < hunks.length && overlaps(start, end, hunks[k])) {
			group.push(hunks[k]);
			start = Math.min(start, hunks[k].start);
			end = Math.max(end, hunks[k].end);
			k++;
		}
		out.push(...b.slice(at, start));
		// Every base line in `[start, end)` is inside some hunk, because the block
		// is a chain of overlapping ones, so every one of them was changed or
		// deleted by at least one side and none is written back. A base line one
		// side left alone and the other rewrote is the "change on one side only"
		// rule; writing it back as part of the untouched side's text would
		// resurrect exactly what the other side replaced.
		const mine = group.filter((h) => h.side === 0).flatMap((h) => h.lines);
		const yours = group.filter((h) => h.side === 1).flatMap((h) => h.lines);
		out.push(...resolve(mine, yours, b.slice(start, end)));
		at = end;
	}
	out.push(...b.slice(at));
	return out.join('\n');
}

/**
 * How much two texts differ: the lengths of the two middles left once their
 * common start and common end are taken off, added together. One keystroke
 * scores 1, a paste scores its length, a whole rewrite scores both lengths.
 */
function changedMiddle(a: string, b: string): number {
	const shorter = Math.min(a.length, b.length);
	let head = 0;
	while (head < shorter && a.charCodeAt(head) === b.charCodeAt(head)) head++;
	let tail = 0;
	while (
		tail < shorter - head &&
		a.charCodeAt(a.length - 1 - tail) === b.charCodeAt(b.length - 1 - tail)
	) {
		tail++;
	}
	return a.length - head - tail + (b.length - head - tail);
}

/**
 * An edit that may have been made to text the box no longer holds.
 *
 * A client swapped the box from `previous` to `replaced` (somebody else's save
 * arrived), and then an edit event came in carrying `incoming`. A native text
 * view can report an edit it applied to what it held before the swap landed,
 * so `incoming` is either `replaced` plus a keystroke, or `previous` plus one.
 * Taking it at face value in the second case silently undoes the other
 * person's save.
 *
 * Which parent it came from is judged by which one it is closer to: the
 * smaller changed middle (see `changedMiddle`). Derived from `replaced`, it is
 * the box's new text as is. Derived from `previous`, it is merged with the
 * replacement as `mergeNotes(previous, incoming, replaced)`, so both the
 * keystroke and the other person's text survive. A tie goes to `replaced`,
 * which is what the box is supposed to hold; that also covers `previous ===
 * replaced`, where there is nothing to rebase.
 */
export function rebaseEdit(previous: string, replaced: string, incoming: string): string {
	if (previous === replaced) return incoming;
	if (changedMiddle(incoming, replaced) <= changedMiddle(incoming, previous)) return incoming;
	return mergeNotes(previous, incoming, replaced);
}

// --- "Edited 2 min ago" ------------------------------------------------------

const MONTHS = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec'
] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago a save was, for "Edited by Ana 2 min ago".
 *
 * Under a minute is "just now", and so is a time in the future, which is only
 * ever two clocks disagreeing. Then "N min ago" and "N h ago", rounded down.
 * From a day on it is the date, "Oct 19", with the year added when it is not
 * this year's.
 *
 * The date is the viewer's own calendar day (the runtime's local zone): it
 * answers "when did I last see this change", which is a question about the
 * reader's day, not about any city on the trip. Month names are spelled out
 * here rather than asked of `Intl`, and `Intl.RelativeTimeFormat` is not used
 * at all, because Hermes, the React Native engine, does not have it.
 */
export function editedAgo(atMs: number, nowMs: number): string {
	const ago = nowMs - atMs;
	if (!(ago >= MINUTE)) return 'just now';
	if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
	if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`;
	const at = new Date(atMs);
	const day = `${MONTHS[at.getMonth()]} ${at.getDate()}`;
	return at.getFullYear() === new Date(nowMs).getFullYear() ? day : `${day}, ${at.getFullYear()}`;
}
