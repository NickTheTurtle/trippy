import { useEffect, useRef } from 'react';
import EmptyState from './EmptyState';
import { useToast } from './Toast';
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
	 * How to ask again. Left unset, the panel reloads the document, which is a
	 * real second attempt: a page whose own load failed has no state to lose by
	 * it, and the reload also clears the corner, so the answer on screen is
	 * always the latest one.
	 *
	 * `useApi` returns `reload`, which refetches only the endpoint that failed
	 * and is the cheaper path. It is not wired anywhere yet on purpose: a
	 * refetch that succeeds leaves the error it raised sitting in the corner,
	 * since errors do not expire and `toast.error` gives the caller no handle to
	 * take one back. Passing `reload` here wants that handle first.
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
	const toast = useToast();
	/* Announced once per distinct reason. A re-render is not a second failure,
	   and React's development mode mounts every component twice, which would
	   otherwise put the same sentence in the corner two times over.
	   
	   A retry that fails the same way is deliberately not re-announced either.
	   Errors do not expire, so the sentence is still in the corner, and a second
	   identical one would read as a second, different problem. A retry that
	   fails *differently* does announce, because that is news; and a retry that
	   succeeds unmounts this panel, so the next failure after it starts clean. */
	const announced = useRef<string | null>(null);

	useEffect(() => {
		if (announced.current === message) return;
		announced.current = message;
		toast.error(message);
	}, [message, toast]);

	if (!panel) return null;
	return (
		<EmptyState
			message={copy.api.loadFailed}
			className={className}
			action={
				<button
					type="button"
					className="btn mt-1"
					onClick={() => (onRetry ? onRetry() : window.location.reload())}
				>
					{copy.api.retry}
				</button>
			}
		/>
	);
}
