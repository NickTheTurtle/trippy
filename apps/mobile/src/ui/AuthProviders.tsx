import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import Svg, { Path } from 'react-native-svg';
import { copy } from '@trippy/copy';
import {
	appleNativeAvailable,
	knownProviders,
	loadProviders,
	type AuthProviders as Providers,
	type ProviderFlow
} from '../lib/oauth';
import { color, hairline, radius, space, type } from '../theme';
import { AppSymbol } from './Symbol';

const HEIGHT = 50;

/**
 * Continue with Apple and Continue with Google, above the email form on Log in
 * and Create account, then a divider into that form. Draws nothing until the
 * server has said which providers it has keys for, and nothing at all when it
 * has none, so those screens stay exactly as they were.
 *
 * On an iPhone, Apple is Apple's own button, which also brings the system
 * sheet. Elsewhere it is drawn to match it (black, the white logo) and runs the
 * browser flow, as Google does everywhere.
 */
export function AuthProviders({
	busy,
	onSignIn
}: {
	busy: boolean;
	onSignIn: (flow: ProviderFlow) => void;
}) {
	const [providers, setProviders] = useState<Providers | null>(knownProviders);
	// Unknown until asked; only an iPhone can say yes.
	const [nativeApple, setNativeApple] = useState<boolean | null>(
		Platform.OS === 'ios' ? null : false
	);
	const [pending, setPending] = useState<ProviderFlow | null>(null);

	useEffect(() => {
		let live = true;
		void loadProviders().then((p) => live && setProviders(p));
		if (Platform.OS === 'ios') void appleNativeAvailable().then((ok) => live && setNativeApple(ok));
		return () => {
			live = false;
		};
	}, []);

	// Both answers before anything is drawn, so Apple does not arrive above
	// Google a moment later and push it down.
	if (!providers || nativeApple === null) return null;
	const appleNative = providers.appleNative && nativeApple;
	const appleBrowser = providers.apple && !appleNative;
	if (!appleNative && !appleBrowser && !providers.google) return null;

	const start = (flow: ProviderFlow) => {
		if (busy) return;
		setPending(flow);
		onSignIn(flow);
	};
	const spinning = (flow: ProviderFlow) => busy && pending === flow;

	return (
		<View style={{ gap: space.md }}>
			{appleNative ? (
				<View
					style={{ opacity: busy ? 0.5 : 1 }}
					pointerEvents={busy ? 'none' : 'auto'}
					accessibilityState={{ busy: spinning('apple-native') }}
				>
					<AppleAuthentication.AppleAuthenticationButton
						buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
						buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
						cornerRadius={radius.section}
						style={{ width: '100%', height: HEIGHT }}
						onPress={() => start('apple-native')}
					/>
				</View>
			) : appleBrowser ? (
				<ProviderButton
					label={copy.auth.providers.apple}
					dark
					busy={spinning('apple')}
					disabled={busy}
					onPress={() => start('apple')}
					mark={<AppSymbol name="apple.logo" fallback="logo-apple" size={19} color="#fff" />}
				/>
			) : null}
			{providers.google ? (
				<ProviderButton
					label={copy.auth.providers.google}
					busy={spinning('google')}
					disabled={busy}
					onPress={() => start('google')}
					mark={<GoogleMark />}
				/>
			) : null}
			<View style={s.divider} accessibilityRole="none">
				<View style={s.rule} />
				<Text style={s.or}>{copy.auth.providers.divider}</Text>
				<View style={s.rule} />
			</View>
		</View>
	);
}

function ProviderButton({
	label,
	mark,
	dark = false,
	busy,
	disabled,
	onPress
}: {
	label: string;
	mark: ReactNode;
	dark?: boolean;
	busy: boolean;
	disabled: boolean;
	onPress: () => void;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityState={{ disabled, busy }}
			onPress={disabled ? undefined : onPress}
			style={({ pressed }) => [
				s.button,
				dark ? s.dark : s.light,
				{ opacity: disabled && !busy ? 0.5 : pressed ? 0.72 : 1 }
			]}
		>
			{busy ? (
				<ActivityIndicator color={dark ? '#fff' : color.inkSoft} size="small" />
			) : (
				<>
					{mark}
					<Text style={[s.label, { color: dark ? '#fff' : color.ink }]} numberOfLines={1}>
						{label}
					</Text>
				</>
			)}
		</Pressable>
	);
}

/** Google's four-colour G, from its sign-in branding, at 18pt. */
function GoogleMark() {
	return (
		<Svg width={18} height={18} viewBox="0 0 48 48">
			<Path
				fill="#EA4335"
				d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
			/>
			<Path
				fill="#4285F4"
				d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
			/>
			<Path
				fill="#FBBC05"
				d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
			/>
			<Path
				fill="#34A853"
				d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
			/>
		</Svg>
	);
}

const s = StyleSheet.create({
	button: {
		minHeight: HEIGHT,
		borderRadius: radius.section,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: space.sm,
		paddingHorizontal: space.lg
	},
	light: {
		backgroundColor: color.surface,
		borderWidth: hairline,
		borderColor: color.inkFaint
	},
	dark: { backgroundColor: '#000' },
	label: { fontSize: 17, fontWeight: '600' },
	divider: { flexDirection: 'row', alignItems: 'center', gap: space.md },
	rule: { flex: 1, height: hairline, backgroundColor: color.line },
	or: { ...type.footnote, color: color.inkFaint }
});
