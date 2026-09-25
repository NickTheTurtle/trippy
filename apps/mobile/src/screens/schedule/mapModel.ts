import { copy } from '@trippy/copy';
import type { Cell, EventRow, LegRow, SavedPoi } from './types';
import { clockRange, modeLabel, typeLabel } from './shared';

export type MobileMapPinEntry = {
	title: string;
	subtitle?: string;
	detail: string[];
	eventId?: string;
	addId?: string;
	warn?: string;
};

export type MobileMapPin = {
	key: string;
	lat: number;
	lng: number;
	title: string;
	subtitle?: string;
	detail: string[];
	entries: MobileMapPinEntry[];
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
const ROUTE_COLORS = ['#2f6d5e', '#c15a25', '#7b4fa6', '#2f7a4f', '#8a8578'];

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
	locked,
	singleViewer = memberIds.length === 1
}: {
	events: EventRow[];
	stays: EventRow[];
	legs: LegRow[];
	saved: SavedPoi[];
	city: Cell | null;
	memberIds: string[];
	peopleLabel: (ids: string[]) => string;
	locked: boolean;
	singleViewer?: boolean;
}): MobileMapModel {
	const locatedEvents = [...events]
		.filter((event) => event.lat != null && event.lng != null)
		.sort((a, b) => a.start_min - b.start_min || (a.id < b.id ? -1 : 1));
	const numbered = singleViewer || isSingleSequence(locatedEvents);
	const eventPins = locatedEvents.map((event, index) =>
		eventPin(event, index, numbered, legs, events, peopleLabel)
	);
	const stayPins = stays
		.filter((stay) => stay.lat != null && stay.lng != null)
		.map((stay) => {
			const entry = {
				title: stay.title,
				subtitle: typeLabel(stay.type),
				detail: [peopleLabel(stay.people)],
				eventId: stay.id
			};
			return {
				key: `stay:${stay.id}`,
				lat: stay.lat as number,
				lng: stay.lng as number,
				title: stay.title,
				subtitle: entry.subtitle,
				detail: entry.detail,
				entries: [entry],
				color: EVENT_COLORS.stay,
				count: 1,
				eventIds: [stay.id]
			};
		});
	const scheduledPoiIds = new Set(
		events.map((event) => event.poi_id).filter((id): id is string => id !== null)
	);
	const savedPins = saved
		.filter((place) => place.lat != null && place.lng != null && !scheduledPoiIds.has(place.id))
		.map((place) => {
			const subtitle = [copy.ui.mapCard.savedLocation, city?.name].filter(Boolean).join(' · ');
			const detail = place.votes ? [copy.ui.mapCard.votes(place.votes)] : [];
			const entry = {
				title: place.name,
				subtitle,
				detail,
				addId: locked ? undefined : place.id
			};
			return {
				key: `saved:${place.id}`,
				lat: place.lat as number,
				lng: place.lng as number,
				title: place.name,
				subtitle,
				detail,
				entries: [entry],
				color: UNPLANNED,
				count: 1,
				eventIds: [],
				addId: locked ? undefined : place.id
			};
		});
	const pins = groupPins([...eventPins, ...stayPins, ...savedPins]);
	return { pins, routes: buildRoutes(locatedEvents, memberIds), region: frameRegion(pins, city) };
}

function eventPin(
	event: EventRow,
	index: number,
	numbered: boolean,
	legs: LegRow[],
	events: EventRow[],
	peopleLabel: (ids: string[]) => string
): MobileMapPin {
	const subtitle = `${typeLabel(event.type)} · ${clockRange(event.start_min, event.end_min)}`;
	const warn = legs.some((leg) => leg.toEventId === event.id && leg.tight)
		? copy.viewAs.travelWarning
		: undefined;
	const detail = [peopleLabel(event.people), ...arrivalLines(event.id, legs, events)];
	const entry = { title: event.title, subtitle, detail, eventId: event.id, warn };
	return {
		key: `event:${event.id}`,
		lat: event.lat as number,
		lng: event.lng as number,
		title: event.title,
		subtitle,
		detail,
		entries: [entry],
		color: EVENT_COLORS[event.type],
		number: numbered ? index + 1 : undefined,
		count: 1,
		eventIds: [event.id],
		warn
	};
}

