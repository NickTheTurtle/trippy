/**
 * What a day board block has room to say, worked out from its drawn size.
 *
 * Blocks clip their overflow, so a block with more text than height used to
 * slice a line through the middle: a 30-minute lunch under a journey bar
 * showed the top half of its time, which reads as a different time rather
 * than a cut. The text is budgeted instead, in whole lines, so whatever is
 * drawn is drawn whole.
 *
 * Tall enough for a title line and a time line, the block stacks: the title
 * (two lines when it needs them and there is room), the time, then who is on
 * it if a whole line is left. Shorter, it is one line, the title ellipsized
 * beside the time; a very short one, or one too narrow to keep the time
 * whole beside a few letters of title, shows the title alone. The grid still
 * says when it is.
 *
 * Pure, so the sizes are tested without a renderer. The line heights are the
 * block's own styles in `DayBoard.tsx`.
 */
export const TITLE_LINE = 15;
export const SMALL_LINE = 12;
/** Top and bottom padding when there is room for it, and the least a stack keeps. */
export const PAD_V = 4;
const PAD_MIN = 2;
/** The block's left (past its colour stripe) and right padding. */
export const PAD_LEFT = 10;
export const PAD_RIGHT = 7;
/** Below this height a one-line block drops its time: about a 15-minute block. */
export const TITLE_ONLY_BELOW = 22;
/** A rough average advance for the 12px bold title and the 10px time. */
const TITLE_CHAR_W = 7;
const TIME_CHAR_W = 5.6;
/** The least of the title kept visible beside the time on one line. */
const TITLE_KEEP_W = 40;

export type BlockFit =
	| { kind: 'stack'; titleLines: number; people: boolean; padV: number }
	| { kind: 'line'; time: boolean; padV: number };

export function blockFit(height: number, width: number, title: string, time: string): BlockFit {
	const textW = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
	const inner = height - 2 * PAD_MIN;
	if (inner >= TITLE_LINE + SMALL_LINE) {
		const wants = Math.min(2, Math.max(1, Math.ceil((title.length * TITLE_CHAR_W) / textW)));
		const titleLines = Math.max(1, Math.min(wants, Math.floor((inner - SMALL_LINE) / TITLE_LINE)));
		const people = inner - titleLines * TITLE_LINE - SMALL_LINE >= SMALL_LINE;
		const used = titleLines * TITLE_LINE + SMALL_LINE + (people ? SMALL_LINE : 0);
		return {
			kind: 'stack',
			titleLines,
			people,
			padV: Math.max(0, Math.min(PAD_V, Math.floor((height - used) / 2)))
		};
	}
	const timeFits = textW >= time.length * TIME_CHAR_W + TITLE_KEEP_W;
	return {
		kind: 'line',
		time: height >= TITLE_ONLY_BELOW && timeFits,
		padV: Math.max(0, Math.min(PAD_V, Math.floor((height - TITLE_LINE) / 2)))
	};
}
