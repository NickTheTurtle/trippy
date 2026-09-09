import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState
} from 'react';

/**
 * Live trip updates: the browser half of the SSE bus in `@trippy/server/events`.
 *
 * # What arrives, and what this does with it
 *
 * An event names a trip and a section and carries no rows. So nothing here
 * merges a payload into local state; it calls the `reload` a section already
 * has. The alternative, patching rows in the client, means a second copy of
 * every rule the server owns (how a split rounds, how a vote count is derived,
 * how travel legs are recomputed) and those copies fail silently: nothing
 * errors, the numbers are just wrong for whoever left the tab open longest.
 *
 * # One stream per open trip
 *
 * The `EventSource` belongs to `TripShell`, not to each page, so switching tabs
 * inside a trip does not churn connections and a trip switch closes the old
 * stream before opening the new one. Sections attach with `useLiveSection`,
 * which is a subscription to this one stream rather than a second one.
 *
 * # Reconnection, deliberately bounded
 *
 * `EventSource` cannot see the HTTP status: 401, 404 and 503 all arrive as a
 * bare `onerror`. It also retries by itself, forever, which against a stream
 * that now answers 404 is a retry storm with no end. So:
 *
 *  - a drop where the browser will retry by itself (`readyState === CONNECTING`)
 *    is left to the browser for the first few attempts. Its retry carries
 *    `Last-Event-ID`, which is the only way to get an exact replay of what was
 *    missed, and the server answers a resume it cannot account for with `reset`;
 *  - once those are exhausted, or when the browser gives up on its own
 *    (`readyState === CLOSED`, which is what a non-200 produces), this takes
 *    over with its own backoff, and after a fixed number of attempts it stops
 *    and says so. It never retries indefinitely. Both budgets are refilled
 *    only by a connection that stayed up (`STABLE_MS`), never by one that was
 *    merely accepted: an endpoint that answers 200 and hangs up immediately
 *    must run out too;
 *  - `event: closed` with reason `revoked` is terminal: the stream is closed and
 *    nothing is retried, because the trip is no longer readable and every retry
 *    would be a 404.
 *
 * A reconnection this module opens itself cannot send `Last-Event-ID`, so it
 * cannot know what it missed. Every reconnect therefore invalidates everything,
 * which is the same conclusion the server reaches when it sends `reset`.
 */

export const TRIP_TOPICS = [
	'trip',
	'members',
	'schedule',
	'pois',
	'lodging',
	'expenses',
	'tasks',
	'costs'
] as const;

export type TripTopic = (typeof TRIP_TOPICS)[number];

/**
 * - `connecting` no stream yet, and nothing has failed.
 * - `live`       attached.
 * - `retrying`   dropped, still trying. Deliberately invisible to the user: a
 *                stream dropping and coming back is ordinary.
 * - `off`        gave up, or access was revoked. The only state worth a word on
 *                screen, because from here the page will not update itself.
 */
export type LiveStatus = 'connecting' | 'live' | 'retrying' | 'off';

export type TripEvents = {
	status: LiveStatus;
	/** Attach a section. Returns the detach, for the effect cleanup. */
	subscribe: (topics: readonly TripTopic[], invalidate: () => void) => () => void;
	/** Start over after giving up. For a "try again" affordance. */
	retry: () => void;
};

/** How many times the browser's own reconnect (which resumes) is allowed first. */
const BROWSER_RETRIES = 3;
/** Our own attempts after that, then we stop. */
const MAX_ATTEMPTS = 6;
/** Backoff for our attempts, ms. The last value repeats until the cap is hit. */
const BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];
/** Uptime that makes a stream count as healthy, refilling both budgets above. */
const STABLE_MS = 20000;
/** Burst window. A save that touches three sections should be one refetch each, not three. */
const COALESCE_MS = 120;
/** How often to re-check whether the user has stopped typing. */
const BUSY_POLL_MS = 500;

