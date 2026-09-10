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
 */
export default function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col">
			<span className="muted text-[0.72rem] leading-none">{label}</span>
			<strong className="font-serif text-xl leading-[1.15]">{value}</strong>
		</div>
	);
}
