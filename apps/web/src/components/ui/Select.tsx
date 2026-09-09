import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useAnchor } from '../../lib/anchor';

export type Option = { value: string; label: string };

/**
 * The app's dropdown. A custom control rather than a native <select> because the
 * menu has to be styled to match, and because a native select's popup cannot be
 * anchored the way `useAnchor` does inside a scrolling modal body.
 *
 * Everything a native select gives away for free has to be put back by hand:
 * the roles below are what make it a listbox to a screen reader, focus stays on
 * the trigger throughout, and the highlighted row is published through
 * aria-activedescendant, which is the pattern a listbox is expected to follow.
 */
export default function Select({
	options,
	value,
	onChange,
	placeholder = 'Select...',
	ariaLabel = 'Select',
	compact = false
}: {
	options: Option[];
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	ariaLabel?: string;
	compact?: boolean;
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

	const selected = options.find((o) => o.value === value) ?? null;
	// Read by the open effect below. Callers commonly build `options` inline, so
	// depending on it there would reset the highlight on every parent render and
	// undo the arrow key the user just pressed.
	const currentRef = useRef({ options, value });
	currentRef.current = { options, value };

	// A click anywhere outside closes. Registered on the window rather than a
	// backdrop so the click still reaches whatever it landed on.
	useEffect(() => {
		if (!open) return;
		const onClick = (e: MouseEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
		};
		window.addEventListener('click', onClick);
		return () => window.removeEventListener('click', onClick);
	}, [open]);

	// Opening lands on the current value, so the first arrow press moves from
	// where the user already is rather than from the top of the list.
	useEffect(() => {
		if (!open) return;
		const { options: opts, value: v } = currentRef.current;
		const i = opts.findIndex((o) => o.value === v);
		setActiveIndex(i < 0 ? 0 : i);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// The highlighted row is not focused, so nothing scrolls it into view for us.
	useEffect(() => {
		if (!open) return;
		const el = menuRef.current?.querySelector(`[data-index="${active}"]`);
		el?.scrollIntoView({ block: 'nearest' });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, active]);

	function choose(i: number) {
		const o = options[i];
		if (!o) return;
		onChange(o.value);
		setOpen(false);
		triggerRef.current?.focus();
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
			// click and toggle the menu shut underneath the choice.
			e.preventDefault();
			choose(activeRef.current);
		}
	}

	return (
		<div
			ref={rootRef}
			className={compact ? 'sel compact' : 'sel'}
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
				className="seltrigger"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={ariaLabel}
				aria-controls={open ? `${baseId}-menu` : undefined}
				aria-activedescendant={open && options[active] ? optionId(active) : undefined}
				onClick={(e) => {
					// The window listener above would otherwise see this same click.
					e.stopPropagation();
					setOpen((v) => !v);
				}}
			>
				<span className={selected ? 'sellabel' : 'sellabel placeholder'}>
					{selected?.label ?? placeholder}
				</span>
				<span className="selcaret">▾</span>
			</button>

			{open && (
				<ul
					ref={menuRef}
					id={`${baseId}-menu`}
					className="selmenu"
					role="listbox"
					tabIndex={-1}
					// Keeps the press from pulling focus off the trigger, which is what
					// makes aria-activedescendant work and stops the blur handler above
					// from firing on an ordinary pick.
					onMouseDown={(e) => e.preventDefault()}
				>
					{options.map((o, i) => (
						<li
							key={o.value}
							id={optionId(i)}
							data-index={i}
							role="option"
							aria-selected={o.value === value}
							className={['selopt', o.value === value ? 'on' : '', i === active ? 'active' : '']
								.filter(Boolean)
								.join(' ')}
							onMouseEnter={() => setActiveIndex(i)}
							onClick={(e) => {
								// These rows are not form controls, so a Select sitting inside a
								// <label> would have the label forward this click on to its
								// labelled control, which is the trigger, reopening the menu the
								// pick just closed. Cancelling the default action stops that.
								e.preventDefault();
								choose(i);
							}}
						>
							<span className="selopttext">{o.label}</span>
							{o.value === value && <span className="selcheck">✓</span>}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
