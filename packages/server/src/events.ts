import { randomUUID } from 'node:crypto';
import { isMember } from './persistence/membership';

/**
 * In-process publish/subscribe bus for live trip updates (the server half of SSE).
 *
 * # What travels on the wire, and why it is not data
 *
 * An event says "trip X, section Y changed" and nothing else. It carries no rows.
 * The client refetches the section it already knows how to fetch.
 *
 * Streaming diffs would mean the browser holds a second implementation of every
 * merge rule the server already has (how a vote count is derived, how travel legs
 * are recomputed between items, how a split is rounded), and those two copies
 * diverge silently: nothing errors, the numbers are just wrong for whoever left
 * the tab open longest. It would also push authorization into the transport,
 * because a row payload has to be filtered per recipient, and the section
 * endpoints already do that filtering correctly once. Coarse invalidation makes
 * the worst possible bug "we refetched something that had not changed".
 *
 * The cost is an extra GET per event. At this scale (a household-sized trip, a
 * handful of tabs) that is the right trade by a wide margin.
 *
 * # Ordering and gap detection
 *
 * Every event gets an id from one process-wide counter, so ids increase globally
 * and within a trip. Each trip keeps a bounded ring of its recent events, so a
 * client that reconnects with `Last-Event-ID` is either given exactly what it
 * missed or is told, explicitly, that the gap is too large and it must reload
 * from scratch. Silently resuming past a gap is the failure mode that makes
 * "live" updates worse than no updates at all, so it is not a state this bus can
 * reach.
 *
 * Ids are per-process. `EVENT_EPOCH` changes on every restart and is embedded in
 * the wire id, so a client holding an id from a previous process is detected as
 * stale rather than mistaken for a client from the future.
 *
 * # Scope
 *
 * A subscription is (trip, user). Membership is checked when the stream opens,
 * and rechecked for every subscriber of a trip whenever that trip publishes a
 * `members` event, which is the only way membership can change. A subscriber who
 * has lost access is closed with reason `revoked` rather than being left holding
 * an open channel to a trip they are no longer on.
 *
 * No dependencies, no external broker, no timers: one Node process serves this
 * app, and a bus that outlives the process would be a different design.
 */

/**
 * A section of the trip UI, which is also the unit of refetch. These are the
 * sections the API serves as one payload each, so a client can map topic to
 * endpoint directly.
 *
 * `parties` is deliberately absent: crews are part of the calendar payload, so
 * `parties.ts` publishes `schedule`.
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

/** One coarse invalidation. Never carries row data. */
export interface TripEvent {
	/** Monotonically increasing across the whole process. Never reused. */
	readonly id: number;
	readonly tripId: string;
	readonly topic: TripTopic;
	/** Wall clock of the publish, ms since epoch. Informational only. */
	readonly at: number;
}

/** Why the bus closed a subscription from its side. */
export type CloseReason =
	| 'revoked' /** the subscriber is no longer a member of the trip */
	| 'listener-error' /** the listener threw; the channel is assumed broken */
	| 'shutdown'; /** closeAll() was called */

export interface TripSubscription {
	readonly tripId: string;
	readonly userId: string;
	/** True once closed, from either side. Idempotent. */
	readonly closed: boolean;
	/** Detach. Safe to call repeatedly and from inside a listener. */
	close(): void;
}

/**
 * How a subscription relates to what the client already has.
 *
 * - `live`   fresh stream, no resume was requested; the client has just loaded.
 * - `replay` the client's `Last-Event-ID` was still in the buffer; `missed`
 *            holds exactly the events between it and now, in order.
 * - `reset`  the client asked to resume from an id this process cannot account
 *            for (too old, from a previous process, or ahead of the head). The
 *            client MUST do a full reload of every section; it cannot assume
 *            `missed` is complete, and it is empty.
 */
export type ResumeMode = 'live' | 'replay' | 'reset';

export type SubscribeResult =
	| {
			ok: true;
			sub: TripSubscription;
			resume: ResumeMode;
			/** Events between the client's last id and now. Only non-empty when resume === 'replay'. */
			missed: TripEvent[];
			/** Wire id to send as the SSE `id:` of the last event the client now has, or null when the trip has no events yet. */
			lastEventId: string | null;
	  }
	| {
			ok: false;
			/**
			 * - `forbidden` not a member of the trip (or no such trip: the two are
			 *   deliberately indistinguishable, as everywhere else in this codebase).
			 * - `busy` a subscriber cap was hit. Answer 503 and let the client back off.
			 */
			error: 'forbidden' | 'busy';
	  };

