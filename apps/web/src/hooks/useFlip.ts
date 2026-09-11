import { useLayoutEffect, useRef } from 'react';

/**
 * Animates a container whose children change places.
 *
 * A grid that is ordered by something the reader can change (Discover is
 * ordered by votes) reshuffles under them the moment they act. Cards are laid
 * out by the grid, not by coordinates we control, so there is nothing to put a
 * CSS transition on: the browser simply paints them somewhere else. The jump is
 * the problem, because the whole point of the reorder is that *this* card
 * overtook *that* one, and a cut shows the result while hiding the move.
 *
 * So: FLIP. Remember where each child was, let the browser lay the new order
 * out, then offset every child back to where it came from and animate that
 * offset away. The layout is never fought, only the paint, which is why this
 * works with an `auto-fill` grid whose column count we do not know.
 *
 * Children opt in with `data-flip="<stable key>"`. The key must identify the
 * thing, not its position, or a card would animate into the slot of whichever
 * card happens to be standing where it used to be.
 *
 * `signature` is what makes measuring cheap: reading a rect per child forces
 * layout, so it happens only when the caller says the order or contents could
 * have moved, not on every render.
 */
export function useFlip<T extends HTMLElement>(signature: string) {
	const ref = useRef<T>(null);
	const seen = useRef(new Map<string, { x: number; y: number }>());

	useLayoutEffect(() => {
		const host = ref.current;
		if (!host) return;
		/* Positions are measured relative to the container, not the viewport.
		   `getBoundingClientRect` is viewport-relative, so a scroll between two
		   renders moves every child by the same amount and FLIP would read the
		   whole grid as having reshuffled: scrolling and then voting slid all
		   eighteen cards across the screen. The container scrolls with its
		   children, so subtracting it leaves only real movement. */
		const origin = host.getBoundingClientRect();
		// Read every position first, then animate. Interleaving the two would
		// measure children against layouts their moved siblings had already
		// invalidated.
		const now = new Map<string, { x: number; y: number }>();
		const moves: { el: HTMLElement; dx: number; dy: number }[] = [];
		for (const child of Array.from(host.children)) {
			const el = child as HTMLElement;
			const key = el.dataset.flip;
			if (!key) continue;
			const rect = el.getBoundingClientRect();
			const at = { x: rect.left - origin.left, y: rect.top - origin.top };
			now.set(key, at);
			const was = seen.current.get(key);
			if (!was) continue;
			const dx = was.x - at.x;
			const dy = was.y - at.y;
			// Sub-pixel drift is not a move, and animating it would fight the
			// browser's own rounding on every resize.
			if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
			moves.push({ el, dx, dy });
		}
		seen.current = now;

		if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
		for (const { el, dx, dy } of moves) {
			el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
				duration: 260,
				easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)'
			});
		}
	}, [signature]);

	return ref;
}
