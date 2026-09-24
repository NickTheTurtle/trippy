import { guessLeg, minsByMode, routeKey, type PlannedLeg } from '@trippy/core/travel';
import { createCache } from '../infra/cache';
import { assertPaidProviderAllowed, env } from '../infra/env';
import { noteProviderFailure, noteProviderOk, serviceHealth, type ProviderFailure } from './provider-health';

/**
 * How long a journey actually takes.
 *
 * Three sources, tried in order, and the order is about what each one knows
 * rather than about quality alone:
 *
 * 1. Google Routes, when a key is configured. It is the only one of the three
 *    that knows about transit timetables and one-way systems, and it is the one
 *    a user is picturing when they ask why the app thinks the museum is forty
 *    minutes away.
 * 2. OSRM's public server, which is free and driving-only. Good enough for a
 *    car, useless for a bus, so it is only asked about modes it can answer.
 * 3. The straight-line estimate in core, which needs nothing and is never wrong
 *    in a way that stops the day being planned.
 *
 * Every answer is cached on the coordinate pair and the mode. A board load
 * repeats the same pair across days and people, and several members open the
 * same day at once; without the cache each of those is a billed request.
 */

export interface RoutedLeg {
	mode: string;
	mins: number;
	/** False when this is the straight-line guess rather than a real route. */
	routed: boolean;
}

const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const GOOGLE_ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const TIMEOUT_MS = 3000;

/** Road times barely move within a day, so entries are worth keeping. */
const legCache = createCache<RoutedLeg>(6 * 60 * 60 * 1000, 2000);

function key(leg: PlannedLeg, mode: string): string {
	return routeKey(leg, mode);
}

/** Our vocabulary, in Google's. Ferry and flight have no Routes equivalent. */
const GOOGLE_MODE: Record<string, string | null> = {
	walk: 'WALK',
	cycle: 'BICYCLE',
	transit: 'TRANSIT',
	drive: 'DRIVE',
	ferry: null,
	flight: null
};

/**
 * Runs a provider call under a timeout, turning any failure into `null` and
 * recording what it was.
 *
 * The recording is the point. This used to be a bare `catch { return null }`,
 * which is why a board silently running on straight-line estimates looked
 * exactly like a board with fast routes: an abort, a DNS failure and a rejected
 * key all arrived as the same `null` and nothing was written down anywhere.
 * Reporting is the same mechanism Places uses, so one `/api/health` answer
 * covers both.
 */
