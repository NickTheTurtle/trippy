import { useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router';
import useMediaQuery from './useMediaQuery';

/**
 * Pages a trip's section like a carousel: the outgoing panel travels out while
 * the incoming one travels in the same direction, the two moving as adjacent
 * frames of one strip. This is the tab-change gesture; the schedule's in-place
 * day step is a different motion and stays in `useSlideIn`.
 *
 * It is a View Transition rather than two live React trees or an in-flow
 * transform. React Router renders one route at a time, so to show both panels
 * at once something has to hold the outgoing one on screen. Mounting the old
 * route alongside the new would run a second copy of a section's effects, its
 * data fetch and its slice of the trip's live event stream for the length of
 * the move; snapshotting into the top layer costs none of that. The snapshots
 * also slide in the top layer, so the displacement never reaches the document
 * and cannot widen the page at a phone width, and they are gone once the move
 * ends, so nothing is left holding a transform at rest.
 *
 * The catch a View Transition brings is that the "new" snapshot is a still
 * image captured the instant the DOM updates, and a section renders nothing
 * until its own fetch resolves, so captured then it would slide in blank and
 * the content would appear only once the move had finished. So the update
 * callback is async: it navigates and then holds until the panel actually has
 * content, which keeps the outgoing snapshot frozen and on screen in the
 * meantime. Both panels are therefore populated when they finally slide, so the
 * viewport is never empty and nothing arrives from nowhere. This is the same
 * readiness idea the incoming-only slide used, now spent on holding the
 * outgoing page rather than on delaying an empty one.
 */

/** How long a stalled section is waited for before the page is paged anyway.
 *
 * The hold keeps the old page frozen while the new one fills, which is right
 * until a fetch simply never resolves to anything: a section that renders no
 * content and no error would otherwise freeze navigation on the page just left.
 * Past this the move plays regardless, which at worst is the rare empty slide
 * the hold exists to avoid, and never a wedged UI. Sections that error render a
 * banner, which is content, so this ceiling is only for a truly silent stall. */
const READY_CEILING_MS = 2000;

type ViewTransition = { finished: Promise<unknown>; skipTransition?: () => void };
type DocumentWithViewTransitions = Document & {
	startViewTransition?: (callback: () => void | Promise<void>) => ViewTransition;
};

export default function usePageTransition(): (to: string, forward: boolean) => void {
	const navigate = useNavigate();
	const stillness = useMediaQuery('(prefers-reduced-motion: reduce)');
	// The move currently running, so a fast second tap that supersedes it does
	// not have its name and direction stripped by the first one finishing.
	const active = useRef<ViewTransition | null>(null);

	return useCallback(
		(to: string, forward: boolean) => {
			const doc = document as DocumentWithViewTransitions;
			const pane = doc.querySelector<HTMLElement>('.slidein');
			// A reader who asked for stillness, a browser without the API, or no
			// panel to move: just go, with an instant swap and no travel.
			if (stillness || !doc.startViewTransition || !pane) {
				navigate(to);
				return;
			}
			// A move is already playing. Stacking a second View Transition on top of
			// a running one drops the navigation, so a fast mash of three tabs would
			// otherwise land on the first, not the last. End the running one and go
			// straight there instead: the mashed steps jump rather than page, but the
			// last tab is always the one that lands and no half-played or queued
			// animation is left behind.
			if (active.current) {
				active.current.skipTransition?.();
				navigate(to);
				return;
			}

			// Named only for the length of the move, so at rest the panel carries no
			// view-transition-name and establishes no stacking context that a fixed
			// dropdown or dialog would be trapped inside.
			pane.style.viewTransitionName = 'trippage';
			// Read by the stylesheet to pick which way the two panels travel.
			doc.documentElement.dataset.pageNav = forward ? 'fwd' : 'back';

			const transition = doc.startViewTransition(async () => {
				flushSync(() => navigate(to));
				// Each section arrives at its own top. The outgoing snapshot already
				// holds the scroll the reader was at, so this moves only the incoming.
				window.scrollTo(0, 0);
				await settled(pane);
			});
			active.current = transition;
			transition.finished.finally(() => {
				// A later page change may already have re-armed these; only the most
				// recent move clears them, so a fast triple-tap never strips the live
				// transition of its name or its direction.
				if (active.current !== transition) return;
				active.current = null;
				pane.style.viewTransitionName = '';
				delete doc.documentElement.dataset.pageNav;
			});
		},
		[navigate, stillness]
	);
}

/**
 * Resolves once the panel holds something, or the ceiling is reached.
 *
 * The "Loading..." line does not count. Sections render it while their first
 * fetch is in flight, and it is a child with text, so without the exclusion
 * the hold ended the instant it appeared and the move slid in the placeholder:
 * the empty slide this hold exists to prevent, with a word on it. `Loading`
 * marks itself `data-loading` so this can tell it from the page.
 */
function settled(pane: HTMLElement): Promise<void> {
	const ready = () =>
		pane.querySelector('[data-loading]') === null &&
		(pane.childElementCount > 0 || (pane.textContent ?? '').trim() !== '');
	if (ready()) return Promise.resolve();
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			observer.disconnect();
			clearTimeout(timer);
			resolve();
		};
		const observer = new MutationObserver(() => {
			if (ready()) finish();
		});
		observer.observe(pane, { childList: true, subtree: true });
		const timer = window.setTimeout(finish, READY_CEILING_MS);
	});
}
