import { useApi } from '../../hooks/useApi';
import type { RemovalImpact } from '../../lib/api-types';
import type { Person } from './types';

/**
 * What removing a member actually does, which is two different things, said
 * with the numbers rather than in general terms.
 *
 *  - a placeholder (invited, never registered) exists only for this trip, so
 *    its user row goes and everything keyed to it cascades: the expenses it
 *    paid, its share of everyone else's, and its votes;
 *  - a real account, or a seeded sample companion, keeps its user row. Only the
 *    membership goes, so the expenses they paid stay in the ledger while they
 *    drop out of the balances.
 *
 * The counts come from the server, which derives them from the same cascade
 * that the delete will actually follow. Working them out here from the roster
 * payload would be a second, guessed answer to a question the database can
 * answer exactly, and the guess would be the one on screen when someone decides
 * whether to click.
 *
 * The dialog opens before the counts arrive, so the general sentence is what is
 * shown until they land, and stays if the request fails. It never blocks the
 * dialog on a fetch: a confirmation that renders empty for half a second is
 * worse than one that gets more specific.
 */
export default function RemoveBody({ tripId, person }: { tripId: string; person: Person }) {
	const { data } = useApi<RemovalImpact>(`/trips/${tripId}/people/${person.id}/removal-impact`);

	return (
		<>
			<p className="m-0 mb-2 font-semibold [overflow-wrap:anywhere]">{person.name}</p>
			{person.placeholder ? (
				<>
					<p className="m-0 text-[0.9rem]">
						Invited at {person.email}, never joined. The invite is withdrawn and their record is
						deleted. You can invite the address again.
					</p>
					{data && <Destroys impact={data} />}
				</>
			) : (
				<>
					<p className="m-0 text-[0.9rem]">
						They lose access to this trip. Their account and other trips are untouched.
					</p>
					{data && <Keeps impact={data} />}
				</>
			)}
			{data?.affectsSettlement && (
				/* The part that silently costs people money, so it is its own
				   sentence and not a clause at the end of a longer one. */
				<p className="m-0 mt-2 text-[0.9rem] font-medium">
					Balances on this trip will change, so who owes whom will not be what it was.
				</p>
			)}
		</>
	);
}

/** The placeholder case: everything below is actually deleted. */
function Destroys({ impact }: { impact: RemovalImpact }) {
	const d = impact.destroyed;
	const gone = phrases([
		[d.expensesPaid, 'expense they paid', 'expenses they paid'],
		[d.expenseShares, 'share they owe', 'shares they owe'],
		[d.poiVotes, 'place vote', 'place votes'],
		[d.lodgingVotes, 'stay vote', 'stay votes'],
		[d.itemAssignments, 'calendar assignment', 'calendar assignments'],
		[d.taskAssignments, 'task assignment', 'task assignments'],
		[d.taskCompletions, 'ticked-off task', 'ticked-off tasks'],
		[d.partySegments, 'crew membership', 'crew memberships']
	]);

	if (!gone && !d.otherPeopleSharesLost) return null;

	return (
		<>
			{gone && <p className="m-0 mt-2 text-[0.9rem]">Permanently deleted: {gone}.</p>}
			{d.otherPeopleSharesLost > 0 && (
				/* The surprise: deleting an expense THIS person paid takes everyone
				   else's shares on it with it. Nobody expects that from "remove a
				   member", so it gets said separately rather than folded into the
				   list above. */
				<p className="m-0 mt-2 text-[0.9rem]">
					That also deletes {count(d.otherPeopleSharesLost, 'share', 'shares')} other people had on
					those expenses.
				</p>
			)}
		</>
	);
}

/** The registered case: nothing is deleted, so say what survives. */
function Keeps({ impact }: { impact: RemovalImpact }) {
	const r = impact.retained;
	const kept = phrases([
		[r.expensesPaid, 'expense they paid', 'expenses they paid'],
		[r.expenseShares, 'share they owe', 'shares they owe'],
		[r.poiVotes, 'place vote', 'place votes'],
		[r.lodgingVotes, 'stay vote', 'stay votes'],
		[r.taskAssignments, 'task assignment', 'task assignments']
	]);
	if (!kept) return null;
	return <p className="m-0 mt-2 text-[0.9rem]">Kept, with their name on it: {kept}.</p>;
}

function count(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** "3 expenses they paid, 7 shares they owe and 4 place votes". Zeroes are dropped. */
function phrases(items: [number, string, string][]): string {
	const parts = items.filter(([n]) => n > 0).map(([n, one, many]) => count(n, one, many));
	if (parts.length === 0) return '';
	if (parts.length === 1) return parts[0];
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
