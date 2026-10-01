import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { useTripId } from '../../../src/trip-id';
import { useApi } from '../../../src/hooks/useApi';
import { useLiveSection } from '../../../src/hooks/useTripEvents';
import { useToast } from '../../../src/ui/Toast';
import { useTripAddAction } from '../../../src/ui/TripAddAction';
import {
	Button,
	EmptyState,
	FormError,
	GroupedRow,
	InsetSection,
	ListRow,
	Loading,
	Screen
} from '../../../src/ui';
import { SegmentedControl } from '../../../src/ui/controls';
import { Avatar, Tag } from '../../../src/ui/marks';
import { type } from '../../../src/theme';
import {
	AddPersonSheet,
	CrewSheet,
	MemberSheet,
	type Crew,
	type Person
} from '../../../src/screens/PeopleSheets';
import { tripTab } from '../../../src/ui/nativeTabs';

type Data = { me: string; organizer: boolean; people: Person[]; crews: Crew[] };
const SECTIONS = ['members', 'crews'] as const;
type Section = (typeof SECTIONS)[number];

export default tripTab(People);

function People() {
	const tripId = useTripId();
	const toast = useToast();
	const { data, error, loading, reload } = useApi<Data>(`/trips/${tripId}/people`);
	useLiveSection(['members'], reload);
	const [section, setSection] = useState<Section>('members');
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<Person | null>(null);
	const [crewDraft, setCrewDraft] = useState<Crew | null | false>(false);
	const canAdd = section === 'crews' || !!data?.organizer;
	const headerAction = useCallback(() => {
		if (section === 'crews') setCrewDraft(null);
		else if (data?.organizer) setAdding(true);
	}, [data?.organizer, section]);
	useTripAddAction(canAdd ? headerAction : null);

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
					memberRows.length === 0 ? (
						<EmptyState graphic message={copy.common.nothingAdded} />
					) : (
						<InsetSection title={copy.people.membersHeading}>
							{memberRows.map((person, index) => (
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
							))}
						</InsetSection>
					)
				) : crews.length === 0 ? (
					<EmptyState graphic message={copy.common.nothingAdded} />
				) : (
					<InsetSection title={copy.people.crews.heading}>
						{crews.map((crew, index) => {
							const names = crew.members.filter((id) => knownNames[id]).map((id) => knownNames[id]);
							const subtitle = names.length ? names.join(', ') : copy.people.crews.nobody;
							const count = copy.people.crews.memberCount(names.length);
							return (
								<ListRow
									key={crew.id}
									title={crew.name}
									subtitle={count}
									detail={subtitle}
									leading={<Avatar name={crew.name} size={AVATAR_SIZE} />}
									accessory={crew.locked ? 'none' : 'chevron'}
									onPress={crew.locked ? undefined : () => setCrewDraft(crew)}
									accessibilityLabel={
										crew.locked
											? [crew.name, count, subtitle, copy.people.crews.locked].join(', ')
											: undefined
									}
									last={index === crews.length - 1}
								/>
							);
						})}
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

/** The web's `lg` avatar: a roster row leads with a face a touch larger than a list icon. */
const AVATAR_SIZE = 34;

/**
 * One member of the roster, drawn as web MemberRow is: the status tags sit on
 * the name's own line (wrapping beneath only when the name leaves no room),
 * and one secondary line carries the address, so a row is two lines rather
 * than three.
 */
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
	// Tones follow web MemberRow's Tag kinds. "Invited" only when an invite is
	// out: somebody added by name alone is waiting for no mail.
	const tags: { key: string; label: string; tone: 'accent' | 'neutral'; outline: boolean }[] = [];
	if (person.id === me)
		tags.push({ key: 'you', label: copy.people.row.youTag, tone: 'neutral', outline: false });
	if (person.role === 'organizer')
		tags.push({ key: 'org', label: copy.people.row.organizerTag, tone: 'accent', outline: false });
	if (person.placeholder) {
		if (person.invitedEmail)
			tags.push({ key: 'inv', label: copy.people.row.invitedTag, tone: 'accent', outline: true });
	} else if (person.seeded) {
		tags.push({ key: 'seed', label: copy.people.row.sampleTag, tone: 'neutral', outline: true });
	}
	const editable = person.placeholder || person.seeded || person.id === me;
	const detail = person.seeded
		? copy.people.row.sampleCompanion
		: person.placeholder
			? (person.invitedEmail ?? person.email)
			: person.email;
	return (
		<GroupedRow
			leading={<Avatar name={person.name} size={AVATAR_SIZE} />}
			// Top-aligned like web: when the tags wrap, the face stays beside the name.
			alignTop
			accessory={canOpen ? 'chevron' : 'none'}
			onPress={canOpen ? onOpen : undefined}
			accessible
			accessibilityLabel={
				canOpen
					? editable
						? copy.common.editLabel(person.name)
						: copy.common.deleteLabel(person.name)
					: [person.name, ...tags.map((tag) => tag.label), detail].filter(Boolean).join(', ')
			}
			last={last}
		>
			<View style={styles.nameLine}>
				<Text style={[type.body, styles.name]} numberOfLines={1}>
					{person.name}
				</Text>
				{tags.map((tag) => (
					<Tag key={tag.key} label={tag.label} tone={tag.tone} outline={tag.outline} />
				))}
			</View>
			{detail ? (
				<Text style={type.subhead} numberOfLines={1}>
					{detail}
				</Text>
			) : null}
		</GroupedRow>
	);
}

const styles = StyleSheet.create({
	nameLine: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		alignItems: 'center',
		columnGap: 6,
		rowGap: 4
	},
	// Shrinks so a long name truncates before it pushes its tags off the row.
	name: { flexShrink: 1 }
});
