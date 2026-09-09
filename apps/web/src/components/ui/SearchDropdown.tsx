import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useAnchor } from '../../lib/anchor';
import { FieldShell } from './Field';

/**
 * A labelled search box whose results hang off it as an overlay.
 *
 * Both searches in the app (the city geocoder in the itinerary editor and the
 * place/stay lookup in Discover's add popup) used to render their results as an
 * ordinary list in flow under the input, so every keystroke that returned hits
 * shoved the rest of the form down the dialog and the row you were reaching for
 * was somewhere else by the time you got there. The results are a transient
 * overlay, not part of the form, so they are drawn over what follows and the
 * layout below the input never moves.
 *
 * One component rather than one per caller: they are the same interaction, and
 * two copies of a dropdown drift apart on exactly the details (Escape, blur,
 * the roles) that are easiest to get wrong once and never notice.
 *
 * Positioning is `useAnchor`, the same fixed-position anchoring Select and
 * MultiSelect use, for the reason written there: `.mbody` is the dialog's one
 * scrolling region, so a menu positioned inside it is clipped by that overflow
 * as soon as the list is long or the input is near the bottom of a short
 * window. A fixed element escapes ancestor overflow, still paints in the top
 * layer because it lives inside an open `<dialog>`, and `useAnchor` caps its
 * height to the room actually available and flips it above the input when
 * there is more room there. The z-index is 40, the value the other two menus
 * already share.
 *
 * The caller keeps the query, the results and the searching flag, since those
 * are its own request's business. This owns the popup: what is highlighted,
 * when it is open, and the roles that make it a combobox.
 */
