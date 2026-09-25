import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { copy } from '@trippy/copy';
import { api } from '../src/lib/api';
import { useApi } from '../src/hooks/useApi';
import { useMutation } from '../src/hooks/useMutation';
import { useAuth } from '../src/auth';
import { Field, InsetSection, ListRow, Loading, Screen } from '../src/ui';
import { SearchablePicker } from '../src/ui/controls';
import { Sheet } from '../src/ui/Sheet';
import { useToast } from '../src/ui/Toast';
import { color, space, type } from '../src/theme';

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
	const [passwordOpen, setPasswordOpen] = useState(false);

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
	const profileDirty = data
		? name !== data.profile.name ||
			email.trim().toLowerCase() !== data.profile.email.toLowerCase() ||
			homeTz !== data.profile.homeTz ||
			(changingEmail && currentPassword.length > 0)
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

	if (loading && !data) return <Loading />;
	const zoneOptions = (data?.timeZones ?? [homeTz]).map((zone) => ({ key: zone, label: zone }));
	const pending = data?.profile.pendingEmail ?? null;
	const canSave =
		profileDirty && !saveProfile.busy && (!changingEmail || currentPassword.length > 0);

	return (
		<>
			<Stack.Screen
				options={{
					title: Platform.OS === 'web' ? '' : copy.account.heading,
					headerLargeTitle: true,
					headerRight: () => (
						<Pressable
							accessibilityRole="button"
							accessibilityLabel={copy.common.save}
							onPress={canSave ? () => void saveProfile.run() : undefined}
							hitSlop={10}
						>
							<Text
								style={{
									...type.body,
									color: color.accent,
									fontWeight: '600',
									opacity: canSave ? 1 : 0.35
								}}
							>
								{saveProfile.busy ? copy.common.saving : copy.common.save}
							</Text>
						</Pressable>
					)
				}}
			/>
			<Screen largeTitle={Platform.OS === 'web' ? copy.account.heading : undefined}>
				<InsetSection title={copy.account.profile.heading} error={saveProfile.error}>
					<Field label={copy.account.profile.nameLabel} value={name} onChangeText={setName} />
					<Field
						label={copy.account.profile.emailLabel}
						value={email}
						onChangeText={setEmail}
						autoCapitalize="none"
						keyboardType="email-address"
					/>
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
						last
					/>
				</InsetSection>
				{pending ? (
					<Text style={type.footnote}>{copy.account.profile.emailPending(pending)}</Text>
				) : null}
				<InsetSection title={copy.account.password.heading}>
					<ListRow
						title={copy.account.password.change}
						symbol={{ name: 'key', fallback: 'key-outline' }}
						onPress={() => setPasswordOpen(true)}
						last
					/>
				</InsetSection>
			</Screen>
			<PasswordSheet open={passwordOpen} onClose={() => setPasswordOpen(false)} />
		</>
	);
}

function PasswordSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
	const toast = useToast();
	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [confirm, setConfirm] = useState('');
	useEffect(() => {
		if (!open) return;
		setCurrent('');
		setNext('');
		setConfirm('');
	}, [open]);
	const savePassword = useMutation(
		async () => {
			await api('/account/password', { method: 'POST', body: { current, next, confirm } });
		},
		{
			fallback: copy.account.password.fallback,
			onSuccess: () => {
				toast.success(copy.account.password.updated);
				onClose();
			}
		}
	);
	return (
		<Sheet
			open={open}
			title={copy.account.password.heading}
			onClose={onClose}
			onPrimary={() => void savePassword.run()}
			primaryLabel={copy.common.save}
			primaryBusyLabel={copy.common.saving}
			primaryBusy={savePassword.busy}
			primaryDisabled={!current || !next}
		>
			<InsetSection footer={copy.account.password.newHint} error={savePassword.error}>
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
				<Field
					label={copy.account.password.confirmLabel}
					value={confirm}
					onChangeText={setConfirm}
					secureTextEntry
					autoComplete="new-password"
					last
				/>
			</InsetSection>
		</Sheet>
	);
}
