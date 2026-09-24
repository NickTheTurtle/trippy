import { fetch as expoFetch } from 'expo/fetch';
import { AppState, type AppStateStatus } from 'react-native';
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
import { API_BASE } from '../lib/api';
import { getToken } from '../lib/token';

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
export type LiveStatus = 'connecting' | 'live' | 'retrying' | 'off';

type Listener = { topics: ReadonlySet<TripTopic | '*'>; invalidate: () => void };
export type TripEventsControl = {
	subscribe: (topics: readonly TripTopic[], invalidate: () => void) => () => void;
	retry: () => void;
};
export type TripEvents = TripEventsControl & { status: LiveStatus; control: TripEventsControl };

const MAX_ATTEMPTS = 6;
const BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];
const COALESCE_MS = 120;
const STABLE_MS = 20000;

type SseMessage = { event: string; data: string; id: string | null };

export function useTripEvents(tripId: string | null): TripEvents {
	const [status, setStatus] = useState<LiveStatus>(tripId ? 'connecting' : 'off');
	const [generation, setGeneration] = useState(0);
	const listeners = useRef<Set<Listener>>(new Set());
	const pending = useRef<Set<() => void>>(new Set());
	const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const flush = useCallback(() => {
		flushTimer.current = null;
		const due = [...pending.current];
		pending.current.clear();
		for (const fn of due) fn();
	}, []);

	const dispatch = useCallback(
		(topic: TripTopic | '*') => {
			for (const listener of listeners.current) {
				if (topic === '*' || listener.topics.has('*') || listener.topics.has(topic)) {
					pending.current.add(listener.invalidate);
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

		let stopped = false;
		let controller: AbortController | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let attempts = 0;
		let openedAt = 0;
		let connectedOnce = false;
		let lastEventId: string | null = null;
		let appState: AppStateStatus = (AppState.currentState ?? 'active') as AppStateStatus;

		const clearTimer = () => {
			if (timer) clearTimeout(timer);
			timer = null;
		};

		const abort = () => {
			controller?.abort();
			controller = null;
		};

		const provedItself = () => openedAt !== 0 && Date.now() - openedAt > STABLE_MS;

		const giveUp = () => {
			stopped = true;
			clearTimer();
			abort();
			setStatus('off');
		};

		const scheduleRetry = (afterMs?: number) => {
			clearTimer();
			abort();
			if (stopped || appState !== 'active') return;
			if (attempts >= MAX_ATTEMPTS) {
				giveUp();
				return;
			}
			const base = afterMs ?? BACKOFF[Math.min(attempts, BACKOFF.length - 1)];
			attempts += 1;
			setStatus('retrying');
			timer = setTimeout(connect, base * (0.8 + Math.random() * 0.4));
		};

		const handleMessage = (message: SseMessage) => {
			if (message.id) lastEventId = message.id;
			if (message.event === 'reset') {
				dispatch('*');
				return;
			}
			if (message.event === 'closed') {
				if (readReason(message.data) === 'revoked') {
					giveUp();
					dispatch('*');
				} else {
					scheduleRetry();
				}
				return;
			}
			if ((TRIP_TOPICS as readonly string[]).includes(message.event)) {
				dispatch(message.event as TripTopic);
			}
		};

		async function connect(): Promise<void> {
			if (stopped || appState !== 'active') return;
			controller = new AbortController();
			const token = await getToken();
			const headers: Record<string, string> = {
				accept: 'text/event-stream',
				'x-trippy-client': 'native'
			};
			if (token) headers.authorization = `Bearer ${token}`;
			if (lastEventId) headers['Last-Event-ID'] = lastEventId;

			try {
				const res = await expoFetch(`${API_BASE}/api/trips/${tripId}/events`, {
					headers,
					signal: controller.signal
				});
				if (!res.ok || !res.body) {
					if (res.status === 404 || res.status === 401) {
						giveUp();
						dispatch('*');
						return;
					}
					const retryAfter = Number(res.headers.get('retry-after'));
					scheduleRetry(
						Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined
					);
					return;
				}
				openedAt = Date.now();
				setStatus('live');
				if (connectedOnce) dispatch('*');
				connectedOnce = true;
				await readSse(res.body, handleMessage);
				if (!stopped && appState === 'active') {
					if (provedItself()) attempts = 0;
					openedAt = 0;
					scheduleRetry();
				}
			} catch (err) {
				if (
					stopped ||
					(err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError')
				)
					return;
				if (provedItself()) attempts = 0;
				openedAt = 0;
				scheduleRetry();
			}
		}

		void connect();
		const sub = AppState.addEventListener('change', (next) => {
			const wasActive = appState === 'active';
			appState = next;
			if (next !== 'active') {
				clearTimer();
				abort();
				setStatus('off');
				return;
			}
			if (!wasActive && !stopped) {
				dispatch('*');
				attempts = 0;
				setStatus('connecting');
				void connect();
			}
		});

		return () => {
			stopped = true;
			sub.remove();
			clearTimer();
			abort();
		};
	}, [tripId, generation, dispatch]);

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
		};
	}, []);

	const retry = useCallback(() => {
		setStatus('connecting');
		setGeneration((n) => n + 1);
	}, []);

	const control = useMemo(() => ({ subscribe, retry }), [subscribe, retry]);
	return useMemo(
		() => ({ status, subscribe, retry, control }),
		[status, subscribe, retry, control]
	);
}

