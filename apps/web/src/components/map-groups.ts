import type { MapItem } from './GoogleMap';

/**
 * A point on the map and everything a track put there.
 *
 * Several saved places can share one set of coordinates: a venue added twice
 * from the same provider result, or three escape rooms run out of one building.
 * Drawn one pin per item they land exactly on top of each other, so the stack
 * reads as a single pin and only the topmost one can be hovered or tapped. The
 * rest are invisible and unreachable.
 */
export type MapPin = {
	lat: number;
	lng: number;
	/** What is here, in the order the track listed it. */
	items: MapItem[];
	/** Where the first of them sits in the track, 1-based, for a numbered pin. */
	index: number;
};

/**
 * Collapse the items of one track onto one pin per point.
 *
 * Grouped on **exact** coordinate equality, with no distance tolerance. The
 * trips in hand hold one co-located set, three saved places sharing a single
 * pair of doubles to the last digit, and not one pair of non-identical places
 * within 60m of each other. So the duplicates being complained about are
 * literally the same numbers, which is what happens when the same provider
 * result is saved twice, and a radius would buy nothing here while risking the
 * thing a radius always risks: merging two real venues that happen to share a
 * doorway. If near-duplicates ever do appear, that is the point to decide what
 * distance means, with the data to decide it on.
 *
 * Per track rather than across all of them. The tracks carry different colours
 * and different meanings, and a pin can only be one colour; the schedule board
 * already keeps a scheduled place out of the saved track, so the two cannot
 * collide on the same point anyway.
 *
 * Items without coordinates are dropped, as they were before: they are not on
 * the map at all.
 */
export function groupColocated(items: MapItem[]): MapPin[] {
	const pins: MapPin[] = [];
	const at = new Map<string, MapPin>();
	let n = 0;
	for (const item of items) {
		if (item.lat == null || item.lng == null) continue;
		n += 1;
		const key = `${item.lat},${item.lng}`;
		const here = at.get(key);
		if (here) {
			here.items.push(item);
			continue;
		}
		const pin: MapPin = { lat: item.lat, lng: item.lng, items: [item], index: n };
		at.set(key, pin);
		pins.push(pin);
	}
	return pins;
}
