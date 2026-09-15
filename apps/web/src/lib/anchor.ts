import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

const GAP = 4;
const MARGIN = 8;
const MIN_HEIGHT = 120;
/** What an overlay scrollbar covers, since it reports no width of its own. */
const OVERLAY_BAR = 12;

/**
 * Anchors a popup menu to its trigger using `position: fixed`.
 *
 * Menus used to be `position: absolute` inside the control. That works on a
 * plain page but breaks inside a modal: `.mbody` is a scroll container, so an
 * absolutely-positioned menu is clipped by it and can push the modal into
 * scrolling. A fixed-position element escapes ancestor overflow entirely (and
 * still paints in the top layer when it lives inside an open `<dialog>`), so
 * the menu just needs its viewport coordinates written for it.
 *
 * It flips above the trigger when there is more room there, and caps its height
 * to the space available so a long list never runs off-screen.
 *
 * Ported from the Svelte `use:anchor` action. The action ran on mount because
 * the element only existed while open; here the effect keys off `open` for the
 * same reason.
 */
export function useAnchor<T extends HTMLElement, M extends HTMLElement>(
	open: boolean,
	maxHeight = 256
) {
	const triggerRef = useRef<T>(null);
	const menuRef = useRef<M>(null);

	const place = useCallback(() => {
		const trigger = triggerRef.current;
		const menu = menuRef.current;
		if (!trigger || !menu) return;

		const r = trigger.getBoundingClientRect();
		const below = window.innerHeight - r.bottom - GAP - MARGIN;
		const above = r.top - GAP - MARGIN;

		// Prefer below, but flip when it is cramped and there is more room above.
		const up = below < MIN_HEIGHT && above > below;
		const room = Math.max(MIN_HEIGHT, up ? above : below);

		menu.style.position = 'fixed';
		menu.style.minWidth = `${r.width}px`;
		// Cleared before measuring: `place` runs again on every scroll and resize,
		// and a width handed back last time would otherwise be grown again.
		menu.style.width = '';
		menu.style.maxHeight = `${Math.min(maxHeight, room)}px`;

		// A capped menu grows a vertical scrollbar, but its `width: max-content`
		// was measured without one, so the bar sits on top of the very option that
		// set the width. Hand back a gutter for it. A classic bar reports its own
		// width; an overlay bar measures zero and still paints over the text, so
		// there is a floor.
		if (menu.scrollHeight > menu.clientHeight) {
			const cs = getComputedStyle(menu);
			const borders = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
			const bar = menu.offsetWidth - menu.clientWidth - borders;
			menu.style.width = `${menu.offsetWidth + Math.max(bar, OVERLAY_BAR)}px`;
		}

		// Measure after the height cap so a flipped menu sits flush on the trigger.
		const h = menu.offsetHeight;
		const w = menu.offsetWidth;
		menu.style.top = `${up ? Math.max(MARGIN, r.top - GAP - h) : r.bottom + GAP}px`;
		menu.style.left = `${Math.round(
			Math.min(Math.max(MARGIN, r.left), Math.max(MARGIN, window.innerWidth - w - MARGIN))
		)}px`;
	}, [maxHeight]);

	// Layout effect, not effect: the menu must never paint at 0,0 before being
	// moved, which is a visible flash in the corner of the screen.
	useLayoutEffect(() => {
		if (!open) return;
		place();
	}, [open, place]);

	useEffect(() => {
		if (!open) return;
		// Capture phase so scrolling in any ancestor (including .mbody) is caught.
		window.addEventListener('scroll', place, true);
		window.addEventListener('resize', place);
		const ro = new ResizeObserver(place);
		if (triggerRef.current) ro.observe(triggerRef.current);
		return () => {
			window.removeEventListener('scroll', place, true);
			window.removeEventListener('resize', place);
			ro.disconnect();
		};
	}, [open, place]);

	return { triggerRef, menuRef };
}
