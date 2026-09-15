import type { ReactNode } from 'react';
import Select from './Select';
import { useNarrowLayout } from '../../hooks/useMediaQuery';
import { copy } from '../../copy';

export type SectionItem = {
	id: string;
	label: string;
	/** Optional right-aligned count. `null` renders nothing. */
	badge?: string | number | null;
};

/**
 * Section switcher for pages that hold several related panels (Preparation,
 * Expenses). Sibling of the tab strip: tabs move you between features, this
 * moves you within one.
 *
 * Below `lg` the page drops the column this sits in and the same list becomes a
 * dropdown, with the section's own action beside it: on a phone the header is
 * the scarcest thing on the page, and a control that names where you are plus
 * the one button you came to press is worth more than a row of segments that
 * names where you could go. Discover's type filter stays pills because its four
 * labels are short and it is a filter rather than a place (see docs/DESIGN.md
 * M3.5).
 *
 * The counts are left behind in the narrow form. They are a right-aligned chip
 * in the column, and folded into a dropdown's one line of text they read as
 * part of the label ("Settle up 19"); each section shows its own count once you
 * are in it.
 *
 * Both forms are rendered from one `items` array, so a caller adds a section
 * once and gets it in both.
 */
export default function SectionNav({
	items,
	value,
	onChange,
	ariaLabel = copy.ui.sectionNav.ariaLabel,
	action
}: {
	items: SectionItem[];
	value: string;
	onChange: (id: string) => void;
	ariaLabel?: string;
	/**
	 * The current section's primary button, shown beside the dropdown at narrow
	 * widths only. Wide, it stays where the page puts it, in line with whatever
	 * figures that section heads with.
	 */
	action?: ReactNode;
}) {
	const narrow = useNarrowLayout();

	if (narrow)
		return (
			<div className="flex min-w-0 items-center gap-3">
				<Select
					options={items.map((it) => ({ value: it.id, label: it.label }))}
					value={value}
					onChange={onChange}
					ariaLabel={ariaLabel}
				/>
				{action && <div className="ml-auto flex-none">{action}</div>}
			</div>
		);

	return (
		<nav className="secnav" aria-label={ariaLabel}>
			{items.map((it) => {
				const on = value === it.id;
				return (
					<button
						key={it.id}
						type="button"
						className={on ? 'sec on' : 'sec'}
						aria-current={on ? 'true' : undefined}
						onClick={() => onChange(it.id)}
					>
						<span className="lbl">{it.label}</span>
						{it.badge !== null && it.badge !== undefined && it.badge !== '' && (
							<span className="badge">{it.badge}</span>
						)}
					</button>
				);
			})}
		</nav>
	);
}
