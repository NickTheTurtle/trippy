import { lookupPhoto } from './providers/places';
import { env } from './infra/env';
import { citiesNeedingPhotos, setCityPhoto } from './persistence/trips';
import {
	lodgingNeedingPhotos,
	lodgingNeedingPlace,
	setLodgingPhoto,
	fillLodgingPlace
} from './persistence/lodging';
import { poisNeedingPhotos, setPoiPhoto } from './persistence/pois';

/**
 * One home for the "find cover photos for rows that never had one" job.
 *
 * It was written three times (trip cities, places, stays) with three different
 * caps, so how much billed Google traffic a page view triggered depended on
 * which table happened to have accumulated nulls. Every lookup here is a paid
 * Places request, so the rules are stated once:
 *
 *  - A row is looked up **at most once ever**. The result is written back either
 *    way, and a miss is stored as the NO_PHOTO sentinel, so `photo IS NULL`
 *    means "never asked" rather than "asked and found nothing".
 *  - A single call spends at most `cap` lookups. A large backlog drains over
 *    several visits instead of billing for all of it at once.
 *  - At most `CONCURRENCY` lookups are in flight, so a backlog cannot open
 *    dozens of sockets to the provider at once.
 *  - Failures are swallowed. A missing picture must never stop a page
 *    rendering, and the row simply stays in the backlog for next time.
 */

/** Lookups a single request may pay for. */
export const PHOTO_BACKLOG_CAP = 24;

/** Lookups in flight at once. */
const CONCURRENCY = 4;

/** One unit of work: find a photo, then write the result back. */
interface PhotoJob {
	run: () => Promise<void>;
}

/**
 * Permission to make one more billed lookup.
 *
 * Returns false when the caller is over its photo allowance, and the drain
 * stops there rather than throwing: a cover picture is decoration, so running
 * out of allowance must leave the page rendering and the rows in the backlog
 * for next time. Optional, so a script or a seed can drain without a caller to
 * charge. See `throttle.ts` (`PHOTO_LIMIT`) for why photos have their own
 * ceiling rather than sharing the search one.
 */
export type PhotoGate = () => boolean;

