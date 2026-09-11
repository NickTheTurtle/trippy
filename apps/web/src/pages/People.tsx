import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useLiveSection } from '../hooks/useTripEvents';
import { useTrip } from './TripShell';
import FormError from '../components/ui/FormError';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { PlusIcon } from '../components/ui/icons';
import type { Person, PeopleData } from './people/types';
import MemberRow from './people/MemberRow';
import EditMember from './people/EditMember';
import AddPersonDialog from './people/AddPersonDialog';
import { copy } from '../copy';

const cpl = copy.people;

/**
 * People: who is on the trip, and the button that adds one.
 *
 * This file is composition only. The roster row, the add dialog and the
 * removal confirmation live in `pages/people/`.
 */
export default function People() {
	const { trip, reloadTrip } = useTrip();
	const { data, error, reload } = useApi<PeopleData>(`/trips/${trip.id}/people`);
	useLiveSection(['members'], reload);
	const [notice, setNotice] = useState('');
	const [adding, setAdding] = useState(false);
	const [pendingRemove, setPendingRemove] = useState<Person | null>(null);
	const [editing, setEditing] = useState<Person | null>(null);

	// The header shows the member avatars, so anything that changes the roster
	// has to refresh the shell too, not just this page.
	function refresh() {
		reload();
		reloadTrip();
	}

	if (!data) return error ? <FormError message={error} variant="banner" /> : null;

	return (
		<>
			{/* Only ever a success line: a refusal reports inside the dialog that was
			    refused, not at the top of the page. */}
			<FormError message={notice} tone="success" variant="banner" />

			{/* The same header band as Preparation and Expenses: the count where
			    those two put their totals, "+ Add" on the same line. */}
			<div className="mb-4 flex min-h-phead flex-wrap items-center justify-between gap-4">
				<h2 className="flex items-baseline gap-2 text-section">
					{cpl.membersHeading}
					<span className="muted text-meta font-normal">{data.people.length}</span>
				</h2>
				{data.organizer && (
					<button className="btn primary" onClick={() => setAdding(true)}>
						<PlusIcon />
						{copy.common.add}
					</button>
				)}
			</div>

			<section className="card px-5 py-5">
				{/* Auto-fill columns rather than one long list: at 20 members a
				    single column is mostly empty space on a wide screen. */}
				<ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-6 gap-y-0.5 p-0">
					{data.people.map((p) => (
						<MemberRow
							key={p.id}
							person={p}
							me={data.me}
							organizer={data.organizer}
							onEdit={p.placeholder || p.seeded ? () => setEditing(p) : null}
							onRemove={() => setPendingRemove(p)}
						/>
					))}
				</ul>
			</section>

			{adding && (
				<AddPersonDialog
					tripId={trip.id}
					onClose={() => setAdding(false)}
					onDone={(text) => {
						setNotice(text);
						refresh();
					}}
				/>
			)}

			{editing && (
				<EditMember
					person={editing}
					tripId={trip.id}
					onClose={() => setEditing(null)}
					onSaved={refresh}
					onDone={setNotice}
				/>
			)}

			<ConfirmDialog
				open={!!pendingRemove}
				title={pendingRemove ? cpl.removeTitle(pendingRemove.name) : ''}
				confirmLabel={copy.common.remove}
				busyLabel={cpl.removeBusy}
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
