import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import { lockScroll } from '../../lib/scroll-lock';
import FormError from './FormError';
import { copy } from '../../copy';

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
 * Every dialog in the app wants this, so there is no opt-out. There used to be
 * one, for a dialog whose first field was a saved arrival date and where a
 * stray keystroke would have edited real data. That dialog is now the add-city
 * search, whose one field is blank and is the whole reason it opened.
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
	// What had focus when the dialog opened. <dialog> restores focus itself, but
	// only when `close()` actually runs on a connected element. Most callers
	// render this component as `{editing && <Modal/>}`, so React unmounts the
	// whole dialog before the close effect can fire and the native restore never
	// happens: focus falls to <body> and a keyboard user is dropped at the top of
	// the page. Remembering the trigger here covers both shapes.
	const opener = useRef<HTMLElement | null>(null);

	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (open && !d.open) {
			opener.current = document.activeElement as HTMLElement | null;
			d.showModal();
			focusFirstField(d);
		} else if (!open && d.open) d.close();
	}, [open]);

	// Closing on unmount is what makes the focus restore below possible at all.
	// A modal <dialog> makes the rest of the document inert, and React unmounts
	// this component without ever calling close(), so the page would be left
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
		return () => {
			const trigger = opener.current;
			opener.current = null;
			if (!trigger) return;
			queueMicrotask(() => {
				if (trigger.isConnected) trigger.focus();
			});
		};
	}, [open]);

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
						<button
							type="button"
							className="mclose"
							aria-label={copy.ui.modal.closeLabel}
							onClick={onClose}
						>
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

/**
 * The form every dialog wraps its body and footer in.
 *
 * It exists for `noValidate`. Ten of the eleven dialog forms had left native
 * validation on, so pressing the primary button with a required field empty
 * produced the browser's own bubble: the OS voice ("Please fill out this
 * field."), the OS styling, anchored to the input, gone again on its own. The
 * eleventh, the trip dialog, switched it off on purpose and let the server
 * answer, so its message arrived in the footer in the app's voice ("Pick a
 * start date."). One kind of mistake was therefore reported two entirely
 * different ways depending on which dialog the user happened to be in.
 *
 * Every route validates what it writes and words the refusal to the rules in
 * DESIGN.md, so turning the browser off everywhere costs a round trip and buys
 * one voice, in one place, saying the same kind of sentence. The inputs keep
 * their `required`, which is what assistive technology reads; `noValidate`
 * suppresses only the browser's own UI.
 *
 * Being a component rather than a prop on each form is the point: the next
 * dialog cannot forget.
 */
export function ModalForm({
	onSubmit,
	className = '',
	children
}: {
	onSubmit: (e: FormEvent) => void;
	className?: string;
	children: ReactNode;
}) {
	return (
		<form className={`mform ${className}`.trim()} noValidate onSubmit={onSubmit}>
			{children}
		</form>
	);
}

/**
 * The row of buttons every dialog ends with.
 *
 * Seven dialogs had written out the same footer: the failure message, a Cancel
 * that closes, and a primary button that swaps its label while the request is
 * in flight. They had already drifted (one omitted the message, one disabled
 * the wrong button), which is the usual fate of a shape copied by hand.
 *
 * The primary button submits the surrounding form. `onSubmit` is for the one
 * dialog whose body is not a <form>, and turns it into a plain button.
 */
export function ModalFooter({
	error,
	onClose,
	submitLabel,
	busyLabel,
	busy = false,
	disabled = false,
	onSubmit,
	start
}: {
	error?: ReactNode;
	onClose: () => void;
	submitLabel: string;
	/** What the primary button reads while the request is in flight. */
	busyLabel: string;
	busy?: boolean;
	/** Refuses the submit for a reason of the form's own, beyond being busy. */
	disabled?: boolean;
	onSubmit?: () => void;
	/** Anything pinned to the left of the row, such as a delete. */
	start?: ReactNode;
}) {
	return (
		<div className="mfoot">
			{start && <div className="mr-auto">{start}</div>}
			<FormError message={error} />
			<button className="btn" type="button" onClick={onClose}>
				{copy.common.cancel}
			</button>
			<button
				className="btn primary"
				type={onSubmit ? 'button' : 'submit'}
				disabled={busy || disabled}
				onClick={onSubmit}
			>
				{busy ? busyLabel : submitLabel}
			</button>
		</div>
	);
}
