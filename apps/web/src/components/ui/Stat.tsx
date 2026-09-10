/**
 * A headline figure with its label above it.
 *
 * It lives beside the section's "+ Add" button rather than in a band of its
 * own, so the number a section exists to answer sits on the same line as the
 * action, close to the rows that add up to it. Preparation and Expenses both
 * draw it, so the two pages cannot drift apart in size or weight.
 */
export default function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col">
			<span className="muted text-[0.8rem]">{label}</span>
			<strong className="font-serif text-2xl">{value}</strong>
		</div>
	);
}
