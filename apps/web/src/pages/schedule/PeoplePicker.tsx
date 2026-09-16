import { useState } from 'react';
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
 * The one gesture that has no answer is asking for nobody. Untick the last
 * name, or untick a crew that happens to cover the whole trip, and the ticks
 * come straight back, because an empty pick is how everyone is stored: the two
 * are the same record and the store has no third one to write. Clicking a crew
 * called "Everyone" and watching nothing happen is the shape that reaches a
 * reader, so the refusal is now said out loud: at the top of the open menu,
 * where the click was, and under the field once the menu closes. The field's
 * own hint is not enough on its own, because the open menu is fixed and covers
 * the line under the field.
 */
const NOBODY_HINT = 'An event with no names on it means everyone, so this cannot be emptied';

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
	const ids = memberOptions.map((o) => o.value);
	// Only people the trip still has can be ticked, so a name that has left is
	// dropped here and written out on the next edit. Keeping it would also put
	// "everyone" out of reach, since the count could never match the roster.
	const named = people.filter((id) => ids.includes(id));
	// Naming nobody who is still here is the empty field by another route, and
	// means the same thing.
	const everyone = named.length === 0 || named.length === ids.length;
	/* Set by a tick that asked for nobody, and cleared by the next one that does
	   not. It is the only feedback such a tick can have, because the pick it
	   asked for is the pick it already had. */
	const [askedForNobody, setAskedForNobody] = useState(false);
	return (
		<FieldShell
			label="Participants"
			className={className}
			hint={askedForNobody ? NOBODY_HINT : undefined}
		>
			<MultiSelect
				selected={everyone ? ids : named}
				onChange={(next) => {
					const known = next.filter((id) => ids.includes(id));
					/* Untick the last name, or a crew that covers the trip, and what is
					   being asked for is an event with nobody on it. There is no such
					   event: the store keeps "everyone" as no rows at all, so an empty
					   pick reads back as the whole group and the ticks come straight
					   back. Saying so is the honest answer; showing an empty field that
					   saves as everyone would not be. */
					setAskedForNobody(known.length === 0);
					onChange(known.length === ids.length ? [] : known);
				}}
				options={memberOptions}
				groups={crewGroups(crews)}
				summary={everyone ? 'Everyone' : undefined}
				note={askedForNobody ? NOBODY_HINT : undefined}
				ariaLabel="Participants"
			/>
		</FieldShell>
	);
}