export interface SubscribeOptions {
	/**
	 * The raw `Last-Event-ID` request header, passed through verbatim. Parsing,
	 * epoch checking and the too-old decision all happen here so no transport
	 * layer has to reimplement them.
	 */
	lastEventId?: string | null;
	/** Called at most once when the bus closes the subscription itself. */
	onClose?: (reason: CloseReason) => void;
}

/**
 * Identifies this process's id sequence. A restart makes every previously issued
 * wire id unrecognisable, which is exactly right: the counter starts over, so an
 * id from the old process means nothing here.
 */
export const EVENT_EPOCH: string = randomUUID().slice(0, 8);

/** The SSE `id:` for an event: epoch-qualified so a restart cannot be mistaken for a gap. */
export function wireEventId(event: TripEvent): string {
	return `${EVENT_EPOCH}.${event.id}`;
}

/**
 * Caps. These bound memory and file descriptors; a long-lived connection type
 * that grows without limit is worse than having no live updates at all.
 */
/** Events retained per trip for replay. A burst of edits is a few dozen events. */
const RING_CAPACITY = 200;
/** How long a trip's ring survives with nobody listening. Also the practical replay window. */
const RING_TTL_MS = 5 * 60 * 1000;
/** Open streams for one trip. Roughly "every member with a few tabs each". */
const MAX_SUBSCRIBERS_PER_TRIP = 32;
/** Open streams across all trips. */
const MAX_SUBSCRIBERS_TOTAL = 512;

interface Sub {
	tripId: string;
	userId: string;
	listener: (event: TripEvent) => void;
	onClose?: (reason: CloseReason) => void;
	closed: boolean;
}

interface TripChannel {
	/** Recent events, oldest first, at most RING_CAPACITY. */
	ring: TripEvent[];
	subs: Set<Sub>;
	/** Last publish, for TTL pruning of idle trips. */
	touched: number;
}

const channels = new Map<string, TripChannel>();
let totalSubs = 0;
let nextId = 0;

function channel(tripId: string): TripChannel {
	let ch = channels.get(tripId);
	if (!ch) {
		ch = { ring: [], subs: new Set(), touched: Date.now() };
		channels.set(tripId, ch);
	}
	return ch;
}

/**
 * Drop rings for trips nobody is listening to and nobody has touched recently.
 * Without this the map grows one entry per trip ever edited by the process. Runs
 * on publish and subscribe rather than on a timer, so an idle server does no work
 * and holds no handle keeping it alive.
 */
function prune(): void {
	const cutoff = Date.now() - RING_TTL_MS;
	for (const [tripId, ch] of channels) {
		if (ch.subs.size === 0 && ch.touched < cutoff) channels.delete(tripId);
	}
}

function detach(sub: Sub, reason: CloseReason | null): void {
	if (sub.closed) return;
	sub.closed = true;
	const ch = channels.get(sub.tripId);
	if (ch?.subs.delete(sub)) totalSubs--;
	if (reason && sub.onClose) {
		try {
			sub.onClose(reason);
		} catch {
			// A caller's cleanup throwing must not take the publisher down with it.
		}
	}
}

/**
 * Publish one invalidation for a trip.
 *
 * Call this AFTER the write has succeeded, and after COMMIT if it was in a
 * transaction: an event that names a change a reader cannot yet see would send
 * every client to refetch stale rows and then never tell them again.
 *
 * Returns the recorded event, or null when `tripId` is empty. It records into the
 * ring even with no subscribers, because a client reconnecting inside the replay
 * window needs to learn about edits made while it was away.
 */
export function publish(tripId: string, topic: TripTopic): TripEvent | null {
	if (!tripId) return null;
	const event: TripEvent = { id: ++nextId, tripId, topic, at: Date.now() };

	const ch = channel(tripId);
	ch.ring.push(event);
	if (ch.ring.length > RING_CAPACITY) ch.ring.splice(0, ch.ring.length - RING_CAPACITY);
	ch.touched = event.at;

	// Iterate a snapshot: a listener may close its own (or another) subscription.
	for (const sub of [...ch.subs]) {
		if (sub.closed) continue;
		try {
			sub.listener(event);
		} catch {
			// A dead socket must not stop delivery to everyone after it in the set.
			detach(sub, 'listener-error');
		}
	}

	// Membership can only change through a mutation that publishes `members`, so
	// this is the one moment an open stream can have gone out of scope. Bounded
	// by the subscribers of this trip, and only on this topic: no per-event and
	// no per-row authorization queries.
	if (topic === 'members') {
		for (const sub of [...ch.subs]) {
			if (!sub.closed && !isMember(tripId, sub.userId)) detach(sub, 'revoked');
		}
	}

	prune();
	return event;
}

