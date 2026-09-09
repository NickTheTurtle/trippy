import { useEffect, useRef, useState } from 'react';
import { useAnchor } from '../anchor';
import type { Option } from './Select';

/**
 * The multi-pick sibling of `Select`, used wherever a field means "these people"
 * rather than "this one thing".
 *
 * It stays open while you tick, because picking four people out of twenty is the
 * normal case and a menu that closed on every choice would make that four
 * round-trips through the trigger.
 */
export default function MultiSelect({
	options,
	selected,
	onChange,
	placeholder = 'Anyone',
	ariaLabel = 'Assign people',
	compact = false
}: {
	options: Option[];
	selected: string[];
	onChange: (next: string[]) => void;
	placeholder?: string;
	ariaLabel?: string;
	compact?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const { triggerRef, menuRef } = useAnchor<HTMLButtonElement, HTMLUListElement>(open);

	const chosen = options.filter((o) => selected.includes(o.value));
	// Past two names the list is longer than the trigger, so switch to a count.
	const summary =
		chosen.length === 0
			? placeholder
			: chosen.length <= 2
				? chosen.map((o) => o.label).join(', ')
				: `${chosen.length} people`;

	useEffect(() => {
		if (!open) return;
		const onClick = (e: MouseEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
		};
		window.addEventListener('click', onClick);
		return () => window.removeEventListener('click', onClick);
	}, [open]);

	function toggle(v: string) {
		onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
	}

	return (
		<div
			ref={rootRef}
			className={compact ? 'msel compact' : 'msel'}
			onKeyDown={(e) => {
				// Escape belongs to the open menu. Without stopping it here the key
				// keeps bubbling and closes the surrounding <dialog> as well.
				if (e.key === 'Escape' && open) {
					// stopPropagation is not enough: the browser closes a <dialog> as the
					// default action of the Escape keydown, so it must be prevented too.
					e.preventDefault();
					e.stopPropagation();
					setOpen(false);
					triggerRef.current?.focus();
				}
			}}
		>
			<button
				ref={triggerRef}
				type="button"
				className="mtrigger"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={ariaLabel}
				onClick={(e) => {
					e.stopPropagation();
					setOpen((v) => !v);
				}}
			>
				<span className={chosen.length === 0 ? 'mlabel placeholder' : 'mlabel'}>{summary}</span>
				<span className="mcaret">▾</span>
			</button>

			{open && (
				<ul ref={menuRef} className="mmenu" role="listbox" aria-multiselectable tabIndex={-1}>
					{options.map((o) => (
						<li key={o.value}>
							<button
								type="button"
								role="option"
								aria-selected={selected.includes(o.value)}
								className="mopt"
								onClick={() => toggle(o.value)}
							>
								<span className={selected.includes(o.value) ? 'mbox on' : 'mbox'}>
									{selected.includes(o.value) ? '✓' : ''}
								</span>
								<span className="mopttext">{o.label}</span>
							</button>
						</li>
					))}
					{options.length === 0 && <li className="mempty">No members yet</li>}
				</ul>
			)}
		</div>
	);
}
