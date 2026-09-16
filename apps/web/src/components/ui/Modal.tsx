import { useId, type FormEvent, type ReactNode } from 'react';
import { useDialog } from './useDialog';
import { DialogError } from './Toast';
import { copy } from '../../copy';

/**
 * The one dialog used across the app.
 *
 * Built on the native <dialog> element via showModal(). That plumbing, and the
 * reasons for each part of it, live in `useDialog`. What is local here is the
 * header, the width and where the caret lands when it opens.
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
	dock = 'right',
	peek = false,
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
	 * Which edge a peeking panel stands at. Only read when `peek` is set: a
	 * dialog that dims the page has no reason to stand aside, and one that
	 * wandered to an edge only made the app look like it could not decide where
	 * its dialogs live.
	 */
	dock?: 'left' | 'right';
	/**
	 * Leave the page undimmed, scrollable and legible behind the panel, and take
	 * a narrower one docked to one side to keep it that way. For a dialog whose
	 * edits are drawn live on the page: dimming or covering them would defeat the
	 * point. Off by default, because an ordinary dialog wants the page held still
	 * while it is open, and then the middle of the screen is where a reader
	 * already expects to find it.
	 */
	peek?: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	// Points the dialog at its own visible heading, so it is announced by name
	// instead of as an anonymous dialog.
	const titleId = useId();
	const { ref, dialogProps } = useDialog({
		open,
		onClose,
		onOpened: focusFirstField,
		lockPage: !peek
	});

	const width = { sm: '460px', md: '620px', lg: '860px' }[size];

	return (
		<dialog
			ref={ref}
			className={`modal${peek ? ` peek docked ${dock}` : ''}`}
			aria-labelledby={titleId}
			style={{ ['--mw' as string]: width }}
			{...dialogProps}
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
	/**
	 * The failed save, announced in the corner rather than drawn here. It used
	 * to be a line between the `start` slot and Cancel, which put the reason for
	 * the failure in the one part of a tall dialog the reader may have scrolled
	 * away from, and made the footer reflow under the buttons as they went to
	 * press one. Held by the caller, usually `useMutation.error`, so it is
	 * retracted the moment the next attempt starts or the dialog closes.
	 */
	error?: string;
	onClose: () => void;
	/**
	 * Omitted for a dialog with nothing to save, which is a dialog that only
	 * shows a thing and offers to delete it. Cancel becomes the way out and the
	 * primary button is not drawn, rather than being drawn inert.
	 */
	submitLabel?: string;
	/** What the primary button reads while the request is in flight. */
	busyLabel?: string;
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
			<DialogError message={error ?? ''} />
			<button className="btn" type="button" onClick={onClose}>
				{submitLabel ? copy.common.cancel : copy.ui.modal.closeLabel}
			</button>
			{submitLabel && (
				<button
					className="btn primary"
					type={onSubmit ? 'button' : 'submit'}
					disabled={busy || disabled}
					onClick={onSubmit}
				>
					{busy ? (busyLabel ?? copy.common.working) : submitLabel}
				</button>
			)}
		</div>
	);
}