/**
 * Is the user in the middle of something a refetch would wreck?
 *
 * This is the failure mode that makes live updates hateful: a refetch lands
 * while a dialog is open or a field is focused, the section re-renders, and the
 * half-typed thing is gone. Invalidations are held until this is false, which
 * costs the reader nothing (they are looking at their own form, not at the
 * list behind it) and is never lost, only deferred.
 *
 * Buttons and links do not count. Only an open dialog and an actual editing
 * control do.
 */
function userIsBusy(): boolean {
	if (document.querySelector('dialog[open]')) return true;
	const el = document.activeElement;
	if (!el || el === document.body) return false;
	return el.matches(
		'input:not([type="button"]):not([type="submit"]), textarea, select, [contenteditable=""], [contenteditable="true"]'
	);
}

type Listener = { topics: ReadonlySet<TripTopic | '*'>; invalidate: () => void };

/**
 * Opens and owns one stream for `tripId`. Pass `null` where there is no trip
 * (the landing, login, the trips list, the account page) and nothing is opened.
 */
export function useTripEvents(tripId: string | null): TripEvents {
	const [status, setStatus] = useState<LiveStatus>(tripId ? 'connecting' : 'off');
	const [generation, setGeneration] = useState(0);
	const listeners = useRef<Set<Listener>>(new Set());

	// The coalescing/deferral queue, shared by every section on the page.
	const pending = useRef<Set<() => void>>(new Set());
	const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const flush = useCallback(() => {
		if (userIsBusy()) {
			flushTimer.current = setTimeout(flush, BUSY_POLL_MS);
			return;
		}
		flushTimer.current = null;
		const due = [...pending.current];
		pending.current.clear();
		for (const fn of due) fn();
	}, []);

	const dispatch = useCallback(
		(topic: TripTopic | '*') => {
			for (const l of listeners.current) {
				if (topic === '*' || l.topics.has(topic) || l.topics.has('*')) {
					pending.current.add(l.invalidate);
				}
			}
			if (pending.current.size && flushTimer.current === null) {
				flushTimer.current = setTimeout(flush, COALESCE_MS);
			}
		},
		[flush]
	);

	useEffect(() => {
		if (!tripId) {
			setStatus('off');
			return;
		}

		let es: EventSource | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let browserRetries = 0;
		let attempts = 0;
		let openedAt = 0;
		let connectedBefore = false;
		let stopped = false;

		const teardown = () => {
			if (timer) clearTimeout(timer);
			timer = null;
			// Explicit: an EventSource left to be garbage collected keeps the socket,
			// and the server's per-trip subscriber slot, until it is.
			es?.close();
			es = null;
		};

		/**
		 * Did the connection that just dropped prove the endpoint actually works?
		 *
		 * This is the *only* thing that refills either retry budget, and both are
		 * refilled together, because a drop is a drop whoever is going to redial.
		 * Being accepted is not proof: an endpoint that answers 200 and then drops
		 * the stream at once (a proxy killing the response, a load balancer hanging
		 * up after the status line, a stream that dies before its first keepalive)
		 * would otherwise look healthy on every `onopen` while delivering nothing,
		 * and reconnecting on that forever is the one thing this module promises
		 * not to do. Only uptime counts.
		 */
		const provedItself = () => openedAt !== 0 && Date.now() - openedAt > STABLE_MS;

		/** Terminal. No further attempts, by design. */
		const giveUp = () => {
			stopped = true;
			teardown();
			setStatus('off');
		};

		const scheduleRetry = () => {
			teardown();
			if (attempts >= MAX_ATTEMPTS) {
				giveUp();
				return;
			}
			const base = BACKOFF[Math.min(attempts, BACKOFF.length - 1)];
			attempts++;
			setStatus('retrying');
			// Jitter, so several tabs that dropped together do not come back in step.
			timer = setTimeout(connect, base * (0.8 + Math.random() * 0.4));
		};

		function connect(): void {
			if (stopped) return;
			const source = new EventSource(`/api/trips/${tripId}/events`);
			es = source;

			source.onopen = () => {
				// Just the clock. Neither budget is refilled here: see `provedItself`.
				openedAt = Date.now();
				setStatus('live');
				// Anything could have happened while this was down, and a stream we
				// opened ourselves carries no resume point, so assume the worst.
				if (connectedBefore) dispatch('*');
				connectedBefore = true;
			};

			for (const topic of TRIP_TOPICS) {
				source.addEventListener(topic, () => dispatch(topic));
			}

			// "Your resume point is unaccountable." Not a failure: the correct
			// response is a full reload, quietly.
			source.addEventListener('reset', () => dispatch('*'));

			source.addEventListener('closed', (e) => {
				const reason = readReason((e as MessageEvent).data);
				if (reason === 'revoked') {
					// Access is gone. Retrying would poll a 404 forever; reloading the
					// sections is what makes the page say so.
					giveUp();
					dispatch('*');
					return;
				}
				// The server is going away or lost this listener. Recoverable, so it
				// goes through the same bounded backoff as any other drop.
				scheduleRetry();
			});

			source.onerror = () => {
				if (stopped) return;
				// A connection that stayed up is evidence the endpoint works; the next
				// drop should start from the top of the backoff, not the bottom.
				if (provedItself()) {
					attempts = 0;
					browserRetries = 0;
				}
				openedAt = 0;
				if (source.readyState === EventSource.CONNECTING && browserRetries < BROWSER_RETRIES) {
					// The browser is retrying by itself, with Last-Event-ID. Let it: that
					// is the only path that can replay exactly what was missed.
					browserRetries++;
					setStatus('retrying');
					return;
				}
				scheduleRetry();
			};
		}

		connect();

		return () => {
			stopped = true;
			teardown();
		};
		// `generation` is the manual retry: bumping it re-runs this effect from scratch.
	}, [tripId, generation, dispatch]);

	// Nothing may be left queued against a section that has gone away.
	useEffect(
		() => () => {
			if (flushTimer.current) clearTimeout(flushTimer.current);
			flushTimer.current = null;
			pending.current.clear();
		},
		[]
	);

	const subscribe = useCallback((topics: readonly TripTopic[], invalidate: () => void) => {
		const entry: Listener = { topics: new Set(topics), invalidate };
		listeners.current.add(entry);
		return () => {
			listeners.current.delete(entry);
			pending.current.delete(invalidate);
		};
	}, []);

	const retry = useCallback(() => {
		setStatus('connecting');
		setGeneration((n) => n + 1);
	}, []);

	return useMemo(() => ({ status, subscribe, retry }), [status, subscribe, retry]);
}

function readReason(data: unknown): string {
	try {
		const parsed = JSON.parse(String(data));
		return typeof parsed?.reason === 'string' ? parsed.reason : '';
	} catch {
		return '';
	}
}

const TripEventsContext = createContext<TripEvents | null>(null);

export const TripEventsProvider = TripEventsContext.Provider;

/** The stream's state, for the one quiet line that reports it. Null off a trip. */
export function useLiveStatus(): TripEvents | null {
	return useContext(TripEventsContext);
}

/**
 * Refetch this section when the server says one of `topics` changed.
 *
 * `reload` is the section's existing loader, so a live update and a manual
 * reload are the same code path. Outside a trip there is no stream and this
 * does nothing, which is what lets a page use it unconditionally.
 */
export function useLiveSection(topics: readonly TripTopic[], reload: () => void): void {
	const events = useContext(TripEventsContext);
	// Depend on the topics by value: every caller passes an array literal, and
	// depending on its identity would resubscribe on every render.
	const key = topics.join(',');
	const reloadRef = useRef(reload);
	reloadRef.current = reload;

	useEffect(() => {
		if (!events) return;
		return events.subscribe(key.split(',') as TripTopic[], () => reloadRef.current());
	}, [events, key]);
}
