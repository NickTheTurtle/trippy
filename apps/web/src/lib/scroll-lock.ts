/*
 * Framework-free DOM code. It cannot live in packages/core, which is forbidden
 * to touch the DOM so it stays portable to React Native, so it sits here beside
 * the only client that uses it.
 */
/**
 * Page scroll lock for modals.
 *
 * Setting `overflow: hidden` on the body removes the document scrollbar, and on
 * platforms with classic (space-consuming) scrollbars that widens the viewport
 * by ~15px, so the whole page visibly jumps sideways the moment a dialog
 * opens. Reserving exactly the width that was reclaimed keeps the page still.
 *
 * The amount is *measured across the lock* rather than assumed, because how
 * much (if any) width is reclaimed depends on the platform and the stylesheet:
 * classic scrollbars free the full track, overlay scrollbars (macOS, touch)
 * free nothing, a page too short to scroll frees nothing, and
 * `scrollbar-gutter: stable` keeps the gutter reserved so nothing moves either.
 * Padding by a hard-coded scrollbar width would introduce the very jump it is
 * meant to remove in three of those four cases.
 *
 * Reference-counted so nested or overlapping dialogs can't unlock each other.
 */

let depth = 0;
let prevOverflow = '';
let prevPadding = '';

export function lockScroll(): () => void {
	if (typeof document === 'undefined') return () => {};

	if (depth === 0) {
		const body = document.body;
		const root = document.documentElement;

		prevOverflow = body.style.overflow;
		prevPadding = body.style.paddingRight;

		const widthBefore = root.clientWidth;
		body.style.overflow = 'hidden';
		const reclaimed = root.clientWidth - widthBefore;

		if (reclaimed > 0) {
			const current = parseFloat(getComputedStyle(body).paddingRight) || 0;
			body.style.paddingRight = `${current + reclaimed}px`;
		}
	}
	depth++;

	let released = false;
	return () => {
		if (released) return;
		released = true;
		depth--;
		if (depth === 0) {
			document.body.style.overflow = prevOverflow;
			document.body.style.paddingRight = prevPadding;
		}
	};
}
