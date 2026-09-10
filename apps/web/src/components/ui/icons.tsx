/**
 * The app's glyphs, as inline SVG on `currentColor`.
 *
 * Every one of these started as a text character (✎, ×, ✓, –). Those are drawn
 * by whichever font the platform has for them, so their weight and size never
 * matched the rest of a row, and some systems render them in colour as emoji.
 * Drawn here they inherit the weight of everything around them.
 *
 * `viewBox="0 0 16 16"` throughout, sized by the caller, so a set of them lines
 * up without per-icon nudging. No icon dependency was added.
 */

export function CaretIcon() {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5">
			<path
				d="M8 3.5l4.5 6h-9z"
				fill="currentColor"
				stroke="currentColor"
				strokeWidth="1.2"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** A compass rose: "open this place somewhere else", not "submit a form". */
export function CompassIcon() {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5">
			<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
			<path
				d="M10.6 5.4l-1.3 3.9-3.9 1.3 1.3-3.9z"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function TrashIcon() {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="size-4">
			<path
				d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function PlusIcon() {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5">
			<path
				d="M8 3.5v9M3.5 8h9"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
			/>
		</svg>
	);
}

/** A pencil at the usual 45 degrees: nib down at the bottom left, eraser top right. */
export function PencilIcon() {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="size-4">
			<path
				d="M10.6 2.9l2.5 2.5M3 13h2.5l7.6-7.6a1.4 1.4 0 000-2l-.5-.5a1.4 1.4 0 00-2 0L3 10.5z"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function CheckIcon() {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="size-3">
			<path
				d="M3.5 8.5l3 3 6-7"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** The half-done mark: some of a group have finished, not all. */
export function MinusIcon() {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="size-3">
			<path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		</svg>
	);
}
