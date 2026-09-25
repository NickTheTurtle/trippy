import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { copy } from '@trippy/copy';
import { useAuth } from '../src/auth';
import { useMutation } from '../src/hooks/useMutation';
import { Button, Field, InsetSection, Loading, Screen } from '../src/ui';
import { color, space, type } from '../src/theme';

export default function Register() {
	const { user, loading, register } = useAuth();
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [pending, setPending] = useState(false);

	const submit = useMutation(() => register(name, email, password), {
		fallback: copy.auth.register.fallback,
		onSuccess: (result) => {
			if (result === 'pending') setPending(true);
			else router.replace('/trips');
		}
	});

	if (loading) return <Loading />;
	if (user) return <Redirect href="/trips" />;
	if (pending) {
		return (
			<Screen topOffset={Platform.OS === 'web' ? 72 : 0} largeTitle={copy.auth.register.sentTitle}>
				<Text style={type.subhead}>{copy.auth.register.sentBlurb}</Text>
				<Button label={copy.auth.login.submitLabel} onPress={() => router.replace('/login')} />
			</Screen>
		);
	}

	return (
		<KeyboardAvoidingView
			style={{ flex: 1 }}
			behavior={Platform.OS === 'ios' ? 'padding' : undefined}
		>
			<Screen topOffset={Platform.OS === 'web' ? 72 : 0} largeTitle={copy.auth.register.title}>
				<Text style={type.subhead}>{copy.auth.register.blurb}</Text>
				<InsetSection footer={copy.auth.register.passwordHint} error={submit.error}>
					<Field
						variant="row"
						label={copy.auth.register.nameLabel}
						value={name}
						onChangeText={setName}
						autoComplete="name"
						textContentType="name"
					/>
					<Field
						variant="row"
						label={copy.auth.register.emailLabel}
						value={email}
						onChangeText={setEmail}
						autoCapitalize="none"
						autoComplete="email"
						keyboardType="email-address"
						textContentType="emailAddress"
					/>
					<Field
						variant="row"
						label={copy.auth.register.passwordLabel}
						last
						value={password}
						onChangeText={setPassword}
						secureTextEntry
						autoComplete="new-password"
						textContentType="newPassword"
					/>
				</InsetSection>
				<Button
					label={copy.auth.register.submitLabel}
					onPress={() => void submit.run()}
					busy={submit.busy}
				/>
				<View style={{ flexDirection: 'row', gap: space.xs, justifyContent: 'center' }}>
					<Text style={type.footnote}>{copy.auth.register.footerPrompt}</Text>
					<Pressable onPress={() => router.replace('/login')}>
						<Text style={{ ...type.footnote, color: color.accent, fontWeight: '600' }}>
							{copy.auth.register.footerLink}
						</Text>
					</Pressable>
				</View>
			</Screen>
		</KeyboardAvoidingView>
	);
}
