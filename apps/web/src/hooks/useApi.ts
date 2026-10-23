import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
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

/**
 * Responses asked for ahead of the page that will want them, by path.
 *
 * Short-lived and taken once: a page that navigates to a path within
 * `WARM_MS` of `prefetch` for it gets the request already on the wire (or
 * already answered) instead of starting one; anything older is refetched, and
 * a reload of the path a page is already on never reads from here.
 */
const warm = new Map<string, { at: number; p: Promise<unknown> }>();
const WARM_MS = 3000;

/** Start loading `path` now, for a `useApi` that is about to be pointed at it. */
export function prefetch(path: string): void {
	const hit = warm.get(path);
	if (hit && Date.now() - hit.at < WARM_MS) return;
	const p = api(path);
	// Read later, or never; a failure is the later load's to report.
	p.catch(() => {});
	warm.set(path, { at: Date.now(), p });
}

function takeWarm<T>(path: string): Promise<T> | null {
	const hit = warm.get(path);
	if (!hit) return null;
	warm.delete(path);
	return Date.now() - hit.at < WARM_MS ? (hit.p as Promise<T>) : null;
}

export function useApi<T>(
	path: string | null,
	opts: {
		/**
		 * Land each response as a React transition. Rendering a large page for a
		 * new payload then yields to input every few milliseconds rather than
		 * holding the main thread for the whole of it, and the previous data
		 * stays on screen until the new render is ready. For a page whose fetches
		 * follow a gesture that may still be going on (the schedule's day strip).
		 */
		transition?: boolean;
		/**
		 * Decide when a response is put on screen. Called with the update and the
		 * path it answers; the caller runs it now, later, or not at all. The
		 * schedule holds one that arrives while its strip is moving, since drawing
		 * a payload mid-slide is exactly the frame that stutters. An update that
		 * is run after its path has been superseded does nothing.
		 */
		gate?: (apply: () => void, path: string) => void;
	} = {}
): Loadable<T> {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [errorStatus, setErrorStatus] = useState<number | null>(null);
	const [loading, setLoading] = useState(path !== null);
	const [nonce, setNonce] = useState(0);
	const transition = opts.transition ?? false;
	const gate = useRef(opts.gate);
	gate.current = opts.gate;
	/** The path the last load was for, so only a change of path reads a prefetch. */
	const loaded = useRef<string | null>(null);

	useEffect(() => {
		if (path === null) return;
		const ac = new AbortController();
		const moved = loaded.current !== path;
		loaded.current = path;
		// Every update this hook makes re-renders its caller, so in transition
		// mode they all go together: an urgent `loading` flip on its own would be
		// a full synchronous render of the old data, which is the cost avoided.
		const land = transition ? startTransition : (fn: () => void) => fn();
		land(() => setLoading(true));
		/** Put an outcome on screen, when the caller's gate says so. */
		const settle = (update: () => void) => {
			const apply = () => {
				if (ac.signal.aborted) return;
				land(() => {
					update();
					setLoading(false);
				});
			};
			if (gate.current) gate.current(apply, path);
			else apply();
		};

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

			const ahead = moved ? takeWarm<T>(path) : null;
			(ahead ?? api<T>(path, { signal: ac.signal }))
				.then((d) => {
					if (ac.signal.aborted) return;
					settle(() => {
						setData(d);
						setError(null);
						setErrorStatus(null);
					});
				})
				.catch((err) => {
					// An abort means this request was superseded, so its outcome is not
					// news. Reporting it would overwrite the newer request's state.
					if (ac.signal.aborted) return;
					settle(() => {
						setError(err instanceof ApiError ? err.message : copy.api.loadFailed);
						setErrorStatus(err instanceof ApiError ? err.status : 0);
					});
				});
		});

		return () => ac.abort();
	}, [path, nonce, transition]);

	const reload = useCallback(() => {
		// A day asked for ahead may have changed with whatever made this reload.
		warm.clear();
		setNonce((n) => n + 1);
	}, []);

	return { data, error, errorStatus, loading, reload };
}