export function groupPins(pins: MobileMapPin[]): MobileMapPin[] {
	const byPoint = new Map<string, MobileMapPin>();
	for (const pin of pins) {
		const key = `${pin.lat},${pin.lng}`;
		const existing = byPoint.get(key);
		if (!existing) {
			byPoint.set(key, {
				...pin,
				entries: [...pin.entries],
				eventIds: [...pin.eventIds],
				detail: [...pin.detail]
			});
			continue;
		}
		existing.title = `${existing.title}, ${pin.title}`;
		existing.count += 1;
		existing.entries.push(...pin.entries);
		existing.eventIds.push(...pin.eventIds);
		existing.detail.push(...pin.detail);
		existing.addId ??= pin.addId;
		existing.warn ??= pin.warn;
	}
	return [...byPoint.values()];
}

function buildRoutes(events: EventRow[], memberIds: string[]): MobileMapRoute[] {
	const byPath = new Map<
		string,
		{ members: string[]; points: { latitude: number; longitude: number }[] }
	>();
	for (const member of memberIds) {
		const mine = events.filter(
			(event) => event.people.length === 0 || event.people.includes(member)
		);
		if (mine.length < 2) continue;
		const points = mine.map((event) => ({
			latitude: event.lat as number,
			longitude: event.lng as number
		}));
		const key = points.map((point) => `${point.latitude},${point.longitude}`).join('|');
		const existing = byPath.get(key);
		if (existing) existing.members.push(member);
		else byPath.set(key, { members: [member], points });
	}
	return [...byPath.values()].map((route, index) => ({
		key: `route:${route.members.join(',')}`,
		color: ROUTE_COLORS[index % ROUTE_COLORS.length],
		points: route.points
	}));
}

export function frameRegion(pins: MobileMapPin[], city: Cell | null) {
	const framed = pins.filter((pin) => pin.eventIds.length > 0);
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
	const arc = shortestLngArc(framed.map((pin) => pin.lng));
	return {
		latitude: (minLat + maxLat) / 2,
		longitude: normalizeLng(arc.start + arc.width / 2),
		latitudeDelta: Math.min(180, Math.max(0.02, (maxLat - minLat) * 1.6 || 0.04)),
		longitudeDelta: Math.min(360, Math.max(0.02, arc.width * 1.6 || 0.04))
	};
}

function isSingleSequence(events: EventRow[]): boolean {
	if (events.length < 2) return true;
	for (let i = 1; i < events.length; i++) {
		if (events[i].start_min < events[i - 1].end_min) return false;
	}
	const who = (event: EventRow) => (event.people.length ? [...event.people].sort().join(',') : '*');
	return events.every((event) => who(event) === who(events[0]));
}

function arrivalLines(eventId: string, legs: LegRow[], events: EventRow[]): string[] {
	const names = new Map(events.map((event) => [event.id, event.title]));
	return legs
		.filter((leg) => leg.toEventId === eventId)
		.slice(0, 3)
		.map((leg) => {
			const from = names.get(leg.fromEventId);
			const lead = from
				? `${modeLabel(leg.resolvedMode)} from ${from}`
				: modeLabel(leg.resolvedMode);
			return `${lead} · ${leg.resolvedMins}m`;
		});
}

function normalizeLng(lng: number): number {
	const value = ((((lng + 180) % 360) + 360) % 360) - 180;
	return value === -180 ? 180 : value;
}

function shortestLngArc(lngs: number[]): { start: number; width: number } {
	if (lngs.length <= 1) return { start: normalizeLng(lngs[0] ?? 0), width: 0 };
	const sorted = lngs
		.map((lng) => (normalizeLng(lng) < 0 ? normalizeLng(lng) + 360 : normalizeLng(lng)))
		.sort((a, b) => a - b);
	let bestGap = -1;
	let bestIndex = 0;
	for (let i = 0; i < sorted.length; i++) {
		const next = sorted[(i + 1) % sorted.length] + (i === sorted.length - 1 ? 360 : 0);
		const gap = next - sorted[i];
		if (gap > bestGap) {
			bestGap = gap;
			bestIndex = i;
		}
	}
	return { start: sorted[(bestIndex + 1) % sorted.length], width: 360 - bestGap };
}
