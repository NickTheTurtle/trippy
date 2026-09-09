import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

/**
 * Loads one GET endpoint and re-loads on demand.
 *
 * SvelteKit had `load` plus `invalidateAll()`. The React equivalent has to be
 * explicit, so `reload` is returned rather than hidden: after a mutation the
 * caller decides when the section is refetched.
 *
 * `status` is separate from `data` so a reload keeps showing the previous
 * content instead of blanking the page, which is what makes an edit-then-save
 * cycle feel like an update rather than a navigation.
 */
export type Loadable<T> = {
	data: T | null;
	error: string | null;
	loading: boolean;
	reload: () => void;
};

export function useApi<T>(path: string | null): Loadable<T> {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(path !== null);
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		if (path === null) return;
		const ac = new AbortController();
		setLoading(true);

		api<T>(path, { signal: ac.signal })
			.then((d) => {
				setData(d);
				setError(null);
			})
			.catch((err) => {
				// An abort means this request was superseded, so its outcome is not
				// news. Reporting it would overwrite the newer request's state.
				if (ac.signal.aborted) return;
				setError(err instanceof ApiError ? err.message : 'Could not load this page.');
			})
			.finally(() => {
				if (!ac.signal.aborted) setLoading(false);
			});

		return () => ac.abort();
	}, [path, nonce]);

	const reload = useCallback(() => setNonce((n) => n + 1), []);

	return { data, error, loading, reload };
}
