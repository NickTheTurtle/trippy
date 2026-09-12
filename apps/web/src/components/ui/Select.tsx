import { Fragment, useRef } from 'react';
import { CaretIcon, CheckIcon } from './icons';
import { useListbox } from './useListbox';
import { copy } from '../../copy';

export type Option = {
	value: string;
	label: string;
	/**
	 * Heading this option sits under. Options are rendered in the order given, and
	 * a heading is drawn wherever the section changes, so grouping is the caller's
	 * to decide by sorting rather than a second structure to keep in step.
	 */
	section?: string;
};

/**
 * The app's dropdown. A custom control rather than a native <select> because the
 * menu has to be styled to match, and because a native select's popup cannot be
 * anchored the way `useAnchor` does inside a scrolling modal body.
 *
 * Everything a native select gives away for free has to be put back by hand.
 * That part lives in `useListbox`, which this shares with `MultiSelect`: the
 * roles that make it a listbox to a screen reader, focus staying on the trigger
 * throughout, and the highlighted row published through aria-activedescendant.
 * What is local here is that picking writes one value and closes.
 */
export default function Select({
	options,
	value,
	onChange,
	placeholder = copy.ui.select.placeholder,
	ariaLabel = copy.ui.select.ariaLabel,
	compact = false
}: {
	options: Option[];
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	ariaLabel?: string;
	compact?: boolean;
}) {
	// Read when the menu opens. Callers commonly build `options` inline, so
	// reading them through a ref keeps the highlight from resetting on every
	// parent render and undoing the arrow key the user just pressed.
	const currentRef = useRef({ options, value });
	currentRef.current = { options, value };

	function choose(i: number) {
		const o = currentRef.current.options[i];
		if (!o) return;
		onChange(o.value);
		list.close();
	}

	const list = useListbox({
		count: options.length,
		// Opening lands on the current value, so the first arrow press moves from
		// where the user already is rather than from the top of the list.
		initialIndex: () => {
			const { options: opts, value: v } = currentRef.current;
			const i = opts.findIndex((o) => o.value === v);
			return i < 0 ? 0 : i;
		},
		onPick: choose
	});

	const selected = options.find((o) => o.value === value) ?? null;

	return (
		<div {...list.rootProps} className={compact ? 'sel compact' : 'sel'}>
			<button {...list.triggerProps} className="seltrigger" aria-label={ariaLabel}>
				<span className={selected ? 'sellabel' : 'sellabel placeholder'}>
					{selected?.label ?? placeholder}
				</span>
				<span className="selcaret">
					<CaretIcon />
				</span>
			</button>

			{list.open && (
				<ul
					ref={list.menuRef}
					id={list.menuId}
					className="selmenu"
					role="listbox"
					tabIndex={-1}
					// Keeps the press from pulling focus off the trigger, which is what
					// makes aria-activedescendant work and stops the blur handler in the
					// hook from firing on an ordinary pick.
					onMouseDown={(e) => e.preventDefault()}
				>
					{options.map((o, i) => (
						<Fragment key={o.value}>
							{o.section && o.section !== options[i - 1]?.section && (
								<li className="selopthead" role="presentation">
									{o.section}
								</li>
							)}
							<li
								id={list.optionId(i)}
								data-index={i}
								role="option"
								aria-selected={o.value === value}
								className={[
									'selopt',
									o.value === value ? 'on' : '',
									i === list.active ? 'active' : ''
								]
									.filter(Boolean)
									.join(' ')}
								onMouseEnter={() => list.setActiveIndex(i)}
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
								{o.value === value && (
									<span className="selcheck">
										<CheckIcon />
									</span>
								)}
							</li>
						</Fragment>
					))}
				</ul>
			)}
		</div>
	);
}
