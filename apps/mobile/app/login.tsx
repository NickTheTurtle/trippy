import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { copy } from '@trippy/copy';
import { useAuth } from '../src/auth';
import { useMutation } from '../src/hooks/useMutation';
import { Button, Field, InsetSection, Loading, Screen } from '../src/ui';
import { color, space, type } from '../src/theme';

export default function Login() {
	const { user, loading, logIn } = useAuth();
	const { next } = useLocalSearchParams<{ next?: string }>();
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');

	const submit = useMutation(() => logIn(email, password), {
		fallback: copy.auth.login.fallback,
		onSuccess: () => router.replace(next && next.startsWith('/') ? next : '/trips')
	});

	if (loading) return <Loading />;
	if (user) return <Redirect href="/trips" />;

	return (
		<KeyboardAvoidingView
			style={{ flex: 1 }}
			behavior={Platform.OS === 'ios' ? 'padding' : undefined}
		>
			<Screen largeTitle={copy.auth.login.title}>
				<Text style={type.subhead}>{copy.auth.login.blurb}</Text>
				<InsetSection error={submit.error}>
					<Field
						label={copy.auth.login.emailLabel}
						hideLabel
						value={email}
						onChangeText={setEmail}
						autoCapitalize="none"
						autoComplete="email"
						keyboardType="email-address"
						textContentType="emailAddress"
					/>
					<Field
						label={copy.auth.login.passwordLabel}
						hideLabel
						last
						value={password}
						onChangeText={setPassword}
						secureTextEntry
						autoComplete="current-password"
						textContentType="password"
						onSubmitEditing={() => void submit.run()}
					/>
				</InsetSection>
				<Button
					label={copy.auth.login.submitLabel}
					onPress={() => void submit.run()}
					busy={submit.busy}
				/>
				<Pressable onPress={() => router.push('/forgot')} style={{ alignSelf: 'center' }}>
					<Text style={{ ...type.footnote, color: color.accent, fontWeight: '600' }}>
						{copy.auth.forgot.link}
					</Text>
				</Pressable>
				<View style={{ flexDirection: 'row', gap: space.xs, justifyContent: 'center' }}>
					<Text style={type.footnote}>{copy.auth.login.footerPrompt}</Text>
					<Pressable onPress={() => router.push('/register')}>
						<Text style={{ ...type.footnote, color: color.accent, fontWeight: '600' }}>
							{copy.auth.login.footerLink}
						</Text>
					</Pressable>
				</View>
			</Screen>
		</KeyboardAvoidingView>
	);
}
