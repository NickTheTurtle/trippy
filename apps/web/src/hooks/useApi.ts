import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { copy } from '../copy';

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
	/**
	 * The HTTP status of the failure in `error`, or 0 when the server was never
	 * reached. Null while there is no error. A caller needs this to tell "this
	 * is gone" (404) from "try again" (a 500, a dropped connection): only the
	 * first is a fact about the thing, and only the second is worth a retry.
	 */
	errorStatus: number | null;
	loading: boolean;
	reload: () => void;
};

export function useApi<T>(path: string | null): Loadable<T> {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [errorStatus, setErrorStatus] = useState<number | null>(null);
	const [loading, setLoading] = useState(path !== null);
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		if (path === null) return;
		const ac = new AbortController();
		setLoading(true);

		// The request is started a microtask late, and that is deliberate.
		//
		// React's StrictMode mounts every component twice in development: it runs
		// the effect, runs its cleanup, then runs the effect again, all in one
		// synchronous commit. Started inline, the first pass therefore put a real
		// request on the wire and the cleanup immediately aborted it, so every
		// navigation printed a red `net::ERR_ABORTED` line per section and sent
		// each GET twice. Both are harmless and both are noise, and noise is what
		// a genuine error hides in: it made a recent audit of this app slower.
		//
		// Deferring by a microtask lets that discarded first pass be cancelled
		// before it ever reaches the network, because the flush happens after the
		// commit. Nothing else changes: a request that has actually started is
		// still aborted the moment its path is superseded, which is a real
		// cancellation and still worth doing.
		queueMicrotask(() => {
			if (ac.signal.aborted) return;

			api<T>(path, { signal: ac.signal })
				.then((d) => {
					setData(d);
					setError(null);
					setErrorStatus(null);
				})
				.catch((err) => {
					// An abort means this request was superseded, so its outcome is not
					// news. Reporting it would overwrite the newer request's state.
					if (ac.signal.aborted) return;
					setError(err instanceof ApiError ? err.message : copy.api.loadFailed);
					setErrorStatus(err instanceof ApiError ? err.status : 0);
				})
				.finally(() => {
					if (!ac.signal.aborted) setLoading(false);
				});
		});

		return () => ac.abort();
	}, [path, nonce]);

	const reload = useCallback(() => setNonce((n) => n + 1), []);

	return { data, error, errorStatus, loading, reload };
}
