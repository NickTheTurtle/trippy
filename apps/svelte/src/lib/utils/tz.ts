import { DateTime } from 'luxon';

/**
 * Time-zone helpers. Every timestamp is stored as UTC ISO plus the
 * owning Location's IANA zone; we render in the place's local time
 * with an optional viewer overlay.
 */

/** Render a stored UTC ISO timestamp in the place's local zone. */
export function inPlaceZone(utcIso: string, placeTz: string): DateTime {
	return DateTime.fromISO(utcIso, { zone: 'utc' }).setZone(placeTz);
}

/** Render the same instant in the viewer's home zone (overlay). */
export function inViewerZone(utcIso: string, viewerTz: string): DateTime {
	return DateTime.fromISO(utcIso, { zone: 'utc' }).setZone(viewerTz);
}

/** Convert a wall-clock time entered in a place's zone back to UTC ISO. */
export function placeWallToUtc(localIso: string, placeTz: string): string {
	return DateTime.fromISO(localIso, { zone: placeTz }).toUTC().toISO() ?? '';
}