async function readSse(body: ReadableStream<Uint8Array>, onMessage: (message: SseMessage) => void) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	let event = 'message';
	let data = '';
	let id: string | null = null;

	const emit = () => {
		if (data) onMessage({ event, data: data.replace(/\n$/, ''), id });
		event = 'message';
		data = '';
		id = null;
	};

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
		let nl = text.indexOf('\n');
		while (nl >= 0) {
			const raw = text.slice(0, nl).replace(/\r$/, '');
			text = text.slice(nl + 1);
			if (raw === '') emit();
			else if (!raw.startsWith(':')) {
				const colon = raw.indexOf(':');
				const field = colon === -1 ? raw : raw.slice(0, colon);
				const valueText = colon === -1 ? '' : raw.slice(colon + 1).replace(/^ /, '');
				if (field === 'event') event = valueText;
				else if (field === 'data') data += `${valueText}\n`;
				else if (field === 'id') id = valueText;
			}
			nl = text.indexOf('\n');
		}
	}
}

function readReason(data: string): string {
	try {
		const parsed = JSON.parse(data) as { reason?: unknown };
		return typeof parsed.reason === 'string' ? parsed.reason : '';
	} catch {
		return '';
	}
}

const TripEventsControlContext = createContext<TripEventsControl | null>(null);
const TripLiveStatusContext = createContext<LiveStatus | null>(null);

export function TripEventsProvider({
	value,
	children
}: {
	value: TripEvents;
	children: ReactNode;
}) {
	return (
		<TripEventsControlContext.Provider value={value.control}>
			<TripLiveStatusContext.Provider value={value.status}>
				{children}
			</TripLiveStatusContext.Provider>
		</TripEventsControlContext.Provider>
	);
}

export function useLiveStatus(): { status: LiveStatus; retry: () => void } | null {
	const control = useContext(TripEventsControlContext);
	const status = useContext(TripLiveStatusContext);
	if (!control || status === null) return null;
	return { status, retry: control.retry };
}

export function useLiveSection(topics: readonly TripTopic[], reload: () => void): void {
	const events = useContext(TripEventsControlContext);
	const key = topics.join(',');
	const reloadRef = useRef(reload);
	reloadRef.current = reload;
	const invalidate = useCallback(() => reloadRef.current(), []);

	useEffect(() => {
		if (!events) return;
		return events.subscribe(key.split(',') as TripTopic[], invalidate);
	}, [events, key, invalidate]);
}
