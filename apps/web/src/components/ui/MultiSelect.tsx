import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useAnchor } from '../../lib/anchor';
import type { Option } from './Select';
import { copy } from '../../copy';
import { CheckIcon } from './icons';

/**
 * The multi-pick sibling of `Select`, used wherever a field means "these people"
 * rather than "this one thing".
 *
 * It stays open while you tick, because picking four people out of twenty is the
 * normal case and a menu that closed on every choice would make that four
 * round-trips through the trigger. Keyboard support mirrors `Select`: focus
 * stays on the trigger and the highlighted row travels through
 * aria-activedescendant.
 */
export default function MultiSelect({
	options,
	selected,
	onChange,
	placeholder = copy.ui.multiSelect.placeholder,
	ariaLabel = copy.ui.multiSelect.ariaLabel,
	compact = false,
	quiet = false,
	summary: summaryOverride,
	summaryLabel = copy.ui.multiSelect.summaryLabel
}: {
	options: Option[];
	selected: string[];
	onChange: (next: string[]) => void;
	placeholder?: string;
	ariaLabel?: string;
	compact?: boolean;
	/**
	 * Borderless until hovered, opened or focused, for a menu that sits in a list
	 * row. One bordered box per row draws a column of boxes down the page and
	 * out-shouts the rows themselves.
	 */
	quiet?: boolean;
	/**
	 * Fixed trigger text, for a menu whose ticks do not mean "these are the ones
	 * I picked". The task list ticks people off a job, where a list of names
	 * would read as the roster rather than as who is finished.
	 */
	summary?: string;
	/**
	 * How the trigger reads once the picks no longer fit as names. Defaults to
	 * "N people", which is what every current call site means.
	 */
	summaryLabel?: (count: number) => string;
}) {
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	// Mirrored in a ref because two keys pressed in the same tick would otherwise
	// both read the pre-render value and the second would undo the first.
	const activeRef = useRef(0);
	const setActiveIndex = (i: number) => {
		activeRef.current = i;
		setActive(i);
	};
	const rootRef = useRef<HTMLDivElement>(null);
	const { triggerRef, menuRef } = useAnchor<HTMLButtonElement, HTMLUListElement>(open);
	const baseId = useId();
	const optionId = (i: number) => `${baseId}-opt-${i}`;

	const chosen = options.filter((o) => selected.includes(o.value));
	// Past two names the list is longer than the trigger, so switch to a count.
	const summary =
		summaryOverride ??
		(chosen.length === 0
			? placeholder
			: chosen.length <= 2
				? chosen.map((o) => o.label).join(', ')
				: summaryLabel(chosen.length));

	useEffect(() => {
		if (!open) return;
		const onClick = (e: MouseEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
		};
		window.addEventListener('click', onClick);
		return () => window.removeEventListener('click', onClick);
	}, [open]);

	// Each opening starts at the top; there is no single "current" pick here to
	// start from the way there is in Select.
	useEffect(() => {
		if (open) setActiveIndex(0);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const el = menuRef.current?.querySelector(`[data-index="${active}"]`);
		el?.scrollIntoView({ block: 'nearest' });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, active]);

	function toggle(v: string) {
		onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
	}

	function move(to: number) {
		if (options.length === 0) return;
		setActiveIndex(Math.max(0, Math.min(options.length - 1, to)));
	}

	function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
		// Escape belongs to the open menu. Without stopping it here the key
		// keeps bubbling and closes the surrounding <dialog> as well.
		if (e.key === 'Escape' && open) {
			// stopPropagation is not enough: the browser closes a <dialog> as the
			// default action of the Escape keydown, so it must be prevented too.
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
			triggerRef.current?.focus();
			return;
		}
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (!open) {
				setOpen(true);
				return;
			}
			move(activeRef.current + (e.key === 'ArrowDown' ? 1 : -1));
			return;
		}
		if (!open) return;
		if (e.key === 'Home') {
			e.preventDefault();
			move(0);
		} else if (e.key === 'End') {
			e.preventDefault();
			move(options.length - 1);
		} else if (e.key === 'Enter' || e.key === ' ') {
			// The trigger is a <button>, so leaving these alone would also fire a
			// click and toggle the menu shut on every tick.
			e.preventDefault();
			const o = options[activeRef.current];
			if (o) toggle(o.value);
		}
	}

	return (
		<div
			ref={rootRef}
			className={['msel', compact ? 'compact' : '', quiet ? 'quiet' : ''].filter(Boolean).join(' ')}
			onKeyDown={onKeyDown}
			// Tabbing away has to close the menu too, otherwise it is left hanging
			// over the page with no way back to it. Focus moving within the control
			// is not leaving, hence the containment check.
			onBlur={(e) => {
				if (!open) return;
				const next = e.relatedTarget as Node | null;
				if (next && rootRef.current?.contains(next)) return;
				setOpen(false);
			}}
		>
			<button
				ref={triggerRef}
				type="button"
				className="mtrigger"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={ariaLabel}
				aria-controls={open ? `${baseId}-menu` : undefined}
				aria-activedescendant={open && options[active] ? optionId(active) : undefined}
				onClick={(e) => {
					e.stopPropagation();
					setOpen((v) => !v);
				}}
			>
				{/* An overridden summary is a sentence about the menu, not the absence
				    of a pick, so it keeps the normal ink at zero selected. */}
				<span className={chosen.length === 0 && !summaryOverride ? 'mlabel placeholder' : 'mlabel'}>
					{summary}
				</span>
				<span className="mcaret">▾</span>
			</button>

			{open && (
				<ul
					ref={menuRef}
					id={`${baseId}-menu`}
					className="mmenu"
					role="listbox"
					aria-multiselectable
					tabIndex={-1}
					// Keeps the press from pulling focus off the trigger, which is both
					// what makes aria-activedescendant work and what lets the menu stay
					// open across several ticks.
					onMouseDown={(e) => e.preventDefault()}
				>
					{options.map((o, i) => (
						<li
							key={o.value}
							id={optionId(i)}
							data-index={i}
							role="option"
							aria-selected={selected.includes(o.value)}
							className={i === active ? 'mopt active' : 'mopt'}
							onMouseEnter={() => setActiveIndex(i)}
							onClick={(e) => {
								// These rows are not form controls, so a MultiSelect sitting
								// inside a <label> would have the label forward this click on to
								// its labelled control, which is the trigger, closing the menu on
								// every tick. Cancelling the default action stops that.
								e.preventDefault();
								toggle(o.value);
							}}
						>
							<span className={selected.includes(o.value) ? 'mbox on' : 'mbox'}>
								{selected.includes(o.value) && <CheckIcon />}
							</span>
							<span className="mopttext">{o.label}</span>
						</li>
					))}
					{options.length === 0 && <li className="mempty">{copy.ui.multiSelect.empty}</li>}
				</ul>
			)}
		</div>
	);
}
