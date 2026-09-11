/**
 * A headline figure with its label above it.
 *
 * It lives beside the section's "+ Add" button rather than in a band of its
 * own, so the number a section exists to answer sits on the same line as the
 * action, close to the rows that add up to it. Preparation and Expenses both
 * draw it, so the two pages cannot drift apart in size or weight.
 *
 * It is sized and leaded to fit inside `--spacing-phead`, the height of a
 * header row. At its old size the two stacked lines overflowed that row, so
 * the panel below it sat lower on the money section than on every other
 * section and the whole view jumped as you switched between them.
 *
 * The figure is set in the sans face with tabular figures, not in the display
 * serif the headings use. Fraunces ships no `tnum` feature at all, so its
 * digits cannot be made to share a width: `1` is two thirds of `0`. A total
 * that changes as you add expenses would shift on the line every time, two of
 * these sit side by side and have to agree, and the section total further down
 * the same page is already sans and tabular.
 */
export default function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col">
			<span className="muted text-micro leading-none">{label}</span>
			<strong className="text-heading leading-[1.15] tabular-nums">{value}</strong>
		</div>
	);
}
