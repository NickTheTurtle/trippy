import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useLiveSection } from '../hooks/useTripEvents';
import { useTrip } from './TripShell';
import FormError from '../components/ui/FormError';
import SectionNav from '../components/ui/SectionNav';
import { useNarrowLayout } from '../hooks/useMediaQuery';
import { PlusIcon } from '../components/ui/icons';
import type { Crew, Person, PeopleData } from './people/types';
import MemberRow from './people/MemberRow';
import EditMember from './people/EditMember';
import AddPersonDialog from './people/AddPersonDialog';
import CrewList from './people/CrewList';
import CrewDialog from './people/CrewDialog';
import { copy } from '../copy';

const cpl = copy.people;

/**
 * People: who is on the trip, and the crews they are grouped into.
 *
 * Two sections rather than a roster with the crews alongside it. A crew is read
 * against the list of people it is drawn from, so a sidebar seemed right, but a
 * column of 190px next to a roster of twenty is a narrow strip beside the busy
 * part of the page, and it is the same shape of thing as Tasks and Packing: a
 * list you add to. It switches like they do.
 *
 * This file is composition only. The roster row, the crew list, the dialogs and
 * their deletes live in `pages/people/`.
 */
export default function People() {
	const { trip, reloadTrip } = useTrip();
	const { data, error, reload } = useApi<PeopleData>(`/trips/${trip.id}/people`);
	useLiveSection(['members'], reload);
	const [notice, setNotice] = useState('');
	const [section, setSection] = useState('members');
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<Person | null>(null);
	/** The crew the dialog is open for: a row, or null for a new one. Closed is `false`. */
	const [crewDraft, setCrewDraft] = useState<Crew | null | false>(false);
	const narrow = useNarrowLayout();

	// The header shows the member avatars, so anything that changes the roster
	// has to refresh the shell too, not just this page.
	function refresh() {
		reload();
		reloadTrip();
	}

	if (!data) return error ? <FormError message={error} variant="banner" /> : null;

	const crews = section === 'crews';
	const sections = [
		{ id: 'members', label: cpl.membersHeading, badge: data.people.length },
		{ id: 'crews', label: cpl.crews.heading, badge: data.crews.length || null }
	];

	// Anyone may keep a crew, as the server allows: it is a shortcut, and getting
	// one wrong costs nothing the schedule can feel. Only the organizer may put
	// somebody on the trip.
	const addButton = (crews || data.organizer) && (
		<button className="btn primary" onClick={() => (crews ? setCrewDraft(null) : setAdding(true))}>
			<PlusIcon />
			{copy.common.add}
		</button>
	);

	return (
		<div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[190px_minmax(0,1fr)]">
			<SectionNav
				items={sections}
				value={section}
				onChange={setSection}
				ariaLabel={cpl.navAriaLabel}
				action={addButton}
			/>

			<div className="min-w-0">
				{/* Only ever a success line: a refusal reports inside the dialog that
				    was refused, not at the top of the page. */}
				<FormError message={notice} tone="success" variant="banner" />

				{/* Narrow, the add button has gone up beside the dropdown, which also
				    names the section, so this row would be an empty band. Wide, a
				    member looking at the roster has no button either, and a band
				    reserving room for one pushes the list down for nothing. */}
				{!narrow && addButton && (
					<div className="mb-4 flex min-h-phead flex-wrap items-center justify-end gap-4">
						{addButton}
					</div>
				)}

				{crews ? (
					<CrewList
						crews={data.crews}
						names={Object.fromEntries(data.people.map((p) => [p.id, p.name]))}
						onEdit={setCrewDraft}
					/>
				) : (
					<section className="card px-5 py-5">
						{/* Auto-fill columns rather than one long list: at 20 members a
						    single column is mostly empty space on a wide screen. The
						    floor is the width a name plus its longest tag needs on one
						    line, since a column any narrower wraps the tags and the rows
						    stop lining up across the grid. Rows are two lines tall, so
						    they need more than a hairline between them or the hover
						    surfaces of neighbouring rows read as one block. */}
						<ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-x-6 gap-y-2 p-0">
							{data.people.map((p) => (
								<MemberRow
									key={p.id}
									person={p}
									me={data.me}
									// Your own row is always yours to open: your name is your
									// account's and renaming yourself is not a trip write.
									// Otherwise only the organizer may act, and nobody may
									// take the organizer off their own trip, so that row
									// opens onto nothing and stays plain text.
									onOpen={
										p.id === data.me ||
										(data.organizer && (p.placeholder || p.seeded || p.role !== 'organizer'))
											? () => setEditing(p)
											: null
									}
								/>
							))}
						</ul>
					</section>
				)}
			</div>

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

			{crewDraft !== false && (
				<CrewDialog
					tripId={trip.id}
					crew={crewDraft}
					memberOptions={data.people.map((p) => ({ value: p.id, label: p.name }))}
					onClose={() => setCrewDraft(false)}
					onDone={reload}
				/>
			)}

			{editing && (
				<EditMember
					person={editing}
					me={data.me}
					tripId={trip.id}
					onClose={() => setEditing(null)}
					onSaved={refresh}
					onDone={setNotice}
					onRemove={
						editing.id === data.me || !data.organizer
							? null
							: async () => {
									// No `useMutation` here: the confirmation already owns the
									// busy flag and shows a throw in its own footer, so a second
									// state machine would only decide twice where the message
									// goes.
									await api(`/trips/${trip.id}/people/${editing.id}`, { method: 'DELETE' });
									setEditing(null);
									setNotice('');
									refresh();
								}
					}
				/>
			)}
		</div>
	);
}