export default function SearchDropdown<T>({
	label,
	hint,
	placeholder,
	ariaLabel,
	autoFocus = false,
	required = false,
	className = '',
	value,
	onChange,
	open,
	onOpenChange,
	busy = false,
	items,
	itemKey,
	renderItem,
	onPick,
	empty,
	footer
}: {
	label: ReactNode;
	hint?: string;
	placeholder?: string;
	/** Set when the visible label is not the whole story for a screen reader. */
	ariaLabel?: string;
	autoFocus?: boolean;
	required?: boolean;
	className?: string;
	/** The query. Owned by the caller, which debounces and searches on it. */
	value: string;
	onChange: (value: string) => void;
	/**
	 * Controlled, because a caller can have its own reasons to close the popup:
	 * Discover's add popup drops it when the type switches between places and
	 * stays, which throws the results away with it.
	 */
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Drives the indeterminate line across the input's lower edge. */
	busy?: boolean;
	items: T[];
	itemKey: (item: T) => string;
	renderItem: (item: T) => ReactNode;
	onPick: (item: T) => void;
	/**
	 * Shown in place of the rows when there are none: "searching", "no matches",
	 * "keep typing". Pass null to keep the popup shut in that state.
	 */
	empty?: ReactNode;
	/** Provider attribution. It has to travel with the results it describes. */
	footer?: ReactNode;
}) {
	const [active, setActive] = useState(0);
	// Mirrored in a ref for the same reason Select mirrors its own: two keys in
	// one tick would both read the pre-render value and the second would undo
	// the first.
	const activeRef = useRef(0);
	const setActiveIndex = (i: number) => {
		activeRef.current = i;
		setActive(i);
	};

	const rootRef = useRef<HTMLDivElement>(null);
	const baseId = useId();
	const optionId = (i: number) => `${baseId}-opt-${i}`;

	// An empty box has nothing to hang a popup off, and a state the caller has
	// no message for is not worth an empty panel.
	const shown = open && value.trim().length > 0 && (items.length > 0 || empty != null);
	const { triggerRef, menuRef } = useAnchor<HTMLDivElement, HTMLDivElement>(shown);

	// Back to the top whenever the result set changes underneath the highlight,
	// so Enter can never pick a row that has since been replaced by another.
	const keys = items.map(itemKey).join('\u0000');
	useEffect(() => {
		setActiveIndex(0);
	}, [keys, shown]);

	// The highlighted row is not focused, so nothing scrolls it into view for us.
	useEffect(() => {
		if (!shown) return;
		menuRef.current
			?.querySelector(`[data-index="${active}"]`)
			?.scrollIntoView({ block: 'nearest' });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [shown, active]);

	// A click anywhere outside dismisses. On the window rather than a backdrop so
	// the click still reaches whatever it landed on.
	useEffect(() => {
		if (!shown) return;
		const onClick = (e: MouseEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) onOpenChange(false);
		};
		window.addEventListener('click', onClick);
		return () => window.removeEventListener('click', onClick);
	}, [shown, onOpenChange]);

	function choose(i: number) {
		const item = items[i];
		if (!item) return;
		onPick(item);
	}

	function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
		if (e.key === 'Escape' && shown) {
			// Escape belongs to the open popup, not to the dialog around it.
			// stopPropagation alone is not enough: closing a <dialog> is the
			// browser's default action for the Escape keydown, so it has to be
			// prevented as well, exactly as Select does.
			e.preventDefault();
			e.stopPropagation();
			onOpenChange(false);
			return;
		}
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			// Arrows in a text box move the caret; here they move the highlight.
			e.preventDefault();
			if (!shown) {
				onOpenChange(true);
				return;
			}
			if (items.length === 0) return;
			const next = activeRef.current + (e.key === 'ArrowDown' ? 1 : -1);
			setActiveIndex(Math.max(0, Math.min(items.length - 1, next)));
			return;
		}
		if (e.key === 'Enter' && shown && items.length > 0) {
			// Only swallowed when there is something to pick, so Enter on a typed
			// name that matched nothing still submits the form it sits in.
			e.preventDefault();
			choose(activeRef.current);
		}
	}

	return (
		<div
			ref={rootRef}
			className={`sdrop ${className}`}
			onKeyDown={onKeyDown}
			// Tabbing away dismisses too, otherwise the popup is left hanging over
			// the form with no way back to it. Focus moving inside the control is
			// not leaving, hence the containment check.
			onBlur={(e) => {
				if (!open) return;
				const next = e.relatedTarget as Node | null;
				if (next && rootRef.current?.contains(next)) return;
				onOpenChange(false);
			}}
		>
			<FieldShell label={label} hint={hint}>
				<div ref={triggerRef} className="relative">
					<input
						className="input w-full"
						type="text"
						role="combobox"
						aria-expanded={shown}
						aria-controls={shown ? `${baseId}-list` : undefined}
						aria-activedescendant={shown && items[active] ? optionId(active) : undefined}
						aria-autocomplete="list"
						aria-label={ariaLabel}
						autoFocus={autoFocus}
						required={required}
						placeholder={placeholder}
						value={value}
						onChange={(e) => onChange(e.target.value)}
					/>
					{/* Overlays the input's lower edge rather than sitting under it, so
					    starting a search adds no height either. */}
					<div
						className={`progress pointer-events-none absolute right-3 bottom-px left-3 h-0.5 overflow-hidden rounded-full ${busy ? 'on' : ''}`}
						role="progressbar"
						aria-label="Searching"
						aria-busy={busy}
					>
						<span />
					</div>
				</div>
			</FieldShell>

			{shown && (
				// Outside the FieldShell's <label>: a click inside a label is
				// forwarded to its labelled control, which would put the caret back
				// in the input and reopen what the pick just closed.
				<div ref={menuRef} className="sdropmenu">
					<ul
						id={`${baseId}-list`}
						className="sdroplist"
						role="listbox"
						// Keeps the press from pulling focus out of the input, which is
						// what makes aria-activedescendant work and stops the blur above
						// from firing on an ordinary pick.
						onMouseDown={(e) => e.preventDefault()}
					>
						{items.map((item, i) => (
							<li
								key={itemKey(item)}
								id={optionId(i)}
								data-index={i}
								role="option"
								aria-selected={i === active}
								className={i === active ? 'sdropopt active' : 'sdropopt'}
								onMouseEnter={() => setActiveIndex(i)}
								onClick={() => choose(i)}
							>
								{renderItem(item)}
							</li>
						))}
					</ul>
					{/* Outside the listbox: a status line is not an option, and a
					    screen reader offered it as one would try to pick it. */}
					{items.length === 0 && <p className="sdropnote">{empty}</p>}
					{footer}
				</div>
			)}
		</div>
	);
}