/** Publish several topics for one trip, in order. Duplicates are collapsed. */
export function publishMany(tripId: string, topics: readonly TripTopic[]): void {
	const seen = new Set<TripTopic>();
	for (const t of topics) {
		if (seen.has(t)) continue;
		seen.add(t);
		publish(tripId, t);
	}
}

/**
 * Parse a `Last-Event-ID` header into a numeric id from THIS process, or null if
 * it is absent, malformed, or from a previous epoch.
 */
function parseLastEventId(raw: string | null | undefined): number | null {
	if (!raw) return null;
	const dot = raw.lastIndexOf('.');
	if (dot <= 0) return null;
	if (raw.slice(0, dot) !== EVENT_EPOCH) return null;
	const n = Number(raw.slice(dot + 1));
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Open a subscription for `userId` on `tripId`.
 *
 * Membership is checked here and only here on the happy path (see `publish` for
 * revocation). The returned `missed` and the listener never overlap: the buffer
 * is read and the listener is registered in the same synchronous step, and
 * `publish` delivers synchronously, so there is no window in which an event can
 * be both replayed and delivered, or neither.
 *
 * The listener is called synchronously from inside `publish`. It must not block
 * and must not await; enqueue onto the response and return. Throwing closes the
 * subscription with `listener-error`.
 */
export function subscribe(
	tripId: string,
	userId: string,
	listener: (event: TripEvent) => void,
	options: SubscribeOptions = {}
): SubscribeResult {
	if (!tripId || !userId) return { ok: false, error: 'forbidden' };
	if (!isMember(tripId, userId)) return { ok: false, error: 'forbidden' };

	const ch = channel(tripId);
	// Reject rather than evict. Evicting the oldest subscriber would let anyone
	// who can open streams push other members off the trip, which is a denial of
	// service dressed up as a fairness policy. A rejected client retries.
	if (ch.subs.size >= MAX_SUBSCRIBERS_PER_TRIP || totalSubs >= MAX_SUBSCRIBERS_TOTAL) {
		return { ok: false, error: 'busy' };
	}

	const since = parseLastEventId(options.lastEventId);
	const head = ch.ring.length ? ch.ring[ch.ring.length - 1] : null;
	const oldest = ch.ring.length ? ch.ring[0] : null;

	let resume: ResumeMode = 'live';
	let missed: TripEvent[] = [];
	if (options.lastEventId) {
		if (since === null) {
			// Unparseable, or from a previous process. We cannot prove what it missed.
			resume = 'reset';
		} else if (head && since > head.id) {
			// Ahead of our head: not something this process ever issued.
			resume = 'reset';
		} else if (!oldest || !head) {
			// The ring was pruned (or never existed) while they were away. Anything
			// could have happened in the gap, so say so instead of guessing.
			resume = 'reset';
		} else if (since < oldest.id - 1) {
			// Their next event has already fallen out of the buffer.
			resume = 'reset';
		} else {
			resume = 'replay';
			missed = ch.ring.filter((e) => e.id > since);
		}
	}

	const sub: Sub = { tripId, userId, listener, onClose: options.onClose, closed: false };
	ch.subs.add(sub);
	totalSubs++;
	prune();

	const handle: TripSubscription = {
		tripId,
		userId,
		get closed() {
			return sub.closed;
		},
		close() {
			detach(sub, null);
		}
	};

	return {
		ok: true,
		sub: handle,
		resume,
		missed,
		lastEventId: head ? wireEventId(head) : null
	};
}

/** Close every subscription. For process shutdown and for tests. */
export function closeAll(reason: CloseReason = 'shutdown'): void {
	for (const ch of [...channels.values()]) {
		for (const sub of [...ch.subs]) detach(sub, reason);
	}
}

/** Live counters, for a health endpoint and for tests that assert nothing leaks. */
export function busStats(): {
	trips: number;
	subscribers: number;
	buffered: number;
	lastEventId: number;
	epoch: string;
} {
	let buffered = 0;
	for (const ch of channels.values()) buffered += ch.ring.length;
	return {
		trips: channels.size,
		subscribers: totalSubs,
		buffered,
		lastEventId: nextId,
		epoch: EVENT_EPOCH
	};
}

/** Subscribers currently attached to one trip. */
export function subscriberCount(tripId: string): number {
	return channels.get(tripId)?.subs.size ?? 0;
}
