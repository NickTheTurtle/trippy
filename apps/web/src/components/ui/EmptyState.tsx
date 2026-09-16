import type { ReactNode } from 'react';
import EmptyMark from './EmptyMark';

/**
 * The shared "there is nothing here yet" panel.
 *
 * Six places had written their own, at four different text sizes and three
 * different paddings, and a couple of them stated the emptiness without saying
 * what to do about it. One component keeps the tone consistent.
 *
 * One size, one position, everywhere. Moving between tabs of the same trip
 * showed the same panel at three different heights, because each caller framed
 * it differently rather than because the component measured differently: the
 * block is `py-12` on every page, but Discover and Preparation put it inside a
 * `card px-5 py-5` while Expenses and the estimates put it inside a `card p-0`,
 * which is a 40px jump in the panel behind an identical drawing, and the two
 * computed states in Expenses were left-aligned and a third of the height. The
 * rule now is that **the empty state is the whole panel**: callers hand it an
 * unpadded `.card` and it brings its own padding, so nothing about the page it
 * is on can change its size.
 *
 * Two shapes, chosen by `graphic`, and they differ *only* by the drawing:
 *
 *  - **With it**, the drawing then one caption. This is what a list of things
 *    you add uses, because the space is already reserved for rows and a single
 *    grey sentence in the corner of it reads as a rendering failure rather than
 *    as an empty list.
 *  - **Without it**, the caption alone, for a state the app computed rather
 *    than a list you fill: "Everyone is even" is an answer, not an absence, and
 *    the fly with nowhere to go is the wrong picture of a settled ledger. It
 *    keeps the centring and the padding, so the two treatments on the Expenses
 *    tabs line up instead of reading as two different components.
 *
 * Rendered as a plain block either way: every caller sits inside a `.card` or a
 * grid cell, and a second box inside the first reads as a broken layout.
 */
export default function EmptyState({
	message,
	action,
	graphic = false,
	className = ''
}: {
	/** The one-line statement of what is not there yet. */
	message: ReactNode;
	/** Optional button or link. Style it with the shared `.btn` classes. */
	action?: ReactNode;
	/** Show the drawing. Off for a state the app computed rather than a list. */
	graphic?: boolean;
	className?: string;
}) {
	// One box for both shapes. The horizontal padding is the component's own, so
	// a caller can hand it a `.card` with no padding of its own and a long
	// caption still never touches the card's edge.
	return (
		<div className={`flex flex-col items-center gap-3 px-5 py-12 text-center ${className}`.trim()}>
			{graphic && <EmptyMark />}
			<p className="muted m-0 text-body">{message}</p>
			{action}
		</div>
	);
}
