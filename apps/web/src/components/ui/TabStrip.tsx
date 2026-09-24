import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import usePageTransition from '../../hooks/usePageTransition';

export type TabItem = { slug: string; label: string };

/**
 * The trip's top-level tabs.
 *
 * Wide enough and this is a plain row. Narrow enough and it scrolls, which is
 * the right shape (the tabs are one flat set, and stacking or collapsing them
 * would hide the thing the page is navigated by) but on its own it is a bad
 * one: a scroller with nothing hanging over the edge looks identical to a
 * scroller with three more tabs past it, and arriving on a later tab put the
 * tab you were on off-screen with no sign of it.
 *
 * So two things are measured rather than styled. A fade is drawn on whichever
 * edge still has tabs behind it, and the active tab is scrolled into view when
 * it changes. Both need real geometry: whether the row overflows depends on the
 * text the browser actually laid out, not on a breakpoint.
 *
 * The active tab's underline is measured too. It is one bar that travels to the
 * tab that was chosen rather than a border that switches off one tab and on
 * another, so the change reads as a move along the row and the eye is carried
 * to where it landed. A border cannot do that: there is nothing in between two
 * borders to animate.
 */
export default function TabStrip({ base, tabs }: { base: string; tabs: readonly TabItem[] }) {
	const ref = useRef<HTMLElement | null>(null);
	const inkRef = useRef<HTMLSpanElement>(null);
	const placed = useRef(false);
	const [edges, setEdges] = useState({ left: false, right: false });
	const { pathname } = useLocation();
	const pageTo = usePageTransition();
	// Where the tab now showing sits in the row, so a click knows which way the
	// section should travel: a later tab enters from the right, an earlier one
	// from the left. A path that is on no tab (a redirect passing through) ranks
	// -1, which simply reads as "everything is forward of it".
	const currentIndex = tabs.findIndex((t) => pathname.split('/')[3] === t.slug);

	const measure = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		// A pixel of slack: scrollLeft is fractional under a zoomed or scaled
		// viewport, so an exact comparison leaves the fade on at the very end.
		const max = el.scrollWidth - el.clientWidth;
		setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
	}, []);

	const placeInk = useCallback(() => {
		const el = ref.current;
		const ink = inkRef.current;
		if (!el || !ink) return;
		const active = el.querySelector<HTMLElement>('[aria-current="page"]');
		if (!active) {
			ink.style.opacity = '0';
			placed.current = false;
			return;
		}
		// Offsets, not bounding rects: they are relative to the scrolled content,
		// so the bar rides the row when it scrolls instead of being re-placed.
		const put = () => {
			ink.style.opacity = '1';
			ink.style.width = `${active.offsetWidth}px`;
			ink.style.transform = `translateX(${active.offsetLeft}px)`;
		};
		if (placed.current) return put();
		// The bar has nowhere to travel from the first time, and a re-measure
		// after a resize is not a tab change, so both land without animating.
		ink.style.transition = 'none';
		put();
		void ink.offsetWidth;
		ink.style.transition = '';
		placed.current = true;
	}, []);

	/**
	 * Scrolls the row so the active tab sits in the middle, clamped to the ends.
	 *
	 * Centred, not merely brought into view. Scrolled only as far as it took to
	 * show the active tab, the row stopped with that tab flush against the edge,
	 * so on Expenses at 390px People was wholly off screen and the row looked
	 * finished. Centring leaves a neighbour peeking out on every side that has
	 * more, which is the affordance.
	 *
	 * Offsets rather than `scrollIntoView`, which walks up every scrollable
	 * ancestor and would drag the whole page vertically to bring a tab
	 * horizontally into view.
	 */
	const centre = useCallback((smooth: boolean) => {
		const el = ref.current;
		const active = el?.querySelector<HTMLElement>('[aria-current="page"]');
		if (!el || !active) return;
		const max = el.scrollWidth - el.clientWidth;
		if (max <= 0) return;
		const mid = active.offsetLeft + active.offsetWidth / 2 - el.clientWidth / 2;
		// Glides on a tab change, jumps otherwise: arriving on a page, or the
		// row reflowing under a new font, is not a move anybody asked to watch.
		el.scrollTo({ left: Math.max(0, Math.min(max, mid)), behavior: smooth ? 'smooth' : 'instant' });
	}, []);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		measure();
		// The row reflows when the window resizes and also when a font finishes
		// loading, and ResizeObserver catches both without a font-loading hook.
		// Both change where the middle is, so the row is re-centred as well: the
		// first centring runs before the web font arrives, against labels that
		// are about to get wider, and left the row short of where it meant to be.
		const ro = new ResizeObserver(() => {
			centre(false);
			measure();
			placed.current = false;
			placeInk();
		});
		ro.observe(el);
		for (const child of el.children) if (child !== inkRef.current) ro.observe(child);
		return () => ro.disconnect();
	}, [measure, placeInk, centre]);

	useLayoutEffect(() => {
		// `placed` is false until the ink has been put down once, which is the
		// same "is this the first placement" question the scroll is asking.
		centre(placed.current);
		measure();
		placeInk();
	}, [pathname, measure, placeInk, centre]);

	return (
		<div className={`tabswrap${edges.left ? ' more-l' : ''}${edges.right ? ' more-r' : ''}`}>
			<nav className="tabs" ref={ref} onScroll={measure}>
				{tabs.map((t, i) => (
					<NavLink
						key={t.slug}
						to={`${base}/${t.slug}`}
						onClick={(e) => {
							// Let the browser have modified and non-primary clicks so a tab
							// can still be opened in a new tab or window, and do nothing on
							// the tab already showing. Everything else pages with a View
							// Transition instead of a plain navigation.
							if (
								e.button !== 0 ||
								e.metaKey ||
								e.ctrlKey ||
								e.shiftKey ||
								e.altKey ||
								i === currentIndex
							) {
								return;
							}
							e.preventDefault();
							pageTo(`${base}/${t.slug}`, i > currentIndex);
						}}
						className={({ isActive }) =>
							[
								'border-b-2 border-transparent px-3.5 py-2.5 text-body font-medium whitespace-nowrap',
								isActive ? 'text-accent-ink' : 'text-ink-soft hover:text-ink'
							].join(' ')
						}
					>
						{t.label}
					</NavLink>
				))}
				<span className="tabink" ref={inkRef} aria-hidden="true" />
			</nav>
		</div>
	);
}
