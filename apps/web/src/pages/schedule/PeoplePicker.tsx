import MultiSelect from '../../components/ui/MultiSelect';
import { FieldShell } from '../../components/ui/Field';
import { crewGroups } from '../../lib/people';
import type { Option } from '../../components/ui/Select';
import type { Crew } from './types';

/**
 * Who is on an event, with the crews offered above the people.
 *
 * The people are the whole of splitting and rejoining: two events at the same
 * time with different people is a split, and nothing else declares one. A crew
 * is only a saved selection, so picking one ticks its members and then has no
 * further say; the event remembers people, never a crew.
 *
 * The crews used to sit under the field as chips that replaced the selection
 * outright. In the menu they add and remove instead, which is what every other
 * row in it does, and two crews can be combined without the second wiping the
 * first.
 *
 * Leaving the field empty means the whole group, which is why the trigger reads
 * "Everyone" rather than naming anybody.
 */
export default function PeoplePicker({
	people,
	onChange,
	memberOptions,
	crews,
	className = ''
}: {
	people: string[];
	onChange: (next: string[]) => void;
	memberOptions: Option[];
	crews: Crew[];
	className?: string;
}) {
	return (
		<FieldShell label="Who" className={className}>
			<MultiSelect
				selected={people}
				onChange={onChange}
				options={memberOptions}
				groups={crewGroups(crews)}
				placeholder="Everyone"
				ariaLabel="Who is on this event"
			/>
		</FieldShell>
	);
}
