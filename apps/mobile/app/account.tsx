import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Stack } from 'expo-router';
import { copy } from '@trippy/copy';
import { api } from '../src/lib/api';
import { useApi } from '../src/hooks/useApi';
import { useMutation } from '../src/hooks/useMutation';
import { useAuth } from '../src/auth';
import { Button, Card, Field, FormError, Head, Loading, Screen } from '../src/ui';
import { ListPicker } from '../src/ui/controls';
import { color, space, type } from '../src/theme';

type AccountData = {
	profile: { name: string; email: string; homeTz: string };
	timeZones: string[];
};

export default function Account() {
	const { data, loading, reload } = useApi<AccountData>('/account');
	const { refresh } = useAuth();

	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [homeTz, setHomeTz] = useState('UTC');
	const [savedProfile, setSavedProfile] = useState(false);

	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [confirm, setConfirm] = useState('');
	const [savedPassword, setSavedPassword] = useState(false);

	useEffect(() => {
		if (!data) return;
		setName(data.profile.name);
		setEmail(data.profile.email);
		setHomeTz(data.profile.homeTz);
	}, [data]);

	const saveProfile = useMutation(
		async () => {
			await api('/account/profile', { method: 'PATCH', body: { name, email, homeTz } });
			setSavedProfile(true);
			// The header avatar and the greeting read from the session user, so the
			// name has to be re-read there too or the change only shows on this page.
			await refresh();
			reload();
		},
		{ fallback: copy.account.profile.fallback }
	);

	const savePassword = useMutation(
		async () => {
			await api('/account/password', { method: 'POST', body: { current, next, confirm } });
			setSavedPassword(true);
			setCurrent('');
			setNext('');
			setConfirm('');
		},
		{ fallback: copy.account.password.fallback }
	);

	if (loading && !data) return <Loading />;

	return (
		<>
			<Stack.Screen options={{ title: copy.account.heading }} />
			<Screen>
				<Card style={{ gap: space.md }}>
					<Head>{copy.account.profile.heading}</Head>
					<Field label={copy.account.profile.nameLabel} value={name} onChangeText={setName} />
					<Field
						label={copy.account.profile.emailLabel}
						value={email}
						onChangeText={setEmail}
						autoCapitalize="none"
						keyboardType="email-address"
					/>
					<ListPicker
						label={copy.account.profile.timeZoneLabel}
						value={homeTz}
						options={data?.timeZones ?? [homeTz]}
						onPick={setHomeTz}
					/>
					<FormError message={saveProfile.error} />
					{savedProfile && !saveProfile.error ? (
						<Text style={{ ...type.small, color: color.accentInk }}>
							{copy.account.profile.saved}
						</Text>
					) : null}
					<Button
						label={copy.account.profile.submitLabel}
						onPress={() => {
							setSavedProfile(false);
							void saveProfile.run();
						}}
						busy={saveProfile.busy}
					/>
				</Card>

				<Card style={{ gap: space.md }}>
					<Head>{copy.account.password.heading}</Head>
					<Field
						label={copy.account.password.currentLabel}
						value={current}
						onChangeText={setCurrent}
						secureTextEntry
					/>
					<Field
						label={copy.account.password.newLabel}
						value={next}
						onChangeText={setNext}
						secureTextEntry
					/>
					<Text style={type.faint}>{copy.account.password.newHint}</Text>
					<Field
						label={copy.account.password.confirmLabel}
						value={confirm}
						onChangeText={setConfirm}
						secureTextEntry
					/>
					<FormError message={savePassword.error} />
					{savedPassword && !savePassword.error ? (
						<Text style={{ ...type.small, color: color.accentInk }}>
							{copy.account.password.updated}
						</Text>
					) : null}
					<Button
						label={copy.account.password.submitLabel}
						onPress={() => {
							setSavedPassword(false);
							void savePassword.run();
						}}
						busy={savePassword.busy}
						disabled={!current || !next}
					/>
				</Card>
			</Screen>
		</>
	);
}