async function runJobs(jobs: PhotoJob[], gate?: PhotoGate): Promise<number> {
	let next = 0;
	let done = 0;
	let stopped = false;
	const worker = async (): Promise<void> => {
		for (;;) {
			if (stopped) return;
			const i = next++;
			if (i >= jobs.length) return;
			// Charged per lookup, before it is made, and never for a row that is
			// not about to be bought. Once refused, the whole drain stops: the
			// next job would be refused too, and asking again per row turns one
			// ceiling into a per-row map lookup storm.
			if (gate && !gate()) {
				stopped = true;
				return;
			}
			try {
				await jobs[i].run();
				done++;
			} catch {
				// Leave the row in the backlog; it will be retried on a later visit.
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()));
	return done;
}

/**
 * Whether a lookup could be answered by anybody at all.
 *
 * `lookupPhoto` with no key answers "no photo, no position" without asking, and
 * the drain used to write that answer back as if it had asked: the miss
 * sentinel on the photo and `place_checked = 1` on the stay, both of which mean
 * "never ask again". A development database run without a key therefore had
 * every row it ever saw marked as looked-up-and-empty, and adding a key later
 * found nothing left to look up. With no key the drain now does nothing and
 * writes nothing, so the backlog is still there when a key arrives. The key
 * reads as unset under TRIPPY_OFFLINE_PROVIDERS, so a test run is the same.
 */
function canLookUp(): boolean {
	return !!env.GOOGLE_SERVER_KEY;
}

/**
 * One drain per key at a time.
 *
 * Discover awaits the drain on every GET, and several members opening the same
 * trip at once, or one member's page firing two requests, each started their
 * own. The rows are only marked once a lookup returns, so every concurrent
 * drain saw the same backlog and bought the same lookups again. A second caller
 * now waits on the drain already running and gets its answer.
 */
const inFlight = new Map<string, Promise<number>>();

function once(key: string, run: () => Promise<number>): Promise<number> {
	const running = inFlight.get(key);
	if (running) return running;
	const started = run().finally(() => {
		if (inFlight.get(key) === started) inFlight.delete(key);
	});
	inFlight.set(key, started);
	return started;
}

/**
 * Fill in cover photos for a trip's places and stays, and coordinates for any
 * stay that has never been asked where it is.
 *
 * The two share one lookup and one budget because they are the same request:
 * `lookupPhoto` searches for the stay by name and city, and the result carries
 * a position as well as a picture. A stay with no coordinates cannot be planned
 * a journey to, so this is what gives a hand-typed hotel a travel time.
 *
 * Returns how many lookups were completed, so a caller can log or test the
 * spend. Safe to call on every board load: once the backlog is drained it costs
 * three indexed queries and no provider traffic. A call made while a drain for
 * the same trip is running shares it rather than starting a second.
 */
export function backfillTripPhotos(
	tripId: string,
	cap: number = PHOTO_BACKLOG_CAP,
	gate?: PhotoGate
): Promise<number> {
	if (cap <= 0 || !canLookUp()) return Promise.resolve(0);
	return once(`trip:${tripId}`, () => drainTrip(tripId, cap, gate));
}

async function drainTrip(tripId: string, cap: number, gate?: PhotoGate): Promise<number> {
	const places = poisNeedingPhotos(tripId, cap);
	const stays = lodgingNeedingPhotos(tripId, Math.max(0, cap - places.length));
	// Stays already holding a photo but no position. The photo backlog cannot
	// reach them, and in an established trip that is all of them.
	const seen = new Set(stays.map((s) => s.id));
	const unplaced = lodgingNeedingPlace(
		tripId,
		Math.max(0, cap - places.length - stays.length)
	).filter((s) => !seen.has(s.id));
	const jobs: PhotoJob[] = [
		...places.map((p) => ({
			run: async () => {
				const found = await lookupPhoto(
					p.name,
					{ city: p.city, country: p.country, region: p.region },
					p.lat,
					p.lng
				);
				setPoiPhoto(p.id, found.photo);
			}
		})),
		// Stays carry no coordinates of their own, so the lookup falls back to the
		// city's. A hotel name plus its city, state and country is specific enough.
		...stays.map((s) => ({
			run: async () => {
				const found = await lookupPhoto(s.name, {
					city: s.city,
					country: s.country,
					region: s.region,
					lat: s.lat,
					lng: s.lng
				});
				setLodgingPhoto(s.id, found.photo);
				// Free: the same response carried it.
				fillLodgingPlace(tripId, s.id, found.lat, found.lng);
			}
		})),
		...unplaced.map((s) => ({
			run: async () => {
				const found = await lookupPhoto(s.name, {
					city: s.city,
					country: s.country,
					region: s.region,
					lat: s.lat,
					lng: s.lng
				});
				fillLodgingPlace(tripId, s.id, found.lat, found.lng);
			}
		}))
	];
	return runJobs(jobs.slice(0, cap), gate);
}

/**
 * Fill in cover photos for the first city of each of a user's trips, which is
 * the only city a trip card shows. Same two guards as `backfillTripPhotos`: no
 * key means nothing is written, and one drain per user at a time.
 */
export function backfillTripListPhotos(
	userId: string,
	cap: number = PHOTO_BACKLOG_CAP,
	gate?: PhotoGate
): Promise<number> {
	if (cap <= 0 || !canLookUp()) return Promise.resolve(0);
	return once(`list:${userId}`, () => drainTripList(userId, cap, gate));
}

async function drainTripList(userId: string, cap: number, gate?: PhotoGate): Promise<number> {
	const cities = citiesNeedingPhotos(userId, cap);
	return runJobs(
		cities.map((city) => ({
			run: async () => {
				const found = await lookupPhoto(
					city.name,
					{ city: city.name, country: city.country, region: city.region },
					city.lat,
					city.lng
				);
				setCityPhoto(city.id, found.photo);
			}
		})),
		gate
	);
}
