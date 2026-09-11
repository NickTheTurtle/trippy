import MultiSelect from '../../components/ui/MultiSelect';
import { FieldShell } from '../../components/ui/Field';
import type { Option } from '../../components/ui/Select';
import type { Crew } from './types';

/**
 * Who is on an event, plus the crews as one-click shortcuts.
 *
 * The people are the whole of splitting and rejoining: two events at the same
 * time with different people is a split, and nothing else declares one. A crew
 * is only a saved selection, so picking one writes its members into the field
 * and then has no further say; the event remembers people, never a crew.
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
				placeholder="Everyone"
				ariaLabel="Who is on this event"
			/>
			{crews.length > 0 && (
				<span className="crewchips">
					{crews.map((c) => (
						<button
							key={c.id}
							type="button"
							className="tchip"
							style={{ ['--c' as string]: c.color }}
							onClick={() => onChange([...c.members])}
						>
							{c.name}
						</button>
					))}
				</span>
			)}
		</FieldShell>
	);
}
