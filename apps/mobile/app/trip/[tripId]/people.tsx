import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { useTripId } from '../../../src/trip-id';
import { useApi } from '../../../src/hooks/useApi';
import { useLiveSection } from '../../../src/hooks/useTripEvents';
import { useToast } from '../../../src/ui/Toast';
import { useTripHeaderAction } from '../../../src/ui/TripHeaderAction';
import {
	Button,
	EmptyState,
	FormError,
	InsetSection,
	ListRow,
	Loading,
	Screen
} from '../../../src/ui';
import { SegmentedControl } from '../../../src/ui/controls';
import { color, space, type } from '../../../src/theme';
import {
	AddPersonSheet,
	CrewSheet,
	MemberSheet,
	type Crew,
	type Person
} from '../../../src/screens/PeopleSheets';

type Data = { me: string; organizer: boolean; people: Person[]; crews: Crew[] };
const SECTIONS = ['members', 'crews'] as const;
type Section = (typeof SECTIONS)[number];

export default function People() {
	const tripId = useTripId();
	const toast = useToast();
	const { data, error, loading, reload } = useApi<Data>(`/trips/${tripId}/people`);
	useLiveSection(['members'], reload);
	const [section, setSection] = useState<Section>('members');
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<Person | null>(null);
	const [crewDraft, setCrewDraft] = useState<Crew | null | false>(false);
	useTripHeaderAction(
		useCallback(() => {
			if (section === 'crews') setCrewDraft(null);
			else if (data?.organizer) setAdding(true);
		}, [data?.organizer, section])
	);

	useEffect(() => {
		if (error) toast.error(error);
	}, [error, toast]);

	if (loading && !data) return <Loading />;
	if (!data) {
		return (
			<Screen>
				<FormError message={error ?? copy.api.loadFailed} />
				<Button label={copy.api.retry} onPress={reload} />
			</Screen>
		);
	}

	const knownNames = Object.fromEntries(data.people.map((person) => [person.id, person.name]));
	const memberRows = data.people;
	const crews = data.crews;
	const canAdd = section === 'crews' || data.organizer;

	return (
		<>
			<Screen refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}>
				<SegmentedControl
					items={SECTIONS.map((key) => ({
						key,
						label: key === 'members' ? copy.people.membersHeading : copy.people.crews.heading
					}))}
					active={section}
					onPick={(key) => setSection(key as Section)}
				/>
				{section === 'members' ? (
					<InsetSection title={copy.people.membersHeading}>
						{memberRows.length ? (
							memberRows.map((person, index) => (
								<MemberRow
									key={person.id}
									person={person}
									me={data.me}
									last={index === memberRows.length - 1}
									canOpen={
										person.id === data.me ||
										(data.organizer &&
											(person.placeholder || person.seeded || person.role !== 'organizer'))
									}
									onOpen={() => setEditing(person)}
								/>
							))
						) : (
							<EmptyState message={copy.common.nothingAdded} />
						)}
					</InsetSection>
				) : (
					<InsetSection title={copy.people.crews.heading}>
						{crews.length ? (
							crews.map((crew, index) => {
								const names = crew.members
									.filter((id) => knownNames[id])
									.map((id) => knownNames[id]);
								const subtitle = names.length ? names.join(', ') : copy.people.crews.nobody;
								return (
									<ListRow
										key={crew.id}
										title={crew.name}
										subtitle={`${crew.members.length} ${
											crew.members.length === 1 ? 'person' : 'people'
										}`}
										detail={subtitle}
										leading={<Avatar name={crew.name} />}
										onPress={crew.locked ? undefined : () => setCrewDraft(crew)}
										last={index === crews.length - 1}
									/>
								);
							})
						) : (
							<EmptyState message={copy.common.nothingAdded} />
						)}
					</InsetSection>
				)}
			</Screen>

			{adding ? (
				<AddPersonSheet
					open
					tripId={tripId}
					onClose={() => setAdding(false)}
					onDone={(message) => {
						setAdding(false);
						toast.success(message);
						reload();
					}}
				/>
			) : null}
			{editing ? (
				<MemberSheet
					open
					tripId={tripId}
					person={editing}
					me={data.me}
					organizer={data.organizer}
					onClose={() => setEditing(null)}
					onDone={toast.success}
					onSaved={() => {
						setEditing(null);
						reload();
					}}
				/>
			) : null}
			{crewDraft !== false ? (
				<CrewSheet
					open
					tripId={tripId}
					crew={crewDraft}
					people={data.people}
					onClose={() => setCrewDraft(false)}
					onDone={() => {
						setCrewDraft(false);
						reload();
					}}
				/>
			) : null}
		</>
	);
}

function initials(name: string): string {
	return name.trim().slice(0, 1).toUpperCase();
}

function Avatar({ name }: { name: string }) {
	return (
		<View
			style={{
				width: 32,
				height: 32,
				borderRadius: 16,
				backgroundColor: color.accentSoft,
				alignItems: 'center',
				justifyContent: 'center'
			}}
		>
			<Text style={{ ...type.footnote, color: color.accentInk, fontWeight: '700' }}>
				{initials(name)}
			</Text>
		</View>
	);
}

function MemberRow({
	person,
	me,
	canOpen,
	onOpen,
	last
}: {
	person: Person;
	me: string;
	canOpen: boolean;
	onOpen: () => void;
	last: boolean;
}) {
	const tags = [
		person.id === me ? copy.people.row.youTag : null,
		person.role === 'organizer' ? copy.people.row.organizerTag : null,
		person.placeholder && person.invitedEmail ? copy.people.row.invitedTag : null,
		person.seeded || (person.placeholder && !person.invitedEmail) ? 'stand-in' : null
	].filter(Boolean) as string[];
	const status = tags.join(' · ');
	const email = person.placeholder ? (person.invitedEmail ?? person.email) : person.email;
	return (
		<ListRow
			title={person.name}
			subtitle={status || null}
			detail={email || null}
			leading={<Avatar name={person.name} />}
			accessory={canOpen ? 'chevron' : 'none'}
			onPress={canOpen ? onOpen : undefined}
			last={last}
		/>
	);
}
