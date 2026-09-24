import { useEffect, useState } from 'react';
import { Pressable, RefreshControl, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { useTripId } from '../../../src/trip-id';
import { useApi } from '../../../src/hooks/useApi';
import { useLiveSection } from '../../../src/hooks/useTripEvents';
import { useToast } from '../../../src/ui/Toast';
import { Button, Card, EmptyState, FormError, Head, Loading, Screen } from '../../../src/ui';
import { SegmentedControl } from '../../../src/ui/controls';
import { color, space, type } from '../../../src/theme';
import {
	AddPersonSheet,
	CrewSheet,
	MemberSheet,
	Tag,
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
				{canAdd ? (
					<Card>
						<AddRow onPress={() => (section === 'crews' ? setCrewDraft(null) : setAdding(true))} />
					</Card>
				) : null}
				{section === 'members' ? (
					<Card>
						<Head>{copy.people.membersHeading}</Head>
						{memberRows.length ? (
							<View style={{ marginTop: space.sm }}>
								{memberRows.map((person) => (
									<MemberRow
										key={person.id}
										person={person}
										me={data.me}
										canOpen={
											person.id === data.me ||
											(data.organizer &&
												(person.placeholder || person.seeded || person.role !== 'organizer'))
										}
										onOpen={() => setEditing(person)}
									/>
								))}
							</View>
						) : (
							<EmptyState message={copy.common.nothingAdded} />
						)}
					</Card>
				) : (
					<Card>
						<Head>{copy.people.crews.heading}</Head>
						<View style={{ marginTop: space.sm }}>
							{crews.map((crew) => {
								const names = crew.members
									.filter((id) => knownNames[id])
									.map((id) => knownNames[id]);
								const subtitle = names.length ? names.join(', ') : copy.people.crews.nobody;
								return (
									<Pressable
										key={crew.id}
										disabled={crew.locked}
										onPress={() => setCrewDraft(crew)}
										style={{ paddingVertical: space.sm, opacity: crew.locked ? 0.75 : 1 }}
										accessibilityLabel={crew.locked ? crew.name : copy.common.editLabel(crew.name)}
									>
										<Text style={type.body}>{crew.name}</Text>
										<Text style={type.faint}>{subtitle}</Text>
									</Pressable>
								);
							})}
						</View>
					</Card>
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

function AddRow({ onPress }: { onPress: () => void }) {
	return (
		<Pressable accessibilityRole="button" onPress={onPress} hitSlop={8}>
			<Text style={{ ...type.body, color: color.accent, fontWeight: '600' }}>
				+ {copy.common.add}
			</Text>
		</Pressable>
	);
}

function MemberRow({
	person,
	me,
	canOpen,
	onOpen
}: {
	person: Person;
	me: string;
	canOpen: boolean;
	onOpen: () => void;
}) {
	const tags = [
		person.id === me ? copy.people.row.youTag : null,
		person.role === 'organizer' ? copy.people.row.organizerTag : null,
		person.placeholder && person.invitedEmail ? copy.people.row.invitedTag : null,
		person.seeded ? copy.people.row.sampleTag : null
	].filter(Boolean) as string[];
	const subtitle = person.seeded ? copy.people.row.sampleCompanion : person.email;
	const body = (
		<View style={{ paddingVertical: space.sm, gap: space.xs }}>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
				<Text style={type.body}>{person.name}</Text>
				{tags.map((tag) => (
					<Tag key={tag} label={tag} />
				))}
			</View>
			{subtitle ? <Text style={type.small}>{subtitle}</Text> : null}
		</View>
	);
	if (!canOpen) return body;
	const editable = person.placeholder || person.seeded || person.id === me;
	return (
		<Pressable
			accessibilityRole="button"
			onPress={onOpen}
			accessibilityLabel={
				editable ? copy.common.editLabel(person.name) : copy.common.deleteLabel(person.name)
			}
		>
			{body}
		</Pressable>
	);
}
