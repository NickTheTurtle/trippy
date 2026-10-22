import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { copy } from '@trippy/copy';
import { useAuth } from '../src/auth';
import { useMutation } from '../src/hooks/useMutation';
import type { ProviderFlow } from '../src/lib/oauth';
import { Button, Field, InsetSection, Loading, Screen } from '../src/ui';
import { AuthProviders } from '../src/ui/AuthProviders';
import { color, space, type } from '../src/theme';

export default function Login() {
	const { user, loading, logIn, signInWith } = useAuth();
	const { next } = useLocalSearchParams<{ next?: string }>();
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const done = () => router.replace(next && next.startsWith('/') ? next : '/trips');

	const submit = useMutation(() => logIn(email, password), {
		fallback: copy.auth.login.fallback,
		onSuccess: done
	});
	const provider = useMutation((flow: ProviderFlow) => signInWith(flow), {
		fallback: copy.auth.providers.fallback,
		onSuccess: (signedIn) => {
			if (signedIn) done();
		}
	});
	// One error slot for both ways in: starting either clears the other's.
	const logInWithEmail = () => {
		provider.reset();
		void submit.run();
	};

	if (loading) return <Loading />;
	if (user) return <Redirect href="/trips" />;

	return (
		<KeyboardAvoidingView
			style={{ flex: 1 }}
			behavior={Platform.OS === 'ios' ? 'padding' : undefined}
		>
			<Screen safeTop largeTitle={copy.auth.login.title}>
				<AuthProviders
					busy={provider.busy || submit.busy}
					onSignIn={(flow) => {
						submit.reset();
						void provider.run(flow);
					}}
				/>
				<InsetSection error={submit.error || provider.error}>
					<Field
						variant="row"
						label={copy.auth.login.emailLabel}
						value={email}
						onChangeText={setEmail}
						autoCapitalize="none"
						autoComplete="email"
						keyboardType="email-address"
						textContentType="emailAddress"
					/>
					<Field
						variant="row"
						label={copy.auth.login.passwordLabel}
						last
						value={password}
						onChangeText={setPassword}
						secureTextEntry
						autoComplete="current-password"
						textContentType="password"
						onSubmitEditing={logInWithEmail}
					/>
				</InsetSection>
				<Button label={copy.auth.login.submitLabel} onPress={logInWithEmail} busy={submit.busy} />
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
