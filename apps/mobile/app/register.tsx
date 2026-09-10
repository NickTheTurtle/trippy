import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { copy } from '@trippy/copy';
import { useAuth } from '../src/auth';
import { useMutation } from '../src/hooks/useMutation';
import { Button, Field, FormError, Loading, Screen } from '../src/ui';
import { color, space, type } from '../src/theme';

export default function Register() {
	const { user, loading, register } = useAuth();
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');

	const submit = useMutation(() => register(email, name, password), {
		fallback: copy.auth.register.fallback,
		onSuccess: () => router.replace('/trips')
	});

	if (loading) return <Loading />;
	if (user) return <Redirect href="/trips" />;

	return (
		<KeyboardAvoidingView
			style={{ flex: 1 }}
			behavior={Platform.OS === 'ios' ? 'padding' : undefined}
		>
			<Screen>
				<View style={{ gap: space.xs }}>
					<Text style={type.title}>{copy.auth.register.title}</Text>
					<Text style={type.small}>{copy.auth.register.blurb}</Text>
				</View>

				<View style={{ gap: space.md }}>
					<Field
						label={copy.auth.register.nameLabel}
						value={name}
						onChangeText={setName}
						autoComplete="name"
						textContentType="name"
					/>
					<Field
						label={copy.auth.register.emailLabel}
						value={email}
						onChangeText={setEmail}
						autoCapitalize="none"
						autoComplete="email"
						keyboardType="email-address"
						textContentType="emailAddress"
					/>
					<Field
						label={copy.auth.register.passwordLabel}
						value={password}
						onChangeText={setPassword}
						secureTextEntry
						autoComplete="new-password"
						textContentType="newPassword"
						placeholder={copy.auth.register.passwordHint}
					/>
					<FormError message={submit.error} />
					<Button
						label={copy.auth.register.submitLabel}
						onPress={() => void submit.run()}
						busy={submit.busy}
					/>
				</View>

				<View style={{ flexDirection: 'row', gap: space.xs, justifyContent: 'center' }}>
					<Text style={type.small}>{copy.auth.register.footerPrompt}</Text>
					<Pressable onPress={() => router.replace('/login')}>
						<Text style={{ ...type.small, color: color.accent, fontWeight: '600' }}>
							{copy.auth.register.footerLink}
						</Text>
					</Pressable>
				</View>
			</Screen>
		</KeyboardAvoidingView>
	);
}
