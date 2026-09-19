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
 * "Everyone" rather than naming anybody. That is the stored form and it stays
 * the stored form: an empty list still means everyone the moment somebody
 * joins, where a frozen list of today's ids would quietly leave them out.
 *
 * Storing it that way is not a reason to show it that way. Empty ticks nothing,
 * which reads as nobody rather than as everybody, and ticking the last name
 * normalizes back to empty and appeared to clear the lot. So everyone is
 * displayed as every name ticked and stored as nothing, with this component the
 * only place the two forms meet: unticking one name writes the rest out
 * explicitly, and reticking it empties the field again.
 *
 * Unticking the *last* name is a third thing, and the field now holds it. It
 * used to be bounced: the pick asked for was the pick already on screen, so the
 * ticks came straight back and the refusal had to be narrated in the menu and
 * under the field, which is two lines of apology attached to a click that did
 * nothing. Emptying the field is a reasonable thing to do on the way to picking
 * somebody else, so it is allowed and the field reads "Nobody". What is refused
 * is saving it, which the dialog does with the toast every other refused save
 * uses. That keeps the field quiet while it is being edited and puts the answer
 * where the reader looks when they actually ask for one.
 *
 * `null` is what that state is: the organiser emptied the field. It is not `[]`,
 * because `[]` is how everyone is stored, and the two have to stay apart for
 * the whole distance between this field and the save.
 */

export default function PeoplePicker({
	people,
	onChange,
	memberOptions,
	crews,
	className = ''
}: {
	/** The event's people: `[]` is everyone, `null` is an emptied field. */
	people: string[] | null;
	onChange: (next: string[] | null) => void;
	memberOptions: Option[];
	crews: Crew[];
	className?: string;
}) {
	const ids = memberOptions.map((o) => o.value);
	// Only people the trip still has can be ticked, so a name that has left is
	// dropped here and written out on the next edit. Keeping it would also put
	// "everyone" out of reach, since the count could never match the roster.
	const named = people?.filter((id) => ids.includes(id)) ?? [];
	// Naming nobody who is still here is the empty field by another route, and
	// means the same thing.
	const everyone = people !== null && (named.length === 0 || named.length === ids.length);
	return (
		<FieldShell label="Participants" className={className}>
			<MultiSelect
				selected={everyone ? ids : named}
				onChange={(next) => {
					const known = next.filter((id) => ids.includes(id));
					// Everyone is checked first, so a trip whose roster is empty lands
					// there rather than on an emptied field it could never fill.
					if (known.length === ids.length) return onChange([]);
					onChange(known.length === 0 ? null : known);
				}}
				options={memberOptions}
				groups={crewGroups(crews)}
				summary={everyone ? 'Everyone' : undefined}
				placeholder="Nobody"
				ariaLabel="Participants"
			/>
		</FieldShell>
	);
}
