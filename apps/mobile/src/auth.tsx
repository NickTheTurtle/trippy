import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { router, usePathname } from 'expo-router';
import { api, ApiError, onUnauthorized, type User } from './lib/api';
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
	register: (name: string, email: string, password: string) => Promise<'signed-in' | 'pending'>;
	logOut: () => Promise<void>;
	refresh: () => Promise<void>;
};

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);
	const pathname = usePathname();

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

	const checking = useRef(false);
	useEffect(() => {
		onUnauthorized(() => {
			if (checking.current) return;
			checking.current = true;
			api<{ user: User }>('/auth/me')
				.then(({ user }) => setUser(user))
				.catch((err) => {
					if (err instanceof ApiError && err.status === 401) {
						void setToken(null);
						setUser(null);
						router.replace({
							pathname: '/login',
							params: pathname && pathname !== '/login' ? { next: pathname } : undefined
						});
					}
				})
				.finally(() => {
					checking.current = false;
				});
		});
		return () => onUnauthorized(null);
	}, [pathname]);

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
		async (name: string, email: string, password: string) => {
			const homeTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
			const res = await api<{ user?: User; token?: string; pending?: boolean; email?: string }>(
				'/auth/register',
				{
					method: 'POST',
					body: { name, email, password, homeTz }
				}
			);
			if (!res.user) return 'pending' as const;
			await adopt({ user: res.user, token: res.token });
			return 'signed-in' as const;
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
