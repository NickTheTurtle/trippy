/**
 * Geographic helpers shared by everything that has to answer "how far apart are
 * these two stops, and how long does getting between them take?".
 *
 * This lived twice in `packages/server` (the calendar's inline estimate and the
 * router's fallback), which drifted the moment either was tuned. It is plain
 * arithmetic with no I/O, so it belongs here and both callers import it.
 */

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
	const R = 6371;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLng = toRad(lng2 - lng1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

export interface TravelEstimate {
	mode: string;
	mins: number;
}

/**
 * Rough door-to-door estimate from a straight-line distance. Used directly for
 * short hops, and as the fallback whenever the routing provider is unreachable.
 */
export function estimateTravel(km: number): TravelEstimate {
	// Real roads are longer than straight lines; pad the distance a little.
	const dist = km * 1.3;
	if (dist < 1.1) return { mode: 'walk', mins: Math.max(3, Math.round((dist / 4.8) * 60)) };
	if (dist < 8) return { mode: 'transit', mins: Math.max(8, Math.round((dist / 16) * 60) + 6) };
	return { mode: 'drive', mins: Math.max(10, Math.round((dist / 30) * 60) + 5) };
}

/** Estimated travel between two coordinates. */
export function estimateTravelBetween(
	lat1: number,
	lng1: number,
	lat2: number,
	lng2: number
): TravelEstimate {
	return estimateTravel(haversineKm(lat1, lng1, lat2, lng2));
}
