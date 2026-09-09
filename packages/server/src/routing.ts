import type { TrackWithItems } from './schedule';
import { estimateTravel, haversineKm } from '@trippy/core/geo';
import { createCache } from './cache';

interface Leg {
	mode: string;
	mins: number;
	routed: boolean;
}

const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const TIMEOUT_MS = 2500;

/**
 * Routed legs are cached like every other paid lookup: a board load repeats the
 * same coordinate pair across days and crews, and several members open the same
 * day at once. A plain Map gave no TTL, no bound and no in-flight sharing, so
 * duplicate legs in one load could each hit the provider. Road times barely
 * move within a day, hence the long TTL.
 */
const legCache = createCache<Leg>(6 * 60 * 60 * 1000, 2000);

function key(a: { lat: number; lng: number }, b: { lat: number; lng: number }): string {
	const r = (n: number) => n.toFixed(4);
	return `${r(a.lat)},${r(a.lng)}>${r(b.lat)},${r(b.lng)}`;
}

/** Real driving time in minutes from OSRM, or null on any failure/timeout. */
async function osrmMinutes(
	a: { lat: number; lng: number },
	b: { lat: number; lng: number }
): Promise<number | null> {
	const url = `${OSRM}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: ctrl.signal });
		if (!res.ok) return null;
		const data = (await res.json()) as { routes?: { duration?: number }[] };
		const secs = data.routes?.[0]?.duration;
		return typeof secs === 'number' ? Math.max(1, Math.round(secs / 60)) : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Resolve a single leg: real road time when possible, otherwise a straight-line estimate. */
function routeLeg(
	a: { lat: number; lng: number },
	b: { lat: number; lng: number }
): Promise<Leg> {
	return legCache.take(key(a, b), async () => {
		const km = haversineKm(a.lat, a.lng, b.lat, b.lng);
		// Short hops are walked; OSRM's public server is driving-only, so estimate those.
		if (km * 1.3 < 1.1) return { ...estimateTravel(km), routed: false };
		const mins = await osrmMinutes(a, b);
		if (mins == null) return { ...estimateTravel(km), routed: false };
		// Keep the human-friendly mode label, but use the real network duration.
		return { mode: km * 1.3 < 8 ? 'transit' : 'drive', mins, routed: true };
	});
}

/**
 * Overwrite each track's legs with real routed durations where available.
 * Falls back to the straight-line estimate per leg, so the calendar always
 * has travel times even when the router is unreachable.
 */
export async function routeTracks(tracks: TrackWithItems[]): Promise<void> {
	const jobs: Promise<void>[] = [];
	for (const track of tracks) {
		const items = track.items;
		for (let i = 0; i < items.length - 1; i++) {
			const a = items[i];
			const b = items[i + 1];
			if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) continue;
			jobs.push(
				routeLeg({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }).then((leg) => {
					a.travel_mode = leg.mode;
					a.travel_mins = leg.mins;
				})
			);
		}
	}
	await Promise.all(jobs);
}
