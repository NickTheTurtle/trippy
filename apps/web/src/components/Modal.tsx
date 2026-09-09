import { useEffect, useId, useRef, type ReactNode } from 'react';
import { lockScroll } from '../scroll-lock';

/**
 * The one dialog used across the app.
 *
 * Built on the native <dialog> element via showModal(), which hands us focus
 * trapping, Escape-to-close, focus restore, background inertness and top-layer
 * rendering for free: all things a hand-rolled version has to reimplement, and
 * the reason this is not a positioned <div>.
 *
 * Layout is a flex column: the header and footer stay pinned and only .mbody
 * scrolls, so a tall dialog produces exactly one scrollbar instead of nesting
 * its own inside the page's.
 */
/**
 * Where the caret goes when a dialog opens.
 *
 * React's `autoFocus` cannot do this on its own here, and every dialog in the
 * app was quietly affected. React does not render `autofocus` as an attribute;
 * it calls `.focus()` during commit, at which point this dialog has not been
 * shown yet and is therefore `display: none`, so the call does nothing. Then
 * `showModal()` runs and gives focus to the first tabbable element, which is
 * the close button in every dialog this app has.
 *
 * So the choice is made here, after `showModal()`, and deliberately narrowly:
 *
 *  - an explicit `[autofocus]` or `[data-autofocus]` wins, which is the escape
 *    hatch for a form whose interesting field is not its first one;
 *  - otherwise the first enabled text-entry control in the body.
 *
 * Buttons are not candidates on purpose. A confirmation dialog's body has no
 * fields, so it keeps the native behaviour rather than opening with "Delete"
 * focused and one stray Enter away from happening.
 *
 * A dialog can opt out entirely with `autoFocusField={false}`, and one does:
 * the itinerary editor is a list of rows that already exist, so its first field
 * is a saved arrival date. Landing there means a stray keystroke edits real
 * data, which is a bad trade for saving one Tab. It keeps the native landing
 * spot, the close button.
 */
function focusFirstField(dialog: HTMLDialogElement): void {
	const explicit = dialog.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
	if (explicit) {
		explicit.focus();
		return;
	}
	const field = dialog.querySelector<HTMLElement>(
		'.mbody input:not([type="hidden"]):not([disabled]):not([readonly]), .mbody select:not([disabled]), .mbody textarea:not([disabled]):not([readonly])'
	);
	field?.focus();
}

export default function Modal({
	open,
	title,
	subtitle,
	swatch,
	size = 'md',
	autoFocusField = true,
	onClose,
	children
}: {
	open: boolean;
	title: string;
	/** Secondary text beside the title. Truncates rather than pushing the close button off. */
	subtitle?: string;
	/** Small swatch before the title, for colour-coded things like tracks. */
	swatch?: string;
	size?: 'sm' | 'md' | 'lg';
	/**
	 * Off for a dialog that edits rows which already exist, where "the first
	 * field" is a saved value rather than a blank one. See the comment on
	 * `focusFirstField`.
	 */
	autoFocusField?: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	// Points the dialog at its own visible heading, so it is announced by name
	// instead of as an anonymous dialog.
	const titleId = useId();
	// Tracks whether the press that may become a click started on the backdrop,
	// so a drag that merely *ends* outside the panel does not close it.
	const downOutside = useRef(false);

	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (open && !d.open) {
			d.showModal();
			if (autoFocusField) focusFirstField(d);
		} else if (!open && d.open) d.close();
	}, [open, autoFocusField]);

	// The page behind must not scroll with the dialog; without this you get the
	// dialog's scrollbar and the document's side by side.
	useEffect(() => (open ? lockScroll() : undefined), [open]);

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

	const width = { sm: '460px', md: '620px', lg: '860px' }[size];

	return (
		<dialog
			ref={ref}
			className="modal"
			aria-labelledby={titleId}
			style={{ ['--mw' as string]: width }}
			onCancel={(e) => {
				// Escape fires `cancel`, which closes the dialog directly and would
				// leave `open` true. Preventing it keeps React the only thing that
				// decides whether the dialog is open.
				e.preventDefault();
				onClose();
			}}
			onMouseDown={(e) => (downOutside.current = hitBackdrop(e))}
			onClick={(e) => {
				if (downOutside.current && hitBackdrop(e)) onClose();
				downOutside.current = false;
			}}
		>
			{open && (
				<>
					<div className="mhead">
						{swatch && <span className="mswatch" style={{ background: swatch }} />}
						<h2 className="mtitle" id={titleId}>
							{title}
						</h2>
						{subtitle && (
							<span className="msub" title={subtitle}>
								{subtitle}
							</span>
						)}
						<button type="button" className="mclose" aria-label="Close" onClick={onClose}>
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<path
									d="M4 4l8 8M12 4l-8 8"
									stroke="currentColor"
									strokeWidth="1.6"
									strokeLinecap="round"
								/>
							</svg>
						</button>
					</div>
					{children}
				</>
			)}
		</dialog>
	);
}
