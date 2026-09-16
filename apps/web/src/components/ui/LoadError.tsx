import EmptyState from './EmptyState';
import { useErrorToast } from './Toast';
import { copy } from '../../copy';

/**
 * What a page shows when its own GET failed.
 *
 * The tinted block this replaces was doing two jobs at once, and a corner toast
 * on its own only does one of them. It said *why* the page is not there, which
 * is the server's own sentence and belongs with every other result; and it left
 * something on the screen, which a popup that floats away over a blank page
 * does not. So the failure is split in two. The reason goes to the corner,
 * where it does not expire, and the page keeps a line saying it could not load.
 *
 * The panel deliberately does not repeat the server's wording. The corner is
 * already carrying it, and the same sentence printed twice on one screen reads
 * as two separate failures.
 *
 * `EmptyState` without its drawing: the drawing is a joke about a list nobody
 * has filled in yet, and a joke over a server failure is the wrong tone.
 */
export default function LoadError({
	message,
	onRetry,
	panel = true,
	className = ''
}: {
	/** The resolved failure, already defaulted by `useApi`. */
	message: string;
	/**
	 * How to ask again. `useApi` returns `reload`, which refetches only the
	 * endpoint that failed and keeps the rest of the app alive, so it is what
	 * the pages pass.
	 *
	 * Unset, no button is drawn. A button offering another try with nothing
	 * behind it is worse than the line on its own.
	 */
	onRetry?: () => void;
	/**
	 * Whether the page has nothing else to show. A reload that fails underneath
	 * content that is already on screen is only a result, so it passes false and
	 * leaves the content alone.
	 */
	panel?: boolean;
	className?: string;
}) {
	/* Raised when this panel appears and retracted when it goes, so a retry that
	   works leaves nothing behind: `useApi` clears `error` on success and the
	   panel unmounts with its toast. The rest of the reasoning, including why
	   there is no guard ref, lives on `useErrorToast`, which the dialog footers
	   share. */
	useErrorToast(message);

	if (!panel) return null;
	return (
		<EmptyState
			message={copy.api.loadFailed}
			className={className}
			action={
				onRetry ? (
					<button type="button" className="btn mt-1" onClick={onRetry}>
						{copy.api.retry}
					</button>
				) : undefined
			}
		/>
	);
}
