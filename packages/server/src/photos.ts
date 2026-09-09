import { lookupPhoto } from './providers/places';
import { citiesNeedingPhotos, setCityPhoto } from './persistence/trips';
import { lodgingNeedingPhotos, setLodgingPhoto } from './persistence/lodging';
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

async function runJobs(jobs: PhotoJob[]): Promise<number> {
	let next = 0;
	let done = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= jobs.length) return;
			try {
				await jobs[i].run();
				done++;
			} catch {
				// Leave the row in the backlog; it will be retried on a later visit.
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker())
	);
	return done;
}

/**
 * Fill in cover photos for a trip's places and stays.
 *
 * Returns how many lookups were completed, so a caller can log or test the
 * spend. Safe to call on every board load: once the backlog is drained it costs
 * two indexed queries and no provider traffic.
 */
export async function backfillTripPhotos(
	tripId: string,
	cap: number = PHOTO_BACKLOG_CAP
): Promise<number> {
	if (cap <= 0) return 0;
	const places = poisNeedingPhotos(tripId, cap);
	const stays = lodgingNeedingPhotos(tripId, Math.max(0, cap - places.length));
	const jobs: PhotoJob[] = [
		...places.map((p) => ({
			run: async () => {
				setPoiPhoto(p.id, await lookupPhoto(p.name, { city: p.city, country: p.country }, p.lat, p.lng));
			}
		})),
		// Stays carry no coordinates, so the city and country are the only bias
		// available. That is enough: a hotel name plus its city is specific.
		...stays.map((s) => ({
			run: async () => {
				setLodgingPhoto(s.id, await lookupPhoto(s.name, { city: s.city, country: s.country }));
			}
		}))
	];
	return runJobs(jobs.slice(0, cap));
}

/**
 * Fill in cover photos for the first city of each of a user's trips, which is
 * the only city a trip card shows.
 */
export async function backfillTripListPhotos(
	userId: string,
	cap: number = PHOTO_BACKLOG_CAP
): Promise<number> {
	if (cap <= 0) return 0;
	const cities = citiesNeedingPhotos(userId, cap);
	return runJobs(
		cities.map((city) => ({
			run: async () => {
				setCityPhoto(
					city.id,
					await lookupPhoto(city.name, { city: city.name, country: city.country }, city.lat, city.lng)
				);
			}
		}))
	);
}
