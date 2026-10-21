import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, isAbort } from '../lib/api';
import { copy } from '@trippy/copy';

/**
 * The mobile twin of the web app's useApi. Same contract, so a screen ported
 * across keeps its loading and error behaviour: `status` is separate from
 * `data` so a reload keeps showing the previous content rather than blanking
 * the screen.
 */
export type Loadable<T> = {
	data: T | null;
	error: string | null;
	errorStatus: number | null;
	loading: boolean;
	reload: () => void;
};

export function useApi<T>(path: string | null): Loadable<T> {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(path !== null);
	const [errorStatus, setErrorStatus] = useState<number | null>(null);
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		if (path === null) return;
		const ac = new AbortController();
		setLoading(true);

		api<T>(path, { signal: ac.signal })
			.then((d) => {
				// A request replaced by a newer one (a reload on top of a reload)
				// can be aborted while its body is read, which `api()` used to
				// return as null. Stored, that blanked the screen to its loading
				// state until the newer answer arrived.
				if (ac.signal.aborted) return;
				setData(d);
				setError(null);
				setErrorStatus(null);
			})
			.catch((err) => {
				if (ac.signal.aborted || isAbort(err)) return;
				setError(err instanceof ApiError ? err.message : copy.api.loadFailed);
				setErrorStatus(err instanceof ApiError ? err.status : null);
			})
			.finally(() => {
				if (!ac.signal.aborted) setLoading(false);
			});

		return () => ac.abort();
	}, [path, nonce]);

	const reload = useCallback(() => setNonce((n) => n + 1), []);

	return { data, error, errorStatus, loading, reload };
}
