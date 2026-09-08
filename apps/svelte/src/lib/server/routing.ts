import type { TrackWithItems } from './schedule';

/** Great-circle distance in km. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
	const R = 6371;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLng = toRad(lng2 - lng1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

/** Straight-line fallback estimate, matching schedule.ts. */
function estimate(km: number): { mode: string; mins: number } {
	const dist = km * 1.3;
	if (dist < 1.1) return { mode: 'walk', mins: Math.max(3, Math.round((dist / 4.8) * 60)) };
	if (dist < 8) return { mode: 'transit', mins: Math.max(8, Math.round((dist / 16) * 60) + 6) };
	return { mode: 'drive', mins: Math.max(10, Math.round((dist / 30) * 60) + 5) };
}

interface Leg {
	mode: string;
	mins: number;
	routed: boolean;
}

const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const TIMEOUT_MS = 2500;
const cache = new Map<string, Leg>();

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
async function routeLeg(
	a: { lat: number; lng: number },
	b: { lat: number; lng: number }
): Promise<Leg> {
	const k = key(a, b);
	const hit = cache.get(k);
	if (hit) return hit;

	const km = haversineKm(a.lat, a.lng, b.lat, b.lng);
	let leg: Leg;
	// Short hops are walked; OSRM's public server is driving-only, so estimate those.
	if (km * 1.3 < 1.1) {
		leg = { ...estimate(km), routed: false };
	} else {
		const mins = await osrmMinutes(a, b);
		if (mins != null) {
			// Keep the human-friendly mode label, but use the real network duration.
			const mode = km * 1.3 < 8 ? 'transit' : 'drive';
			leg = { mode, mins, routed: true };
		} else {
			leg = { ...estimate(km), routed: false };
		}
	}
	cache.set(k, leg);
	return leg;
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
