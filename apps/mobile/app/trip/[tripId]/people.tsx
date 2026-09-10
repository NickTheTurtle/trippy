import { useState } from 'react';
import { RefreshControl, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { api } from '../../../src/lib/api';
import { useTripId } from '../../../src/trip-id';
import { useApi } from '../../../src/hooks/useApi';
import { useMutation } from '../../../src/hooks/useMutation';
import { Button, Card, EmptyState, Field, FormError, Head, Loading, Screen } from '../../../src/ui';
import { color, radius, space, type } from '../../../src/theme';

type Person = {
	id: string;
	name: string;
	email: string;
	role: string;
	seeded: boolean;
	placeholder: boolean;
	invitedEmail: string | null;
};

type Data = { me: string; organizer: boolean; people: Person[] };

export default function People() {
	const tripId = useTripId();
	const { data, error, loading, reload } = useApi<Data>(`/trips/${tripId}/people`);
	const [email, setEmail] = useState('');
	const [notice, setNotice] = useState('');

	const invite = useMutation(
		async () => {
			const res = await api<{ message: string }>(`/trips/${tripId}/people/invites`, {
				method: 'POST',
				body: { email }
			});
			setNotice(res.message);
			setEmail('');
		},
		{ fallback: copy.people.invite.fallback, onSuccess: reload }
	);

	if (loading && !data) return <Loading />;

	return (
		<Screen refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}>
			{error ? <FormError message={error} /> : null}

			<Card>
				<Head>{copy.people.membersHeading}</Head>
				{data && data.people.length > 0 ? (
					<View style={{ marginTop: space.sm }}>
						{data.people.map((p) => (
							<PersonRow key={p.id} person={p} me={data.me} />
						))}
					</View>
				) : (
					<EmptyState message="Nothing added yet" />
				)}
			</Card>

			{data?.organizer ? (
				<Card>
					<Head>{copy.people.invite.heading}</Head>
					<View style={{ gap: space.md, marginTop: space.sm }}>
						<Field
							label={copy.people.invite.emailLabel}
							value={email}
							onChangeText={setEmail}
							autoCapitalize="none"
							keyboardType="email-address"
							textContentType="emailAddress"
						/>
						<FormError message={invite.error} />
						{notice ? <Text style={type.small}>{notice}</Text> : null}
						<Button
							label={invite.busy ? copy.people.invite.busyLabel : copy.people.invite.submitLabel}
							onPress={() => void invite.run()}
							busy={invite.busy}
							disabled={!email.trim()}
						/>
					</View>
				</Card>
			) : null}
		</Screen>
	);
}

function PersonRow({ person, me }: { person: Person; me: string }) {
	const c = copy.people.row;
	const tags = [
		person.id === me ? c.youTag : null,
		person.role === 'organizer' ? c.organizerTag : null,
		person.placeholder ? c.invitedTag : null,
		person.seeded ? c.sampleTag : null
	].filter(Boolean) as string[];

	const subtitle = person.seeded
		? c.sampleCompanion
		: person.placeholder
			? c.notJoined(person.email)
			: person.email;

	return (
		<View style={{ paddingVertical: space.sm, gap: space.xs }}>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
				<Text style={type.body}>{person.name}</Text>
				{tags.map((t) => (
					<Tag key={t} label={t} />
				))}
			</View>
			<Text style={type.small}>{subtitle}</Text>
		</View>
	);
}

function Tag({ label }: { label: string }) {
	return (
		<Text
			style={{
				...type.faint,
				color: color.accentInk,
				backgroundColor: color.accentSoft,
				borderRadius: radius.sm,
				paddingHorizontal: 6,
				paddingVertical: 1,
				overflow: 'hidden',
				fontSize: 11
			}}
		>
			{label}
		</Text>
	);
}
