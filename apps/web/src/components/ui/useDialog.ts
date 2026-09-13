import { useEffect, useRef, type MouseEvent, type SyntheticEvent } from 'react';
import { lockScroll } from '../../lib/scroll-lock';

/**
 * The native <dialog> plumbing behind `Modal`.
 *
 * Kept apart from the chrome it carries: `showModal()` is what makes the page
 * behind a dialog inert, traps focus, closes on Escape and gives focus back to
 * whatever opened it, which is the reason no surface here is a positioned
 * <div>. The corners below were each found the hard way, so they are written
 * down once rather than in every dialog-shaped component. The drawer that used
 * to share this is gone: narrow layouts switch sections with pills now.
 */
export function useDialog({
	open,
	onClose,
	onOpened,
	lockPage = true
}: {
	open: boolean;
	onClose: () => void;
	/** Runs after `showModal()`, for a surface that wants focus somewhere specific. */
	onOpened?: (dialog: HTMLDialogElement) => void;
	/**
	 * Whether the page behind is frozen. True for every dialog that covers what
	 * it edits, which is nearly all of them. A docked dialog sets it false: it
	 * has stepped aside so the page can be read while it is open, and a page
	 * that cannot be scrolled to the part being edited is no better than one
	 * that is covered.
	 */
	lockPage?: boolean;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	// Tracks whether the press that may become a click started on the backdrop,
	// so a drag that merely *ends* outside the panel does not close it.
	const downOutside = useRef(false);
	// What had focus when the dialog opened. <dialog> restores focus itself, but
	// only when `close()` actually runs on a connected element. Most callers
	// render this as `{editing && <Modal/>}`, so React unmounts the whole dialog
	// before the close effect can fire and the native restore never happens:
	// focus falls to <body> and a keyboard user is dropped at the top of the
	// page. Remembering the trigger here covers both shapes.
	//
	// It outlives a single open/close on purpose. A form steps aside while its
	// delete is confirmed and comes back when the answer is no, and what had
	// focus at that moment is a button in the confirmation that is itself
	// closing. Remembering that would hand focus to something invisible, so the
	// row that started the chain is kept instead.
	const opener = useRef<HTMLElement | null>(null);
	// Held in a ref so the open effect does not re-run, and re-show the dialog,
	// every time a caller passes a fresh inline callback.
	const onOpenedRef = useRef(onOpened);
	onOpenedRef.current = onOpened;

	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (open && !d.open) {
			const active = document.activeElement as HTMLElement | null;
			// <body> is what the browser falls back to while the dialog this one is
			// replacing goes away, and it is nothing to hand focus back to, so the
			// row that started the chain is kept instead.
			if (active && active !== document.body && !active.closest('dialog')) opener.current = active;
			d.showModal();
			onOpenedRef.current?.(d);
		} else if (!open && d.open) d.close();
	}, [open]);

	// Closing on unmount is what makes the focus restore below possible at all.
	// A modal <dialog> makes the rest of the document inert, and React unmounts
	// the component without ever calling close(), so the page would be left
	// inert for as long as it takes the node to be removed: any focus() aimed at
	// the trigger in that window is silently dropped. Mount-scoped on purpose, so
	// it fires only for the real teardown and not on every `open` change.
	useEffect(() => {
		const d = ref.current;
		return () => {
			if (d?.open) d.close();
		};
	}, []);

	// Runs when `open` goes false *and* when an open dialog is unmounted, which
	// is the case the native behaviour misses. Deferred to a microtask because
	// React tears the DOM down after running this cleanup: focusing here
	// directly works, and is then undone a moment later when the still-focused
	// dialog is removed and the browser falls back to <body>. Guarded on
	// `isConnected` because the trigger is often a row the dialog just deleted.
	useEffect(() => {
		if (!open) return;
		// Captured while the component is alive: React nulls the ref before it
		// runs this cleanup on unmount, and the check below needs the element.
		const self = ref.current;
		return () => {
			const trigger = opener.current;
			if (!trigger) return;
			queueMicrotask(() => {
				// Not when another dialog already holds focus: the confirmation this
				// form just opened has taken it, and pulling it back would drop the
				// reader out of the question they were asked.
				const host = (document.activeElement as HTMLElement | null)?.closest('dialog[open]');
				if (host && host !== self) return;
				if (trigger.isConnected) trigger.focus();
			});
		};
	}, [open]);

	// The page behind must not scroll with the surface; without this you get the
	// dialog's scrollbar and the document's side by side.
	useEffect(() => (open && lockPage ? lockScroll() : undefined), [open, lockPage]);

	/**
	 * A <dialog>'s backdrop is part of the element itself, so a click on it
	 * targets the dialog, but so does a click on the dialog's own padding.
	 * Comparing against the border box is what tells the two apart.
	 */
	function hitBackdrop(e: { target: EventTarget | null; clientX: number; clientY: number }) {
		const d = ref.current;
		if (!d || e.target !== d) return false;
		const r = d.getBoundingClientRect();
		return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
	}

	return {
		ref,
		/** Spread onto the <dialog>. */
		dialogProps: {
			onCancel: (e: SyntheticEvent) => {
				// Escape fires `cancel`, which closes the dialog directly and would
				// leave `open` true. Preventing it keeps React the only thing that
				// decides whether the dialog is open.
				e.preventDefault();
				onClose();
			},
			onMouseDown: (e: MouseEvent) => {
				downOutside.current = hitBackdrop(e);
			},
			onClick: (e: MouseEvent) => {
				if (downOutside.current && hitBackdrop(e)) onClose();
				downOutside.current = false;
			}
		}
	};
}
