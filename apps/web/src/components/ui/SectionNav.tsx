export type SectionItem = {
	id: string;
	label: string;
	/** Optional right-aligned count. `null` renders nothing. */
	badge?: string | number | null;
};

/**
 * Vertical section switcher for pages that hold several related panels
 * (Preparation, Expenses). Sibling of the tab strip: tabs move you between
 * features, this moves you within one.
 *
 * Collapses to a horizontal scroller on narrow screens so it never eats the
 * content column.
 */
export default function SectionNav({
	items,
	value,
	onChange,
	ariaLabel = 'Sections'
}: {
	items: SectionItem[];
	value: string;
	onChange: (id: string) => void;
	ariaLabel?: string;
}) {
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
