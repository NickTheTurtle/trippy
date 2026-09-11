import { Hono } from 'hono';
import { fail } from '../respond';
import type { Env } from '../types';
import {
	subscribe,
	wireEventId,
	type CloseReason,
	type TripEvent,
	type TripSubscription
} from '@trippy/server/events';

/**
 * Live updates for one trip, as Server-Sent Events.
 *
 * The transport half of `@trippy/server/events`. An event names a trip and a
 * section; it never carries rows, so this route serialises four scalars and does
 * no authorization per event and no per-recipient filtering. The client refetches
 * the section it already knows how to fetch.
 *
 * # Why a hand-rolled stream and not `hono/streaming`'s `streamSSE`
 *
 * Three things it cannot do here:
 *
 *  - The bus calls the listener SYNCHRONOUSLY from inside `publish`. `writeSSE`
 *    is async, so every delivery would be a floating promise; two publishes in
 *    one tick could interleave and reach the socket out of order, and the whole
 *    point of the id sequence is that order is preserved.
 *  - The status is not known until `subscribe` has answered: `forbidden` is a
 *    404 and `busy` is a 503 with `Retry-After`. `streamSSE` has already
 *    committed to 200 and the event-stream headers by the time its callback runs.
 *  - Teardown has to be exact. A leaked subscriber holds a socket and a slot in
 *    the per-trip cap forever, so `close()` is driven from BOTH the request abort
 *    signal AND the stream's `cancel`, plus the bus's own `onClose`. Doing that
 *    by hand is shorter than persuading the helper to do it.
 *
 * A `ReadableStream` fits the synchronous listener exactly: `enqueue` is
 * synchronous and cannot reorder.
 */

/**
 * Keepalive period. Anything idle longer than roughly 30s is fair game for a
 * proxy or a NAT to drop, and a dropped stream looks to the user exactly like a
 * working stream with nothing happening: no error, just updates that stopped.
 * A comment line is the cheapest possible traffic and resets every such timer.
 */
const KEEPALIVE_MS = 22_000;

/** Client reconnect delay. Sent once so the browser's default 3s is not left to chance. */
const RETRY_MS = 3000;

/** Back-off for a `busy` refusal, in seconds. Long enough that a retry storm cannot form. */
const BUSY_RETRY_AFTER = '5';

export const events = new Hono<Env>();

/**
 * `GET /api/trips/:tripId/events`
 *
 * Deliberately NOT behind `requireMember`. `subscribe` checks membership itself,
 * against the same table, and is also the thing that revokes a stream when
 * membership is lost mid-connection. Two checks would be two answers to keep in
 * agreement. `forbidden` becomes 404, not 403, for the reason `requireMember`
 * gives: distinguishing "not a member" from "no such trip" tells a stranger
 * which trip ids are real.
 */
