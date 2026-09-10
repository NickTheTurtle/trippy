import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useAnchor } from '../../lib/anchor';

/**
 * Everything `Select` and `MultiSelect` do that is not about how many things you
 * may pick.
 *
 * The two were written apart and had ended up byte-for-byte identical across
 * roughly seventy lines: the open flag, the highlighted index and its mirroring
 * ref, the outside-click listener, the scroll-into-view effect, the arrow / Home
 * / End / Escape / Enter handling, the blur-out-of-the-control check, and the
 * five ARIA attributes that make a button plus a list read as a listbox. Two
 * copies of that only ever drift, and they drift on the parts nobody re-tests:
 * whether Escape also closes the dialog behind the menu, whether tabbing away
 * leaves the menu hanging over the page.
 *
 * What the two genuinely disagree about is the pick, so that is the parameter:
 * `Select` writes the value and closes, `MultiSelect` toggles and stays open
 * because choosing four people out of twenty should not be four round trips
 * through the trigger. Where the highlight starts differs for the same reason,
 * so it is a parameter too.
 *
 * `SearchDropdown` is deliberately not built on this. It is a combobox, not a
 * listbox: the trigger is a text input, the caller owns `open`, the rows can be
 * unpickable and the highlight has to survive the result set changing under it.
 * Those differences are the whole component, and folding it in here would mean
 * a hook that is mostly branches.
 */
export function useListbox({
	count,
	initialIndex,
	onPick
}: {
	count: number;
	/** Where the highlight lands each time the menu opens. */
	initialIndex: () => number;
	/** Enter, Space, or a click on a row. Closing, if wanted, is the caller's. */
	onPick: (index: number) => void;
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

	// Held in a ref so the open effect below does not depend on them. Callers
	// build these inline, so a dependency would re-run on every parent render and
	// undo the arrow key the user just pressed.
	const cb = useRef({ initialIndex, onPick, count });
	cb.current = { initialIndex, onPick, count };

	function close() {
		setOpen(false);
		triggerRef.current?.focus();
	}

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

	useEffect(() => {
		if (!open) return;
		setActiveIndex(cb.current.initialIndex());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// The highlighted row is not focused, so nothing scrolls it into view for us.
	useEffect(() => {
		if (!open) return;
		menuRef.current
			?.querySelector(`[data-index="${active}"]`)
			?.scrollIntoView({ block: 'nearest' });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, active]);

	function move(to: number) {
		if (cb.current.count === 0) return;
		setActiveIndex(Math.max(0, Math.min(cb.current.count - 1, to)));
	}

	function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
		// Escape belongs to the open menu. Without stopping it here the key
		// keeps bubbling and closes the surrounding <dialog> as well.
		if (e.key === 'Escape' && open) {
			// stopPropagation is not enough: the browser closes a <dialog> as the
			// default action of the Escape keydown, so it must be prevented too.
			e.preventDefault();
			e.stopPropagation();
			close();
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
			move(cb.current.count - 1);
		} else if (e.key === 'Enter' || e.key === ' ') {
			// The trigger is a <button>, so leaving these alone would also fire a
			// click and toggle the menu shut under the choice.
			e.preventDefault();
			cb.current.onPick(activeRef.current);
		}
	}

	return {
		open,
		setOpen,
		close,
		active,
		setActiveIndex,
		menuRef,
		menuId: `${baseId}-menu`,
		optionId,
		/** Spread on the wrapping div: the key handling and the tab-away close. */
		rootProps: {
			ref: rootRef,
			onKeyDown,
			// Tabbing away has to close the menu too, otherwise it is left hanging
			// over the page with no way back to it. Focus moving within the control
			// is not leaving, hence the containment check.
			onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
				if (!open) return;
				const next = e.relatedTarget as Node | null;
				if (next && rootRef.current?.contains(next)) return;
				setOpen(false);
			}
		},
		/** Spread on the trigger button, after its own className and aria-label. */
		triggerProps: {
			ref: triggerRef,
			type: 'button' as const,
			'aria-haspopup': 'listbox' as const,
			'aria-expanded': open,
			'aria-controls': open ? `${baseId}-menu` : undefined,
			'aria-activedescendant': open && active < count ? optionId(active) : undefined,
			onClick: (e: React.MouseEvent) => {
				// The window listener above would otherwise see this same click.
				e.stopPropagation();
				setOpen((v) => !v);
			}
		}
	};
}
