/**
 * Focus (and select, for text inputs) an element as soon as it mounts.
 *
 * <dialog>.showModal() otherwise focuses the first tabbable node, which is
 * usually the close button, so put this on the field the user actually came to fill in.
 *
 * Pass `false` to skip: which field deserves the cursor can depend on how the
 * dialog was opened (a blank form starts at the name, a prefilled one at the
 * first thing still missing), and both fields need the action attached because
 * an action cannot be added conditionally.
 */
export function focusOnMount(node: HTMLElement, enabled: boolean = true) {
	if (!enabled) return;
	// Wait a frame so the dialog has finished its own focus handling first.
	requestAnimationFrame(() => {
		node.focus();
		if (node instanceof HTMLInputElement && node.type !== 'checkbox' && node.type !== 'number') {
			node.select();
		}
	});
}
