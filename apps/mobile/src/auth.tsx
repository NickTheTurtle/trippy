import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError, type User } from './lib/api';
import { setToken } from './lib/token';

/**
 * Who is signed in, for the whole app.
 *
 * The web client can ask the server on every navigation because the cookie
 * rides along for free. Here the answer is held in context and refreshed only
 * when it changes, so a tab switch does not cost a round trip on a phone
 * network.
 *
 * `loading` is a real third state: at launch there is a token in the keychain
 * but no confirmed user yet, and rendering the login screen during that window
 * would flash it at someone who is already signed in.
 */
type AuthValue = {
	user: User | null;
	loading: boolean;
	logIn: (email: string, password: string) => Promise<void>;
	register: (email: string, name: string, password: string) => Promise<void>;
	logOut: () => Promise<void>;
	refresh: () => Promise<void>;
};

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		try {
			const { user } = await api<{ user: User }>('/auth/me');
			setUser(user);
		} catch (err) {
			// A 401 is the ordinary answer for a stale token, not a failure worth
			// surfacing: it just means nobody is signed in.
			if (err instanceof ApiError && err.status === 401) await setToken(null);
			setUser(null);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const adopt = useCallback(async (res: { user: User; token?: string }) => {
		if (res.token) await setToken(res.token);
		setUser(res.user);
	}, []);

	const logIn = useCallback(
		async (email: string, password: string) => {
			await adopt(
				await api<{ user: User; token?: string }>('/auth/login', {
					method: 'POST',
					body: { email, password }
				})
			);
		},
		[adopt]
	);

	const register = useCallback(
		async (email: string, name: string, password: string) => {
			await adopt(
				await api<{ user: User; token?: string }>('/auth/register', {
					method: 'POST',
					body: { email, name, password }
				})
			);
		},
		[adopt]
	);

	const logOut = useCallback(async () => {
		// The local session is dropped whatever the server says. If the request
		// fails the user still expects to be signed out of this device.
		await api('/auth/logout', { method: 'POST' }).catch(() => {});
		await setToken(null);
		setUser(null);
	}, []);

	return (
		<Ctx.Provider value={{ user, loading, logIn, register, logOut, refresh }}>
			{children}
		</Ctx.Provider>
	);
}

export function useAuth(): AuthValue {
	const value = useContext(Ctx);
	if (!value) throw new Error('useAuth outside AuthProvider');
	return value;
}
