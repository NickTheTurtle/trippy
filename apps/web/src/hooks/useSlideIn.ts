import { useLayoutEffect, useRef, type RefObject } from 'react';
import useMediaQuery from './useMediaQuery';

/** How far the arriving panel starts from where it lands.
 *
 * Far enough to be read as a move rather than a nudge. This has been raised
 * twice: 18px was invisible against a full page of content and 28px still read
 * as a twitch rather than an arrival. A whole panel is a large object, and a
 * large object has to travel a proportionate distance before the eye accepts
 * that it came from somewhere. The ceiling is the width of the gutter beside
 * the container, since anything wider makes the clipped edge obvious. */
const SLIDE_PX = 64;
/** Long enough to be followed, short enough not to be waited on.
 *
 * Paired with a curve that spends most of its distance in the first third and
 * then glides, so the panel is where it belongs almost at once and the rest of
 * the time is only the settle. A near-linear curve over this distance reads as
 * a shove. Raised with the distance: holding 320ms over 64px would have made
 * the opening of the move faster rather than longer. */
const SLIDE_MS = 380;
const SLIDE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * Slides a panel in place from the side it came from when its contents change.
 *
 * Two callers on the schedule. The board card slides when the view changes
 * (Day and Agenda replace what the card draws, and there is no gesture between
 * them to borrow), and the agenda's list slides when its day changes, since the
 * list has no strip of days under it to travel. The day board's own step is not
 * a caller: it is a real horizontal movement of the strip. The tab change,
 * which pages the whole section, was a caller once and is now its own gesture
 * in `usePageTransition`: a full-section carousel is a different motion (two
 * panels travelling past each other rather than one arriving) and forcing both
 * through one hook served neither well. The cost of a bare swap is that it says
 * nothing: the content is simply different, with no sign that a step was taken
 * or which way it went, which is what the slide supplies.
 *
 * The move plays once the panel has content, which for the board is at once:
 * the trip's days are already loaded, so the board never empties between steps.
 * The readiness gate is kept because it is harmless here and the hook stays
 * honest about only moving something that is there to be seen; a panel that is
 * momentarily empty waits for it to fill rather than sliding an empty box.
 *
 * `rank` is what supplies the direction, and it is the caller's because only
 * the caller knows what "forward" means: the calendar for the schedule.
 * A later day slides in from the right and an earlier one from the left, so the
 * motion agrees with the run of days.
 *
 * Scripted rather than driven by a React `key` and a CSS class, for two
 * reasons. A key would remount the panel on every step, and on the schedule
 * that throws away the measured lane width and flashes a wrongly sized grid
 * before the ResizeObserver catches up. A class cannot replay itself either:
 * stepping twice the same way leaves the class unchanged, so the second step
 * would be still.
 *
 * Nothing fades by default. The board is being moved, not swapped out, and a
 * board that dimmed on the way in would say something happened to its contents
 * rather than to the reader's place in a sequence. The agenda's day step is the
 * caller that asks for the fade: there the list really is replaced, with no
 * strip underneath to carry it, so a short slide in the direction of travel
 * says which way it went and the fade covers the swap of rows.
 *
 * Started in a layout effect, so the first frame the new content is painted in
 * is already the first frame of the move. A passive effect let the browser
 * paint the arrival in place once and then jump it sideways to start sliding.
 *
 * A null `key` forgets what was shown, so content that comes back after being
 * away (the agenda after a spell on the day board) arrives still rather than
 * sliding from wherever it was last.
 */
export default function useSlideIn(
	ref: RefObject<HTMLElement | null>,
	/** What is on screen now. A change here is what a step is. */
	key: string | null,
	/** Where `key` sits in its sequence. Larger is further forward. */
	rank: number,
	/** A shorter move than the whole board's, and whether it fades in as well. */
	options: { px?: number; ms?: number; fade?: boolean } = {}
): void {
	const shown = useRef<{ key: string; rank: number } | null>(null);
	const stillness = useMediaQuery('(prefers-reduced-motion: reduce)');
	const { px = SLIDE_PX, ms = SLIDE_MS, fade = false } = options;

	useLayoutEffect(() => {
		const was = shown.current;
		shown.current = key === null ? null : { key, rank };
		const el = ref.current;
		// The first panel has nowhere to have come from, two steps to the same
		// place is not a step, and a reader who asked for stillness gets it.
		if (!el || key === null || !was || was.key === key || stillness) return;
		if (rank === was.rank) return;

		const offset = rank > was.rank ? px : -px;
		let anim: Animation | null = null;
		let observer: MutationObserver | null = null;

		const play = () => {
			if (anim) return;
			const from: Keyframe = { transform: `translateX(${offset}px)` };
			const to: Keyframe = { transform: 'none' };
			if (fade) {
				from.opacity = 0;
				to.opacity = 1;
			}
			anim = el.animate([from, to], { duration: ms, easing: SLIDE_EASE });
			// Left unfilled deliberately: the panel holds no transform once this is
			// done, so it cannot go on being the containing block for the fixed
			// dropdowns and dialogs that are anchored against the viewport.
		};

		// A section that is still fetching renders nothing, so an empty panel is
		// the sign the arriving content is not here yet. Wait for it rather than
		// slide the empty box, however long it takes; the wait is ended only by
		// content arriving or by this step being replaced.
		const ready = () => el.childElementCount > 0 || (el.textContent ?? '').trim() !== '';
		if (ready()) {
			play();
		} else {
			observer = new MutationObserver(() => {
				if (!ready()) return;
				play();
				observer?.disconnect();
				observer = null;
			});
			observer.observe(el, { childList: true, subtree: true });
		}

		return () => {
			observer?.disconnect();
			anim?.cancel();
		};
	}, [ref, key, rank, stillness, px, ms, fade]);
}
