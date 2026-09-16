/**
 * Geographic helpers shared by everything that has to answer "how far apart are
 * these two stops?".
 *
 * This lived twice in `packages/server` (the calendar's inline estimate and the
 * router's fallback), which drifted the moment either was tuned. It is plain
 * arithmetic with no I/O, so it belongs here and both callers import it.
 *
 * *How long* that distance takes is deliberately not here: it lives once, in
 * `travel.ts`, as `minsByMode` and `guessLeg`. There used to be a second
 * estimate in this file, mode-blind past 8km and with no flight tier, and the
 * two drifted exactly as the server copies once did: the router took its
 * minutes from this file and its label from the other, so a 1000km leg was
 * labelled a flight and given 43 hours of driving. One estimator now answers
 * both halves of the question. See docs/DESIGN.md, "Travel time".
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
