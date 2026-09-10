import Select from './Select';
import { copy } from '../../copy';

const c = copy.viewAs;

/**
 * What a total belongs to, once the list is being read as one person. The app
 * speaks to the reader in the second person everywhere else, so their own share
 * says "Your share" rather than repeating their name back at them.
 */
export const shareLabel = (members: { id: string; name: string }[], id: string, me: string) =>
	id === me ? c.yourShare : c.share(members.find((m) => m.id === id)?.name ?? '');

/**
 * "View as": read a money list as one member rather than as the whole trip.
 *
 * It sits on the list it changes, not in the page header, because what it
 * changes is what the rows say. Estimated costs and the expense ledger both use
 * it, and both answer the same question with it: the totals a group keeps are
 * the group's, and the number a person actually wants is their own.
 */
export default function ViewAsBar({
	members,
	me,
	value,
	onChange
}: {
	members: { id: string; name: string }[];
	me: string;
	/** A member id, or '' for the whole trip. */
	value: string;
	onChange: (value: string) => void;
}) {
	// On a solo trip the only person to read the list as is you, and the control
	// would be a dropdown with one entry that changes nothing.
	if (members.length < 2) return null;

	return (
		<div className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-3">
			<span className="muted text-meta">{c.label}</span>
			<div className="w-44">
				<Select
					compact
					options={[
						{ value: '', label: c.everyone },
						...members.map((m) => ({
							value: m.id,
							label: m.name + (m.id === me ? copy.preparation.youSuffix : '')
						}))
					]}
					value={value}
					onChange={onChange}
					ariaLabel={c.label}
				/>
			</div>
		</div>
	);
}