async function withTimeout<T>(
	service: 'routing' | 'osrm',
	op: string,
	run: (signal: AbortSignal) => Promise<T | null>
): Promise<T | null> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		return await run(ctrl.signal);
	} catch (err) {
		// A timeout arrives here as an abort, which is worth telling apart from a
		// refusal: they have different fixes.
		noteProviderFailure(
			service,
			op,
			ctrl.signal.aborted ? new Error(`timeout after ${TIMEOUT_MS}ms`) : err
		);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Google Routes duration in minutes, or null for any failure or unsupported mode. */
async function googleMinutes(
	leg: PlannedLeg,
	mode: string,
	canBill?: () => boolean
): Promise<number | null> {
	const travelMode = GOOGLE_MODE[mode];
	// Routes is billed against the same Google key as Places, so it is held to
	// the same rule: an automated run never buys a route. The key reads as unset
	// while TRIPPY_OFFLINE_PROVIDERS is set, so this returns before any request;
	// the assert is the alarm for a future path that gets a key some other way.
	const apiKey = env.GOOGLE_SERVER_KEY;
	if (!travelMode || !apiKey) return null;
	assertPaidProviderAllowed('google routes');
	// The billed call. When the caller is over its routing quota, skip Google
	// rather than refuse: the leg falls through to the free OSRM/estimate below,
	// so a board still loads, only with a rougher time. Charged here so a leg
	// served from `legCache` never touches the quota.
	if (canBill && !canBill()) return null;

	return withTimeout('routing', 'google routes', async (signal) => {
		const res = await fetch(GOOGLE_ROUTES, {
			method: 'POST',
			signal,
			headers: {
				'content-type': 'application/json',
				'X-Goog-Api-Key': apiKey,
				// Asking for one field rather than the whole route keeps the request
				// in the cheapest billing tier; nothing here draws a polyline.
				'X-Goog-FieldMask': 'routes.duration'
			},
			body: JSON.stringify({
				origin: { location: { latLng: { latitude: leg.fromLat, longitude: leg.fromLng } } },
				destination: { location: { latLng: { latitude: leg.toLat, longitude: leg.toLng } } },
				travelMode,
				...(travelMode === 'DRIVE' ? { routingPreference: 'TRAFFIC_UNAWARE' } : {})
			})
		});
		// Thrown rather than returned as null, so the one handler above records
		// it. A rejected key answers 403 here and never throws, which is how the
		// broken key in this environment stayed invisible.
		if (!res.ok) throw new Error(`google ${res.status}`);
		const data = (await res.json()) as { routes?: { duration?: string }[] };
		// Durations come back as a protobuf duration string, "1234s".
		const secs = Number.parseFloat(data.routes?.[0]?.duration?.replace(/s$/, '') ?? '');
		if (!Number.isFinite(secs)) throw new Error('google answered without a duration');
		noteProviderOk('routing');
		return Math.max(1, Math.round(secs / 60));
	});
}

/** OSRM driving minutes, or null. Free, so it is a fallback rather than the first call. */
async function osrmMinutes(leg: PlannedLeg): Promise<number | null> {
	// Free but still a third party, and `withTimeout` would swallow a thrown
	// guard anyway, so offline runs skip it outright and take the straight-line
	// estimate. That also makes a test's travel times deterministic.
	if (env.OFFLINE_PROVIDERS) return null;
	const url = `${OSRM}/${leg.fromLng},${leg.fromLat};${leg.toLng},${leg.toLat}?overview=false`;
	return withTimeout('osrm', 'osrm route', async (signal) => {
		const res = await fetch(url, { signal });
		if (!res.ok) throw new Error(`osrm ${res.status}`);
		const data = (await res.json()) as { routes?: { duration?: number }[] };
		const secs = data.routes?.[0]?.duration;
		if (typeof secs !== 'number') throw new Error('osrm answered without a duration');
		return Math.max(1, Math.round(secs / 60));
	});
}

/**
 * Whether routing is answering from the paid provider, for `/api/health`.
 *
 * `serving` is what a leg that misses the cache would be answered by now, not a
 * per-leg fact: the ladder is decided per call. `configured` is `none` when no
 * server key is set, which is a deliberate choice rather than a fault, so it is
 * reported as free routing rather than as degradation.
 *
 * The free fallback's own failures are reported beside, never in place of, the
 * paid one's. When a rejected key drops every leg to OSRM and OSRM is down too,
 * the thing to fix is the key, and a single "last failure" field would have been
 * holding the OSRM error by then.
 */
export function routingStatus(): {
	configured: 'google' | 'none';
	serving: 'google' | 'fallback';
	degraded: boolean;
	lastFailure: ProviderFailure | null;
	fallbackFailure: ProviderFailure | null;
} {
	const configured = env.GOOGLE_SERVER_KEY ? 'google' : 'none';
	const google = serviceHealth('routing');
	const osrm = serviceHealth('osrm');
	const degraded = configured === 'google' && google.failing;
	return {
		configured,
		serving: degraded || configured === 'none' ? 'fallback' : 'google',
		degraded,
		lastFailure: google.lastFailure,
		fallbackFailure: osrm.lastFailure
	};
}

/**
 * The mode a journey of this length is most likely made in, when nobody has
 * said.
 *
 * Delegates to core's `guessLeg` rather than repeating its thresholds. The copy
 * that used to live here agreed with `guessLeg` about the label and disagreed
 * with the *other* core estimator about the number, which is how a 1000km leg
 * came to be labelled `flight` and given 43 hours of driving. One function now
 * decides both, so they cannot drift apart again.
 */
export function guessMode(km: number): string {
	return guessLeg(km).mode;
}

/**
 * Resolve one leg in a given mode.
 *
 * `mode` is what the user picked, or the guess from the distance when they have
 * not picked anything. It is honoured even when no provider can answer for it:
 * someone who says a leg is a ferry gets a ferry-shaped estimate rather than
 * being quietly told about the drive around the bay.
 */
export function routeLeg(
	leg: PlannedLeg,
	mode?: string,
	canBill?: () => boolean
): Promise<RoutedLeg> {
	const wanted = mode ?? guessMode(leg.km);
	return legCache.take(key(leg, wanted), async () => {
		const google = await googleMinutes(leg, wanted, canBill);
		if (google != null) return { mode: wanted, mins: google, routed: true };

		// OSRM only knows about driving, so it answers for a car and for the label
		// that is usually a car in practice. Asking it about a walk would return a
		// driving time wearing a walking label.
		if (wanted === 'drive' || wanted === 'transit') {
			const osrm = await osrmMinutes(leg);
			if (osrm != null) return { mode: wanted, mins: osrm, routed: true };
		}
		// The estimate is asked for the mode we are actually reporting. Spreading a
		// mode-blind estimate and then overwriting its label was the bug: a flight
		// was priced as a drive, a ferry as a drive around the bay, and the number
		// the board showed contradicted the word next to it.
		return { mode: wanted, mins: minsByMode(leg.km, wanted), routed: false };
	});
}

/** Resolve a day's legs at once. Failures fall back per leg, never as a batch. */
export async function routeLegs(
	legs: readonly PlannedLeg[],
	modeFor: (leg: PlannedLeg) => string | undefined,
	canBill?: () => boolean
): Promise<Map<string, RoutedLeg>> {
	const out = new Map<string, RoutedLeg>();
	await Promise.all(
		legs.map(async (leg) => {
			out.set(leg.key, await routeLeg(leg, modeFor(leg), canBill));
		})
	);
	return out;
}
