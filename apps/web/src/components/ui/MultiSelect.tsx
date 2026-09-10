import type { Option } from './Select';
import { CaretIcon, CheckIcon } from './icons';
import { useListbox } from './useListbox';
import { copy } from '../../copy';

/**
 * The multi-pick sibling of `Select`, used wherever a field means "these people"
 * rather than "this one thing".
 *
 * It stays open while you tick, because picking four people out of twenty is the
 * normal case and a menu that closed on every choice would make that four
 * round-trips through the trigger. Everything else, including the keyboard and
 * the listbox roles, comes from `useListbox` and so cannot drift away from
 * `Select`.
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
	function toggle(v: string) {
		onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
	}

	const list = useListbox({
		count: options.length,
		// Each opening starts at the top; there is no single "current" pick here to
		// start from the way there is in Select.
		initialIndex: () => 0,
		onPick: (i) => {
			const o = options[i];
			if (o) toggle(o.value);
		}
	});

	const chosen = options.filter((o) => selected.includes(o.value));
	// Past two names the list is longer than the trigger, so switch to a count.
	const summary =
		summaryOverride ??
		(chosen.length === 0
			? placeholder
			: chosen.length <= 2
				? chosen.map((o) => o.label).join(', ')
				: summaryLabel(chosen.length));

	return (
		<div
			{...list.rootProps}
			className={['msel', compact ? 'compact' : '', quiet ? 'quiet' : ''].filter(Boolean).join(' ')}
		>
			<button {...list.triggerProps} className="mtrigger" aria-label={ariaLabel}>
				{/* An overridden summary is a sentence about the menu, not the absence
				    of a pick, so it keeps the normal ink at zero selected. */}
				<span className={chosen.length === 0 && !summaryOverride ? 'mlabel placeholder' : 'mlabel'}>
					{summary}
				</span>
				<span className="mcaret">
					<CaretIcon />
				</span>
			</button>

			{list.open && (
				<ul
					ref={list.menuRef}
					id={list.menuId}
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
							id={list.optionId(i)}
							data-index={i}
							role="option"
							aria-selected={selected.includes(o.value)}
							className={i === list.active ? 'mopt active' : 'mopt'}
							onMouseEnter={() => list.setActiveIndex(i)}
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
