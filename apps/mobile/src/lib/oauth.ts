import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { copy, providerError } from '@trippy/copy';
import { api, API_BASE, type User } from './api';

/**
 * Sign in with Google or Apple, the native half.
 *
 * Two flows end in the same `{ user, token }` that `/auth/login` returns, so
 * the session is adopted exactly as an email login's is.
 *
 * On an iPhone, Apple is the system sheet (`expo-apple-authentication`): Face
 * ID, no browser, and the identity token is checked by the server against a
 * nonce it issued. Everything else, Google everywhere and Apple off iOS, is the
 * provider's web page in an auth session (`expo-web-browser`): the server runs
 * the OAuth dance and hands back to the app's own link with a one-time code,
 * which is traded for the session here. The code, not the token, is what
 * travels in the URL, so a token never sits in browser history or a log.
 */

export type AuthProviders = { google: boolean; apple: boolean; appleNative: boolean };
export type ProviderFlow = 'google' | 'apple' | 'apple-native';
type Session = { user: User; token?: string };

const NONE: AuthProviders = { google: false, apple: false, appleNative: false };
let known: AuthProviders | null = null;

/**
 * Which providers the server has keys for. Remembered once answered, so going
 * from Log in to Create account does not redraw the buttons in; a failure is
 * not remembered, and reads as none, which leaves the email form as it was.
 */
export async function loadProviders(): Promise<AuthProviders> {
	if (known) return known;
	try {
		const res = await api<Partial<AuthProviders>>('/auth/providers');
		known = {
			google: res?.google === true,
			apple: res?.apple === true,
			appleNative: res?.appleNative === true
		};
		return known;
	} catch {
		return NONE;
	}
}

export function knownProviders(): AuthProviders | null {
	return known;
}

/** Whether this device can show the system Sign in with Apple sheet. */
export async function appleNativeAvailable(): Promise<boolean> {
	if (Platform.OS !== 'ios') return false;
	return AppleAuthentication.isAvailableAsync().catch(() => false);
}

const failed = () => new Error(copy.auth.providers.fallback);

/** Resolves to null when the user cancels, which is not an error worth showing. */
export async function signInWithAppleNative(): Promise<Session | null> {
	const { nonce } = await api<{ nonce: string }>('/auth/apple/nonce', { method: 'POST' });
	let credential: AppleAuthentication.AppleAuthenticationCredential;
	try {
		credential = await AppleAuthentication.signInAsync({
			requestedScopes: [
				AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
				AppleAuthentication.AppleAuthenticationScope.EMAIL
			],
			nonce
		});
	} catch (err) {
		if ((err as { code?: string } | null)?.code === 'ERR_REQUEST_CANCELED') return null;
		throw failed();
	}
	if (!credential.identityToken) throw failed();
	// Apple sends the name only on the first sign-in with this app; after that
	// it is null and the server keeps the one it has.
	const name =
		[credential.fullName?.givenName, credential.fullName?.familyName]
			.map((part) => part?.trim())
			.filter(Boolean)
			.join(' ') || null;
	// The phone's zone, so an account created here starts on it, as the
	// browser flow's `tz` and the email form's `homeTz` already do.
	const homeTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return api<Session>('/auth/apple/native', {
		method: 'POST',
		body: { identityToken: credential.identityToken, nonce, name, homeTz }
	});
}

/**
 * The provider's page in an auth session. Nothing may be awaited before the
 * session opens: on web it is a popup, which a browser allows only straight
 * from the tap.
 */
export async function signInWithBrowser(provider: 'google' | 'apple'): Promise<Session | null> {
	const returnUrl = Linking.createURL('auth');
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const start =
		`${API_BASE}/api/auth/${provider}/start?client=native` +
		`&redirect=${encodeURIComponent(returnUrl)}&tz=${encodeURIComponent(zone)}`;
	let result: WebBrowser.WebBrowserAuthSessionResult;
	try {
		result = await WebBrowser.openAuthSessionAsync(start, returnUrl);
	} catch {
		throw failed();
	}
	if (result.type !== 'success') return null;
	const { queryParams } = Linking.parse(result.url);
	const code = typeof queryParams?.code === 'string' ? queryParams.code : '';
	if (code) return api<Session>('/auth/exchange', { method: 'POST', body: { code } });
	const error = typeof queryParams?.error === 'string' ? queryParams.error : '';
	// A code, mapped to our own sentence; anything else reads as a plain failure.
	if (error) throw new Error(providerError(error));
	// Cancel at the provider's own page comes back as the bare return URL, no
	// code and no error: as silent as closing the browser sheet.
	return null;
}
