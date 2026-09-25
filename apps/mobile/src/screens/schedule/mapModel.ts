import { copy } from '@trippy/copy';
import type { Cell, EventRow, LegRow, SavedPoi } from './types';
import { clockRange, modeLabel, typeLabel } from './shared';

export type MobileMapPin = {
	key: string;
	lat: number;
	lng: number;
	title: string;
	subtitle?: string;
	detail: string[];
	color: string;
	number?: number;
	count: number;
	eventIds: string[];
	addId?: string;
	warn?: string;
};

export type MobileMapRoute = {
	key: string;
	color: string;
	points: { latitude: number; longitude: number }[];
};

export type MobileMapModel = {
	pins: MobileMapPin[];
	routes: MobileMapRoute[];
	region: { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };
};

const UNPLANNED = '#9aa39c';

export const EVENT_COLORS = {
	activity: '#2f7a4f',
	food: '#c15a25',
	stay: '#7b4fa6',
	travel: '#2f6d9e',
	freetime: '#8a8578'
} as const;

export function buildScheduleMapModel({
	events,
	stays,
	legs,
	saved,
	city,
	memberIds,
	peopleLabel,
	locked
}: {
	events: EventRow[];
	stays: EventRow[];
	legs: LegRow[];
	saved: SavedPoi[];
	city: Cell | null;
	memberIds: string[];
	peopleLabel: (ids: string[]) => string;
	locked: boolean;
}): MobileMapModel {
	const locatedEvents = [...events]
		.filter((event) => event.lat != null && event.lng != null)
		.sort((a, b) => a.start_min - b.start_min || (a.id < b.id ? -1 : 1));
	const eventPins = locatedEvents.map((event, index) => ({
		key: `event:${event.id}`,
		lat: event.lat as number,
		lng: event.lng as number,
		title: event.title,
		subtitle: `${typeLabel(event.type)} · ${clockRange(event.start_min, event.end_min)}`,
		detail: [peopleLabel(event.people)],
		color: EVENT_COLORS[event.type],
		number: index + 1,
		count: 1,
		eventIds: [event.id],
		warn: legs.some((leg) => leg.toEventId === event.id && leg.tight)
			? copy.viewAs.travelWarning
			: undefined
	}));
	const stayPins = stays
		.filter((stay) => stay.lat != null && stay.lng != null)
		.map((stay) => ({
			key: `stay:${stay.id}`,
			lat: stay.lat as number,
			lng: stay.lng as number,
			title: stay.title,
			subtitle: typeLabel(stay.type),
			detail: [peopleLabel(stay.people)],
			color: EVENT_COLORS.stay,
			count: 1,
			eventIds: [stay.id]
		}));
	const scheduledPoiIds = new Set(
		events.map((event) => event.poi_id).filter((id): id is string => id !== null)
	);
	const savedPins = locked
		? []
		: saved
				.filter((place) => place.lat != null && place.lng != null && !scheduledPoiIds.has(place.id))
				.map((place) => ({
					key: `saved:${place.id}`,
					lat: place.lat as number,
					lng: place.lng as number,
					title: place.name,
					subtitle: copy.ui.mapCard.savedLocation,
					detail: place.votes ? [copy.ui.mapCard.votes(place.votes)] : [],
					color: UNPLANNED,
					count: 1,
					eventIds: [],
					addId: place.id
				}));
	const pins = groupPins([...eventPins, ...stayPins, ...savedPins]);
	return { pins, routes: buildRoutes(locatedEvents, memberIds), region: frameRegion(pins, city) };
}

export function groupPins(pins: MobileMapPin[]): MobileMapPin[] {
	const byPoint = new Map<string, MobileMapPin>();
	for (const pin of pins) {
		const key = `${pin.lat},${pin.lng}|${pin.color}`;
		const existing = byPoint.get(key);
		if (!existing) {
			byPoint.set(key, pin);
			continue;
		}
		existing.title = `${existing.title}, ${pin.title}`;
		existing.count += 1;
		existing.eventIds.push(...pin.eventIds);
		existing.detail.push(...pin.detail);
		existing.addId ??= pin.addId;
		existing.warn ??= pin.warn;
	}
	return [...byPoint.values()];
}

function buildRoutes(events: EventRow[], memberIds: string[]): MobileMapRoute[] {
	const routes: MobileMapRoute[] = [];
	for (const member of memberIds) {
		const mine = events.filter(
			(event) => event.people.length === 0 || event.people.includes(member)
		);
		if (mine.length < 2) continue;
		routes.push({
			key: `route:${member}`,
			color: '#2f6d5e',
			points: mine.map((event) => ({
				latitude: event.lat as number,
				longitude: event.lng as number
			}))
		});
	}
	return routes;
}

export function frameRegion(pins: MobileMapPin[], city: Cell | null) {
	const located = pins.filter((pin) => pin.color !== UNPLANNED);
	const framed = located.length ? located : pins;
	if (!framed.length) {
		return {
			latitude: city?.lat ?? 20,
			longitude: city?.lng ?? 0,
			latitudeDelta: city?.lat != null ? 0.12 : 80,
			longitudeDelta: city?.lng != null ? 0.12 : 160
		};
	}
	const minLat = Math.min(...framed.map((pin) => pin.lat));
	const maxLat = Math.max(...framed.map((pin) => pin.lat));
	const minLng = Math.min(...framed.map((pin) => pin.lng));
	const maxLng = Math.max(...framed.map((pin) => pin.lng));
	return {
		latitude: (minLat + maxLat) / 2,
		longitude: (minLng + maxLng) / 2,
		latitudeDelta: Math.max(0.02, (maxLat - minLat) * 1.6 || 0.04),
		longitudeDelta: Math.max(0.02, (maxLng - minLng) * 1.6 || 0.04)
	};
}
