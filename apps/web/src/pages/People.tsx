import { useState } from 'react';
import { api, ApiError } from '../api';
import { useApi } from '../useApi';
import { useTrip } from './TripShell';
import { Field } from '../components/Field';

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
	const [notice, setNotice] = useState<{
		kind: 'ok' | 'error';
		text: string;
	} | null>(null);

	// The header shows the member avatars, so anything that changes the roster
	// has to refresh the shell too, not just this page.
	function refresh() {
		reload();
		reloadTrip();
	}

	if (!data) return error ? <p className="text-warn">{error}</p> : null;

	return (
		<>
			<div className="mb-5">
				<p className="muted m-0">Who is coming, and who still needs an invite.</p>
			</div>

			{notice && (
				<p
					role="status"
					className={[
						'mb-4 rounded-lg px-3.5 py-2.5 text-[0.9rem]',
						notice.kind === 'error'
							? 'bg-danger-soft text-danger-ink'
							: 'bg-accent-soft text-accent-ink'
					].join(' ')}
				>
					{notice.text}
				</p>
			)}

			<div
				className={
					data.organizer
						? 'grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]'
						: 'grid grid-cols-[minmax(0,1fr)] gap-5'
				}
			>
				<section className="card px-5 py-5">
					<h3 className="mb-3.5 text-[1.05rem]">Members</h3>
					{/* Auto-fill columns rather than one long list: at 20 members a
					    single column is mostly empty space on a wide screen. */}
					<ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-6 gap-y-0.5 p-0">
						{data.people.map((p) => (
							<Row
								key={p.id}
								person={p}
								me={data.me}
								organizer={data.organizer}
								tripId={trip.id}
								onRemoved={refresh}
								onError={(text) => setNotice({ kind: 'error', text })}
							/>
						))}
					</ul>
				</section>

				{data.organizer && (
					<Invite
						tripId={trip.id}
						onDone={(text) => {
							setNotice({ kind: 'ok', text });
							refresh();
						}}
						onError={(text) => setNotice({ kind: 'error', text })}
					/>
				)}
			</div>
		</>
	);
}

function Row({
	person,
	me,
	organizer,
	tripId,
	onRemoved,
	onError
}: {
	person: Person;
	me: string;
	organizer: boolean;
	tripId: string;
	onRemoved: () => void;
	onError: (text: string) => void;
}) {
	const [busy, setBusy] = useState(false);

	async function remove() {
		setBusy(true);
		try {
			await api(`/trips/${tripId}/people/${person.id}`, { method: 'DELETE' });
			onRemoved();
		} catch (err) {
			onError(err instanceof ApiError ? err.message : 'Could not remove that member.');
			setBusy(false);
		}
	}

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
				<button
					type="button"
					disabled={busy}
					onClick={remove}
					aria-label={`Remove ${person.name}`}
					className="cursor-pointer border-none bg-transparent px-1 py-0.5 text-[0.82rem] text-ink-faint hover:text-danger-ink disabled:cursor-default"
				>
					Remove
				</button>
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

function Invite({
	tripId,
	onDone,
	onError
}: {
	tripId: string;
	onDone: (text: string) => void;
	onError: (text: string) => void;
}) {
	const [email, setEmail] = useState('');
	const [busy, setBusy] = useState(false);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		try {
			const { message } = await api<{ message: string }>(`/trips/${tripId}/people/invites`, {
				method: 'POST',
				body: { email }
			});
			setEmail('');
			onDone(message);
		} catch (err) {
			onError(err instanceof ApiError ? err.message : 'Could not send that invite.');
		}
		setBusy(false);
	}

	return (
		<section className="card sticky top-4 px-5 py-5">
			<h3 className="mb-3.5 text-[1.05rem]">Invite someone</h3>
			<form className="flex flex-col gap-2" onSubmit={submit}>
				<Field
					label="Email address"
					type="email"
					required
					autoComplete="off"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
				<button className="btn primary justify-center" type="submit" disabled={busy}>
					{busy ? 'Sending...' : 'Send invite'}
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
