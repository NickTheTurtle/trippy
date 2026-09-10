import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * The session token, held in the platform keychain.
 *
 * It is cached in memory as well, because `api()` reads it on every request and
 * a keychain round trip per call would be a needless cost on a list screen that
 * fires several at once.
 *
 * SecureStore has no web implementation and throws if called there. The web
 * build only exists as a preview of the native app, so it falls back to
 * localStorage: not a keychain, but the same exposure the web client already
 * lives with, and it keeps the preview signed in across a reload.
 */
const KEY = 'trippy.session';

let cached: string | null | undefined;

const web = Platform.OS === 'web';

export async function getToken(): Promise<string | null> {
	if (cached !== undefined) return cached;
	cached = web
		? (globalThis.localStorage?.getItem(KEY) ?? null)
		: await SecureStore.getItemAsync(KEY).catch(() => null);
	return cached;
}

export async function setToken(token: string | null): Promise<void> {
	cached = token;
	if (web) {
		if (token) globalThis.localStorage?.setItem(KEY, token);
		else globalThis.localStorage?.removeItem(KEY);
		return;
	}
	if (token) await SecureStore.setItemAsync(KEY, token);
	else await SecureStore.deleteItemAsync(KEY).catch(() => {});
}