events.get('/', (c) => {
	const tripId = c.req.param('tripId') ?? '';
	const signal = c.req.raw.signal;

	const encoder = new TextEncoder();
	// Frames produced before the body starts flowing (the prelude, and anything
	// published in that window) wait here until `start` hands over the controller.
	let pending: string[] = [];
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let keepalive: ReturnType<typeof setInterval> | null = null;
	let sub: TripSubscription | null = null;
	let done = false;

	function write(frame: string): void {
		if (done) return;
		if (!controller) {
			pending.push(frame);
			return;
		}
		try {
			controller.enqueue(encoder.encode(frame));
		} catch {
			// The socket went away between the abort and our noticing. Tear down
			// rather than throwing back into `publish`, which would cost the bus a
			// `listener-error` detach for something we already know about.
			finish();
		}
	}

	/**
	 * The one teardown path, idempotent, safe to call from a listener.
	 *
	 * The subscription is detached BEFORE the stream is closed, so no listener can
	 * fire against a dead controller, and the keepalive timer is cleared here so an
	 * abandoned stream cannot hold the process open.
	 */
	function finish(): void {
		if (done) return;
		done = true;
		if (keepalive) {
			clearInterval(keepalive);
			keepalive = null;
		}
		signal.removeEventListener('abort', finish);
		sub?.close();
		try {
			controller?.close();
		} catch {
			// Already closed or errored by the platform; nothing left to do.
		}
		controller = null;
	}

	const result = subscribe(tripId, c.get('user').id, (event) => write(eventFrame(event)), {
		lastEventId: c.req.header('Last-Event-ID') ?? null,
		onClose: (reason) => {
			// Bus-initiated close: membership revoked, listener broken, or shutdown.
			// Name the reason before ending, so a client can tell "you were removed
			// from this trip" from "reconnect".
			write(closedFrame(tripId, reason));
			finish();
		}
	});

	if (!result.ok) {
		if (result.error === 'busy') {
			c.header('Retry-After', BUSY_RETRY_AFTER);
			return fail(c, 503, 'Too many live connections for this trip. Try again shortly.');
		}
		return fail(c, 404, 'Not found.');
	}

	sub = result.sub;

	// Everything from here to the end of the handler is synchronous on purpose.
	// `publish` delivers synchronously too, so no event can land between reading
	// `missed` and queueing it: the replay is written first, and anything the
	// listener produces necessarily queues behind it.
	write(`retry: ${RETRY_MS}\n\n`);
	// A baseline id, so a client that connects during a quiet spell still has
	// something to send back as `Last-Event-ID`. An id-only frame dispatches no
	// event but does update the browser's last event id, which is the point.
	if (result.lastEventId) write(`id: ${result.lastEventId}\n\n`);
	// `reset` is not "no news": it means this process cannot prove what the client
	// missed, so the client must reload every section. Said explicitly, because a
	// silent resume across a gap is worse than no live updates at all.
	if (result.resume === 'reset') write(resetFrame(tripId));
	for (const event of result.missed) write(eventFrame(event));

	const stream = new ReadableStream<Uint8Array>({
		start(ctrl) {
			if (done) {
				ctrl.close();
				return;
			}
			controller = ctrl;
			for (const frame of pending) ctrl.enqueue(encoder.encode(frame));
			pending = [];
			keepalive = setInterval(() => write(':keepalive\n\n'), KEEPALIVE_MS);
			// Belt to the clearInterval's braces: even if teardown were missed, an
			// idle keepalive must never be the reason the process will not exit.
			keepalive.unref?.();
		},
		// Fires when the platform stops reading, which is the disconnect case that
		// does not always surface as an abort. Both are wired; either alone has been
		// observed to leak a subscriber.
		cancel() {
			finish();
		}
	});

	signal.addEventListener('abort', finish, { once: true });
	if (signal.aborted) finish();

	return c.body(stream, 200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
		// Without this, nginx and friends buffer the response and the stream
		// arrives in one lump whenever it finally ends, which is never.
		'X-Accel-Buffering': 'no'
	});
});

/**
 * One invalidation on the wire. The SSE `id:` is `wireEventId`, which is
 * epoch-qualified: after a restart the counter starts over, and a client's old
 * id must read as stale rather than as a gap.
 */
function eventFrame(event: TripEvent): string {
	const data = JSON.stringify({ tripId: event.tripId, topic: event.topic, id: event.id });
	return `id: ${wireEventId(event)}\nevent: ${event.topic}\ndata: ${data}\n\n`;
}

/** "Your resume point is unaccountable; reload everything." Carries no id: there is nothing to resume from. */
function resetFrame(tripId: string): string {
	return `event: reset\ndata: ${JSON.stringify({ tripId, reason: 'gap' })}\n\n`;
}

/** Final frame when the bus closes the stream from its side. */
function closedFrame(tripId: string, reason: CloseReason): string {
	return `event: closed\ndata: ${JSON.stringify({ tripId, reason })}\n\n`;
}
