import { useEffect, useRef, useState } from 'react';
import { useAnchor } from '../anchor';

export type Option = { value: string; label: string };

/**
 * The app's dropdown. A custom control rather than a native <select> because the
 * menu has to be styled to match, and because a native select's popup cannot be
 * anchored the way `useAnchor` does inside a scrolling modal body.
 *
 * Everything a native select gives away for free has to be put back by hand:
 * the roles below are what make it a listbox to a screen reader.
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
	const rootRef = useRef<HTMLDivElement>(null);
	const { triggerRef, menuRef } = useAnchor<HTMLButtonElement, HTMLUListElement>(open);

	const selected = options.find((o) => o.value === value) ?? null;

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

	return (
		<div ref={rootRef} className={compact ? 'sel compact' : 'sel'}>
			<button
				ref={triggerRef}
				type="button"
				className="seltrigger"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={ariaLabel}
				onClick={(e) => {
					// The window listener above would otherwise see this same click.
					e.stopPropagation();
					setOpen((v) => !v);
				}}
				onKeyDown={(e) => {
					if (e.key === 'Escape') setOpen(false);
				}}
			>
				<span className={selected ? 'sellabel' : 'sellabel placeholder'}>
					{selected?.label ?? placeholder}
				</span>
				<span className="selcaret">▾</span>
			</button>

			{open && (
				<ul ref={menuRef} className="selmenu" role="listbox" tabIndex={-1}>
					{options.map((o) => (
						<li key={o.value}>
							<button
								type="button"
								role="option"
								aria-selected={o.value === value}
								className={o.value === value ? 'selopt on' : 'selopt'}
								onClick={() => {
									onChange(o.value);
									setOpen(false);
								}}
							>
								<span className="selopttext">{o.label}</span>
								{o.value === value && <span className="selcheck">✓</span>}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
