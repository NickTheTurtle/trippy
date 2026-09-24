import SearchPicker from './SearchPicker';

/** How a zone reads: `America/New_York` as "America/New York". */
export const zoneLabel = (tz: string) => tz.replace(/_/g, ' ');

/**
 * Zones matching what was typed. Spaces and underscores are the same thing
 * here, since the label shows one and the name holds the other, and a zone
 * whose city starts with the query comes before one that merely contains it:
 * "par" is Paris before it is Asia/Paramaribo's neighbours.
 */
function searchZones(zones: readonly string[], query: string): string[] {
	const q = query.trim().toLowerCase().replace(/_/g, ' ');
	if (!q) return [...zones];
	const hits = zones.filter((z) => zoneLabel(z).toLowerCase().includes(q));
	const city = (z: string) => zoneLabel(z.slice(z.lastIndexOf('/') + 1)).toLowerCase();
	return hits.sort((a, b) => Number(!city(a).startsWith(q)) - Number(!city(b).startsWith(q)));
}

/**
 * An IANA time zone, chosen by typing. The list is some four hundred names
 * long, which is past what anyone can scroll to, so this is `SearchPicker`
 * rather than a `Select`.
 */
export default function TimeZonePicker({
	zones,
	value,
	onChange,
	label,
	ariaLabel,
	noMatches
}: {
	zones: readonly string[];
	value: string;
	onChange: (tz: string) => void;
	label: string;
	ariaLabel?: string;
	noMatches: string;
}) {
	return (
		<SearchPicker
			options={zones}
			value={value}
			onChange={onChange}
			search={searchZones}
			display={zoneLabel}
			renderItem={(tz) => <span className="block truncate">{zoneLabel(tz)}</span>}
			noMatches={noMatches}
			label={label}
			ariaLabel={ariaLabel}
		/>
	);
}
