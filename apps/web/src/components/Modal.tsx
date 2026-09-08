import { useEffect, useRef, type ReactNode } from 'react';
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
	// Tracks whether the press that may become a click started on the backdrop,
	// so a drag that merely *ends* outside the panel does not close it.
	const downOutside = useRef(false);

	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (open && !d.open) d.showModal();
		else if (!open && d.open) d.close();
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
						<h2 className="mtitle">{title}</h2>
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
