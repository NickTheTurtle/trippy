import type { ReactNode } from 'react';

/**
 * The shared "there is nothing here yet" line.
 *
 * Six places had written their own, at four different text sizes and three
 * different paddings, and a couple of them stated the emptiness without saying
 * what to do about it. One component keeps the tone consistent: say what is
 * missing, then offer the way out with an action.
 *
 * Rendered as a `<p>` with an optional action underneath rather than as a card,
 * because every current caller already sits inside a `.card` or a grid cell and
 * a second box inside the first reads as a broken layout.
 */
export default function EmptyState({
	message,
	action,
	className = ''
}: {
	/** The one-line statement of what is not there yet. */
	message: ReactNode;
	/** Optional button or link. Style it with the shared `.btn` classes. */
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div className={`flex flex-col items-start gap-2 py-6 ${className}`.trim()}>
			<p className="muted m-0 text-[0.9rem]">{message}</p>
			{action}
		</div>
	);
}
