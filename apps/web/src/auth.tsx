import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode
} from 'react';
import { api, ApiError, type User } from './api';

/**
 * Who is signed in, for the whole app.
 *
 * SvelteKit answered this in a server load function, so every page already knew
 * the user before it rendered. A single-page client has no such moment, so the
 * app asks once on mount and shares the answer. `status` is three states rather
 * than a nullable user because "not asked yet" and "asked, nobody" must render
 * differently: collapsing them flashes the logged-out UI on every reload.
 */

type AuthState =
	| { status: 'loading'; user: null }
	| { status: 'authenticated'; user: User }
	| { status: 'anonymous'; user: null };

type AuthContextValue = AuthState & {
	logIn: (email: string, password: string) => Promise<void>;
	register: (name: string, email: string, password: string) => Promise<void>;
	logOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<AuthState>({ status: 'loading', user: null });

	useEffect(() => {
		const ac = new AbortController();

		api<{ user: User }>('/auth/me', { signal: ac.signal })
			.then(({ user }) => setState({ status: 'authenticated', user }))
			.catch((err) => {
				if (ac.signal.aborted) return;
				// A 401 here is the expected answer for a signed-out visitor, not an
				// error. Anything else is a real failure, but the honest thing to
				// render is still the signed-out app, so the state is the same.
				if (!(err instanceof ApiError) || err.status !== 401) {
					console.error('Could not restore the session', err);
				}
				setState({ status: 'anonymous', user: null });
			});

		return () => ac.abort();
	}, []);

	const logIn = useCallback(async (email: string, password: string) => {
		const { user } = await api<{ user: User }>('/auth/login', {
			method: 'POST',
			body: { email, password }
		});
		setState({ status: 'authenticated', user });
	}, []);

	const register = useCallback(async (name: string, email: string, password: string) => {
		const { user } = await api<{ user: User }>('/auth/register', {
			method: 'POST',
			body: { name, email, password }
		});
		setState({ status: 'authenticated', user });
	}, []);

	const logOut = useCallback(async () => {
		try {
			await api('/auth/logout', { method: 'POST' });
		} finally {
			// Whether or not the server could be reached, this browser is now signed
			// out. Leaving the user in place on a failed request would show a session
			// that no longer works.
			setState({ status: 'anonymous', user: null });
		}
	}, []);

	const value = useMemo(
		() => ({ ...state, logIn, register, logOut }),
		[state, logIn, register, logOut]
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error('useAuth must be used inside an AuthProvider');
	return ctx;
}
