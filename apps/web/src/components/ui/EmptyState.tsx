import type { ReactNode } from 'react';
import EmptyMark from './EmptyMark';

/**
 * The shared "there is nothing here yet" panel.
 *
 * Six places had written their own, at four different text sizes and three
 * different paddings, and a couple of them stated the emptiness without saying
 * what to do about it. One component keeps the tone consistent.
 *
 * Two shapes, chosen by `graphic`:
 *
 *  - **With it**, a centred column: the drawing, then one caption. This is what
 *    a list of things you add uses, because the space is already reserved for
 *    rows and a single grey sentence in the corner of it reads as a rendering
 *    failure rather than as an empty list.
 *  - **Without it**, the bare left-aligned line it always was, for the tight
 *    spots where a drawing would not fit.
 *
 * Rendered as a plain block either way: every caller already sits inside a
 * `.card` or a grid cell, and a second box inside the first reads as a broken
 * layout.
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
	/** Show the drawing and centre the panel. */
	graphic?: boolean;
	className?: string;
}) {
	if (!graphic) {
		return (
			<div className={`flex flex-col items-start gap-2 py-6 ${className}`.trim()}>
				<p className="muted m-0 text-[0.9rem]">{message}</p>
				{action}
			</div>
		);
	}

	return (
		<div className={`flex flex-col items-center gap-3 py-12 text-center ${className}`.trim()}>
			<EmptyMark />
			<p className="muted m-0 text-[0.9rem]">{message}</p>
			{action}
		</div>
	);
}
