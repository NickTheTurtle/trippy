import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { copy } from '@trippy/copy';
import { useAuth } from '../src/auth';
import { api } from '../src/lib/api';
import { useMutation } from '../src/hooks/useMutation';
import { Button, Field, FormError, Loading, Screen } from '../src/ui';
import { color, space, type } from '../src/theme';

export default function Forgot() {
	const { user, loading } = useAuth();
	const [email, setEmail] = useState('');
	const [sent, setSent] = useState(false);
	const submit = useMutation(() => api('/auth/forgot', { method: 'POST', body: { email } }), {
		fallback: copy.auth.forgot.fallback,
		onSuccess: () => setSent(true)
	});

	if (loading) return <Loading />;
	if (user) return <Redirect href="/trips" />;
	if (sent) {
		return (
			<Screen>
				<Text style={type.title}>{copy.auth.forgot.sentTitle}</Text>
				<Text style={type.small}>{copy.auth.forgot.sentBlurb}</Text>
				<Button label={copy.auth.forgot.footerLink} onPress={() => router.replace('/login')} />
			</Screen>
		);
	}

	return (
		<KeyboardAvoidingView
			style={{ flex: 1 }}
			behavior={Platform.OS === 'ios' ? 'padding' : undefined}
		>
			<Screen>
				<View style={{ gap: space.xs }}>
					<Text style={type.title}>{copy.auth.forgot.title}</Text>
					<Text style={type.small}>{copy.auth.forgot.blurb}</Text>
				</View>
				<View style={{ gap: space.md }}>
					<Field
						label={copy.auth.forgot.emailLabel}
						value={email}
						onChangeText={setEmail}
						autoCapitalize="none"
						autoComplete="email"
						keyboardType="email-address"
						textContentType="emailAddress"
					/>
					<FormError message={submit.error} />
					<Button
						label={copy.auth.forgot.submitLabel}
						onPress={() => void submit.run()}
						busy={submit.busy}
					/>
				</View>
				<View style={{ flexDirection: 'row', gap: space.xs, justifyContent: 'center' }}>
					<Text style={type.small}>{copy.auth.forgot.footerPrompt}</Text>
					<Pressable onPress={() => router.replace('/login')}>
						<Text style={{ ...type.small, color: color.accent, fontWeight: '600' }}>
							{copy.auth.forgot.footerLink}
						</Text>
					</Pressable>
				</View>
			</Screen>
		</KeyboardAvoidingView>
	);
}
