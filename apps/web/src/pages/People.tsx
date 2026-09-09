import { useState } from 'react';
import { api } from '../api';
import { useApi } from '../useApi';
import { useLiveSection } from '../useTripEvents';
import { useMutation } from '../useMutation';
import { useTrip } from './TripShell';
import type { RemovalImpact } from '../api-types';
import { Field } from '../components/Field';
import FormError from '../components/FormError';
import ConfirmDialog from '../components/ConfirmDialog';
import { LinkButton } from '../components/buttons';

type Person = {
	id: string;
	name: string;
	email: string;
	role: string;
	placeholder: boolean;
	seeded: boolean;
};

type Data = { me: string; organizer: boolean; people: Person[] };

export default function People() {
	const { trip, reloadTrip } = useTrip();
	const { data, error, reload } = useApi<Data>(`/trips/${trip.id}/people`);
	useLiveSection(['members'], reload);
	const [notice, setNotice] = useState('');
	const [pendingRemove, setPendingRemove] = useState<Person | null>(null);

	// The header shows the member avatars, so anything that changes the roster
	// has to refresh the shell too, not just this page.
	function refresh() {
		reload();
		reloadTrip();
	}

	if (!data) return error ? <FormError message={error} variant="banner" /> : null;

	return (
		<>
			<div className="mb-5">
				<p className="muted m-0">Who is coming, and who still needs an invite.</p>
			</div>

			{/* Only ever a success line: an invite that is refused reports inside the
			    form that was refused, not at the top of the page. */}
			<FormError message={notice} tone="success" variant="banner" />

			<div
				className={
					data.organizer
						? 'grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]'
						: 'grid grid-cols-[minmax(0,1fr)] gap-5'
				}
			>
				<section className="card px-5 py-5">
					<h3 className="mb-3.5 flex items-baseline gap-2 text-[1.05rem]">
						Members
						<span className="muted text-[0.82rem] font-normal">{data.people.length}</span>
					</h3>
					{/* Auto-fill columns rather than one long list: at 20 members a
					    single column is mostly empty space on a wide screen. */}
					<ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-6 gap-y-0.5 p-0">
						{data.people.map((p) => (
							<Row
								key={p.id}
								person={p}
								me={data.me}
								organizer={data.organizer}
								onRemove={() => setPendingRemove(p)}
							/>
						))}
					</ul>
				</section>

				{data.organizer && (
					<Invite
						tripId={trip.id}
						onDone={(text) => {
							setNotice(text);
							refresh();
						}}
					/>
				)}
			</div>

			<ConfirmDialog
				open={!!pendingRemove}
				title={pendingRemove ? `Remove ${pendingRemove.name}?` : ''}
				confirmLabel="Remove"
				busyLabel="Removing..."
				body={pendingRemove && <RemoveBody tripId={trip.id} person={pendingRemove} />}
				onCancel={() => setPendingRemove(null)}
				onConfirm={async () => {
					if (!pendingRemove) return;
					// No `useMutation` here: `ConfirmDialog` already owns the busy flag
					// and shows a throw in its own footer, so a second state machine
					// would only decide twice where the message goes.
					await api(`/trips/${trip.id}/people/${pendingRemove.id}`, { method: 'DELETE' });
					setPendingRemove(null);
					setNotice('');
					refresh();
				}}
			/>
		</>
	);
}

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
function RemoveBody({ tripId, person }: { tripId: string; person: Person }) {
	const { data } = useApi<RemovalImpact>(`/trips/${tripId}/people/${person.id}/removal-impact`);

	return (
		<>
			<p className="m-0 mb-2 font-semibold [overflow-wrap:anywhere]">{person.name}</p>
			{person.placeholder ? (
				<>
					<p className="m-0 text-[0.9rem]">
						They were invited at {person.email} but have not joined, so the invite is withdrawn and
						their user record is deleted. The address can be invited again afterwards.
					</p>
					{data && <Destroys impact={data} />}
				</>
			) : (
				<>
					<p className="m-0 text-[0.9rem]">
						They lose access to this trip. Their account and any other trip they are on are
						untouched.
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

function Row({
	person,
	me,
	organizer,
	onRemove
}: {
	person: Person;
	me: string;
	organizer: boolean;
	onRemove: () => void;
}) {
	const sub = person.placeholder
		? `${person.email} (not joined yet)`
		: person.seeded
			? 'Sample companion'
			: person.email;

	return (
		<li className="flex items-center gap-3 rounded-sm p-2 hover:bg-surface-2">
			<span className="grid size-[34px] shrink-0 place-items-center rounded-full bg-accent-soft font-semibold text-accent-ink">
				{person.name[0]}
			</span>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex min-w-0 items-center gap-1.5 font-medium">
					<span className="truncate" title={person.name}>
						{person.name}
					</span>
					{person.id === me && <Tag kind="you">you</Tag>}
					{person.role === 'organizer' && <Tag kind="org">organizer</Tag>}
					{person.placeholder ? (
						<Tag kind="invited">invited</Tag>
					) : (
						person.seeded && <Tag kind="seed">sample</Tag>
					)}
				</span>
				<span className="muted truncate text-[0.82rem]">{sub}</span>
			</span>
			{organizer && person.role !== 'organizer' && (
				/* A text control rather than a bordered button: on every row of a
				   two-column roster a button would read as the row's main action,
				   which it is not. The weight belongs in the confirmation. */
				<LinkButton
					danger
					className="flex-none"
					onClick={onRemove}
					aria-label={`Remove ${person.name}`}
				>
					Remove
				</LinkButton>
			)}
		</li>
	);
}

function Tag({ kind, children }: { kind: 'you' | 'org' | 'seed' | 'invited'; children: string }) {
	const style = {
		org: 'bg-accent-soft text-accent-ink',
		you: 'bg-line text-ink-soft',
		seed: 'border border-line text-ink-faint',
		invited: 'border border-accent-soft text-accent-ink'
	}[kind];
	return (
		<span
			className={`shrink-0 rounded-full px-1.5 py-px text-[0.68rem] font-semibold tracking-wider uppercase ${style}`}
		>
			{children}
		</span>
	);
}

function Invite({ tripId, onDone }: { tripId: string; onDone: (text: string) => void }) {
	const [email, setEmail] = useState('');

	const invite = useMutation(
		async () => {
			const { message } = await api<{ message: string }>(`/trips/${tripId}/people/invites`, {
				method: 'POST',
				body: { email }
			});
			setEmail('');
			onDone(message);
		},
		{ fallback: 'Could not send that invite.' }
	);

	return (
		<section className="card sticky top-4 px-5 py-5">
			<h3 className="mb-3.5 text-[1.05rem]">Invite someone</h3>
			{/* Beside the box that was refused, not at the top of the page: the
			    message is almost always about the address that was just typed. */}
			<FormError message={invite.error} variant="banner" />
			<form className="flex flex-col gap-2" onSubmit={invite.submit}>
				<Field
					label="Email address"
					type="email"
					required
					autoComplete="off"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
				<button className="btn primary" type="submit" disabled={invite.busy}>
					{invite.busy ? 'Sending...' : 'Send invite'}
				</button>
			</form>
			<p className="muted mt-2.5 text-[0.82rem]">
				If they already have an account they join right away. Otherwise they appear as a placeholder
				and take over the spot (and any expenses assigned to them) when they register with this
				email.
			</p>
		</section>
	);
}
