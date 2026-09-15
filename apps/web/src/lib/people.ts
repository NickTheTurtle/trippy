import type { Crew } from '../pages/people/types';
import type { Option } from '../components/ui/Select';

/**
 * The roster, as the people pickers want it.
 *
 * Every picker of people offers the same two things in the same order: the
 * crews, then the members, with your own name marked. Written once here because
 * four call sites doing it inline is four chances for one of them to drop the
 * "(you)" or to order the menu differently.
 */
export function memberOptions(
	members: { id: string; name: string }[],
	me: string,
	youSuffix: string
): Option[] {
	return members.map((m) => ({ value: m.id, label: m.name + (m.id === me ? youSuffix : '') }));
}

/** Crews as `MultiSelect` groups: picking one writes its members into the field. */
export function crewGroups(crews: Crew[]): { value: string; label: string; members: string[] }[] {
	return crews.map((c) => ({ value: c.id, label: c.name, members: c.members }));
}
