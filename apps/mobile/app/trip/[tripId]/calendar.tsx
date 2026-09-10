import { EmptyState, Screen } from '../../../src/ui';

/**
 * Left deliberately empty.
 *
 * The web calendar is awaiting a redesign and is under a standing instruction
 * not to be invested in further, so porting it now would be work thrown away
 * twice. The tab exists so the bar has its five slots and the redesign has
 * somewhere to land.
 */
export default function Calendar() {
	return (
		<Screen>
			<EmptyState message="The schedule is being redesigned." hint="It will land here." />
		</Screen>
	);
}
