import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Stack } from 'expo-router';
import { copy } from '@trippy/copy';
import { api } from '../src/lib/api';
import { useApi } from '../src/hooks/useApi';
import { useMutation } from '../src/hooks/useMutation';
import { useAuth } from '../src/auth';
import { Button, Card, Field, FormError, Head, Loading, Screen } from '../src/ui';
import { SearchablePicker } from '../src/ui/controls';
import { useToast } from '../src/ui/Toast';
import { space, type } from '../src/theme';

type AccountData = {
	profile: { name: string; email: string; homeTz: string; pendingEmail?: string | null };
	timeZones: string[];
};

export default function Account() {
	const { data, loading, reload } = useApi<AccountData>('/account');
	const { refresh } = useAuth();
	const toast = useToast();

	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [homeTz, setHomeTz] = useState('UTC');
	const [currentPassword, setCurrentPassword] = useState('');

	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [confirm, setConfirm] = useState('');

	useEffect(() => {
		if (!data) return;
		setName(data.profile.name);
		setEmail(data.profile.email);
		setHomeTz(data.profile.homeTz);
		setCurrentPassword('');
	}, [data]);

	const changingEmail = data
		? email.trim().toLowerCase() !== data.profile.email.toLowerCase()
		: false;

	const saveProfile = useMutation(
		async () => {
			const body = changingEmail ? { name, email, homeTz, currentPassword } : { name, homeTz };
			const res = await api<{ pendingEmail?: string | null }>('/account/profile', {
				method: 'PATCH',
				body
			});
			if (res.pendingEmail && data) {
				setEmail(data.profile.email);
				setCurrentPassword('');
			}
			return res;
		},
		{
			fallback: copy.account.profile.fallback,
			onSuccess: async (res) => {
				if (res.pendingEmail) toast.success(copy.account.profile.emailPending(res.pendingEmail));
				else toast.success(copy.account.profile.saved);
				await refresh();
				reload();
			}
		}
	);

	const savePassword = useMutation(
		async () => {
			await api('/account/password', { method: 'POST', body: { current, next, confirm } });
		},
		{
			fallback: copy.account.password.fallback,
			onSuccess: () => {
				toast.success(copy.account.password.updated);
				setCurrent('');
				setNext('');
				setConfirm('');
			}
		}
	);

	if (loading && !data) return <Loading />;

	const zoneOptions = (data?.timeZones ?? [homeTz]).map((zone) => ({ key: zone, label: zone }));
	const pending = data?.profile.pendingEmail ?? null;

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
					{pending ? (
						<Text style={type.small}>{copy.account.profile.emailPending(pending)}</Text>
					) : null}
					{changingEmail ? (
						<Field
							label={copy.account.profile.currentPasswordLabel}
							value={currentPassword}
							onChangeText={setCurrentPassword}
							secureTextEntry
							autoComplete="current-password"
						/>
					) : null}
					<SearchablePicker
						label={copy.account.profile.timeZoneLabel}
						value={homeTz}
						options={zoneOptions}
						onPick={setHomeTz}
						noMatches={copy.account.profile.timeZoneNoMatches}
					/>
					<FormError message={saveProfile.error} />
					<Button
						label={saveProfile.busy ? copy.common.saving : copy.common.save}
						onPress={() => void saveProfile.run()}
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
						autoComplete="current-password"
					/>
					<Field
						label={copy.account.password.newLabel}
						value={next}
						onChangeText={setNext}
						secureTextEntry
						autoComplete="new-password"
					/>
					<Text style={type.faint}>{copy.account.password.newHint}</Text>
					<Field
						label={copy.account.password.confirmLabel}
						value={confirm}
						onChangeText={setConfirm}
						secureTextEntry
						autoComplete="new-password"
					/>
					<FormError message={savePassword.error} />
					<Button
						label={savePassword.busy ? copy.common.saving : copy.common.save}
						onPress={() => void savePassword.run()}
						busy={savePassword.busy}
						disabled={!current || !next}
					/>
				</Card>
			</Screen>
		</>
	);
}
