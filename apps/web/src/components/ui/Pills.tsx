import type { ReactNode } from 'react';

export type PillItem<T extends string> = { value: T; label: ReactNode };

/**
 * A joined row of segments, one of which is on.
 *
 * The app's answer to "which of these few views am I looking at", and the
 * schedule's Day / 3-day / People switch is the original. It moved out of
 * `schedule.css` when Discover's type filter needed the same thing on a phone,
 * because a third hand-rolled pill row would have been the third *different*
 * pill row: the expense dialog's split control already looks nothing like the
 * schedule's.
 *
 * Buttons, not links, so it works for a filter held in state as well as one
 * held in the URL. The schedule keeps its own `<Link>`s, since its view is
 * addressable and a link is what makes it so, and shares the styling only.
 *
 * For a handful of short labels. Past about four it wraps, and past that the
 * choice wants a `Select`.
 */
export default function Pills<T extends string>({
	items,
	value,
	onChange,
	ariaLabel
}: {
	items: readonly PillItem<T>[];
	value: T;
	onChange: (value: T) => void;
	ariaLabel: string;
}) {
	return (
		<div className="pills" role="group" aria-label={ariaLabel}>
			{items.map((it) => {
				const on = it.value === value;
				return (
					<button
						key={it.value}
						type="button"
						className={on ? 'pill on' : 'pill'}
						aria-pressed={on}
						onClick={() => onChange(it.value)}
					>
						{it.label}
					</button>
				);
			})}
		</div>
	);
}
