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
 */

const GAP = 4;
const MARGIN = 8;
const MIN_HEIGHT = 120;

export type AnchorOptions = { trigger: HTMLElement | undefined; maxHeight?: number };

export function anchor(menu: HTMLElement, opts: AnchorOptions) {
	let current = opts;

	function place() {
		const trigger = current.trigger;
		if (!trigger) return;
		const r = trigger.getBoundingClientRect();
		const cap = current.maxHeight ?? 256;
		const below = window.innerHeight - r.bottom - GAP - MARGIN;
		const above = r.top - GAP - MARGIN;

		// Prefer below, but flip when it is cramped and there is more room above.
		const up = below < MIN_HEIGHT && above > below;
		const room = Math.max(MIN_HEIGHT, up ? above : below);

		menu.style.position = 'fixed';
		menu.style.minWidth = `${r.width}px`;
		menu.style.maxHeight = `${Math.min(cap, room)}px`;

		// Measure after the height cap so a flipped menu sits flush on the trigger.
		const h = menu.offsetHeight;
		const w = menu.offsetWidth;
		menu.style.top = `${up ? Math.max(MARGIN, r.top - GAP - h) : r.bottom + GAP}px`;
		menu.style.left = `${Math.round(
			Math.min(Math.max(MARGIN, r.left), Math.max(MARGIN, window.innerWidth - w - MARGIN))
		)}px`;
	}

	place();
	// Capture phase so scrolling in any ancestor (including .mbody) is caught.
	window.addEventListener('scroll', place, true);
	window.addEventListener('resize', place);
	const ro = new ResizeObserver(place);
	if (opts.trigger) ro.observe(opts.trigger);

	return {
		update(next: AnchorOptions) {
			current = next;
			place();
		},
		destroy() {
			window.removeEventListener('scroll', place, true);
			window.removeEventListener('resize', place);
			ro.disconnect();
		}
	};
}
