import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode
} from 'react';
import { api, ApiError, onUnauthorized, type User } from './lib/api';

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
	/**
	 * Resolves to `'pending'` when the server has emailed a confirmation link
	 * instead of creating the account, which is what it does whenever it has a
	 * mail provider. The caller renders the two outcomes differently, so this
	 * cannot be a void promise.
	 */
	register: (name: string, email: string, password: string) => Promise<'signed-in' | 'pending'>;
	/** Exchange a confirmation link for the account it was issued for. */
	verify: (token: string) => Promise<void>;
	logOut: () => Promise<void>;
	/** Re-read the session after the user edits their own profile, so the name in
	 *  the top bar is not stale until the next full page load. */
	refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<AuthState>({
		status: 'loading',
		user: null
	});

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

	// A request elsewhere in the app was refused for want of a session. Asked
	// again rather than taken at its word, because a 401 from a route is only a
	// strong hint: `/auth/me` is the one question whose answer is the session,
	// and asking it costs one request on a path that is already failing. Several
	// sections failing together share the one check.
	const checking = useRef(false);
	useEffect(() => {
		onUnauthorized(() => {
			if (checking.current) return;
			checking.current = true;
			api<{ user: User }>('/auth/me')
				.then(({ user }) => setState({ status: 'authenticated', user }))
				.catch((err) => {
					// Only a definite "nobody" signs this tab out. An unreachable server
					// says nothing about the session, and the page that failed is
					// already saying so.
					if (err instanceof ApiError && err.status === 401) {
						setState({ status: 'anonymous', user: null });
					}
				})
				.finally(() => {
					checking.current = false;
				});
		});
		return () => onUnauthorized(null);
	}, []);

	const logIn = useCallback(async (email: string, password: string) => {
		const { user } = await api<{ user: User }>('/auth/login', {
			method: 'POST',
			body: { email, password }
		});
		setState({ status: 'authenticated', user });
	}, []);

	const register = useCallback(async (name: string, email: string, password: string) => {
		// The browser's zone, so a new account's "today" is the reader's rather
		// than UTC's. The server ignores anything it does not recognise.
		const homeTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const res = await api<{ user?: User; pending?: boolean }>('/auth/register', {
			method: 'POST',
			body: { name, email, password, homeTz }
		});
		if (!res.user) return 'pending' as const;
		setState({ status: 'authenticated', user: res.user });
		return 'signed-in' as const;
	}, []);

	const verify = useCallback(async (token: string) => {
		const { user } = await api<{ user: User }>('/auth/verify', {
			method: 'POST',
			body: { token }
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

	const refresh = useCallback(async () => {
		try {
			const { user } = await api<{ user: User }>('/auth/me');
			setState({ status: 'authenticated', user });
		} catch {
			// A failure here means the session is gone or the server is unreachable.
			// Neither is worth surfacing from a background refresh: the next guarded
			// request will report it with the context of what the user was doing.
		}
	}, []);

	const value = useMemo(
		() => ({ ...state, logIn, register, verify, logOut, refresh }),
		[state, logIn, register, verify, logOut, refresh]
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error('useAuth must be used inside an AuthProvider');
	return ctx;
}
