import {
	DAY_END_MIN,
	EVENT_TYPE_LABELS,
	EVENT_TYPES,
	MIN_EVENT_MINS,
	TRANSPORT_MODES,
	type EventType,
	type PoiKind
} from '@trippy/core/types';
import type { Cell, SavedPoi } from './types';

export const DAY_END = DAY_END_MIN;
export { MIN_EVENT_MINS };
export const DRAFT_ID = 'draft';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayLabel(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	return `${WEEKDAYS[wd]}, ${MONTHS[m - 1]} ${d}`;
}

export function rangeLabel(from: string, to: string): string {
	const short = (iso: string) => {
		const [, m, d] = iso.split('-').map(Number);
		return `${MONTHS[m - 1]} ${d}`;
	};
	return `${short(from)} to ${short(to)}`;
}

const CLOCK = new Intl.DateTimeFormat('en-US', {
	timeZone: 'UTC',
	hour: 'numeric',
	minute: '2-digit',
	hour12: true
});

const at = (min: number) => new Date(Date.UTC(2000, 0, 1, 0, ((min % 1440) + 1440) % 1440));

export function clock(min: number): string {
	return CLOCK.format(at(min));
}

export function clockRange(from: number, to: number): string {
	const a = clock(from);
	const b = clock(to);
	const meridiem = a.slice(-2);
	return meridiem === b.slice(-2) ? `${a.slice(0, -3)} - ${b}` : `${a} - ${b}`;
}

export function parseClock(text: string): number | null {
	const raw = text.trim().toLowerCase();
	const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(raw);
	if (!m) return null;
	let hour = Number(m[1]);
	const minute = Number(m[2] ?? '0');
	if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59)
		return null;
	const mer = m[3];
	if (mer) {
		if (hour < 1 || hour > 12) return null;
		if (hour === 12) hour = 0;
		if (mer === 'pm') hour += 12;
	} else if (hour > 23) return null;
	return hour * 60 + minute;
}

export function timeText(min: number): string {
	return clock(min);
}

export function shiftDay(iso: string, delta: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

export function typeLabel(t: string): string {
	return EVENT_TYPE_LABELS[t as EventType] ?? t;
}

export const TYPE_OPTIONS = EVENT_TYPES.map((key) => ({ key, label: EVENT_TYPE_LABELS[key] }));

const MODE_LABELS: Record<string, string> = {
	walk: 'Walk',
	cycle: 'Cycle',
	transit: 'Transit',
	drive: 'Drive',
	ferry: 'Ferry',
	flight: 'Flight'
};

export const MODE_OPTIONS = TRANSPORT_MODES.map((key) => ({ key, label: MODE_LABELS[key] }));

export function modeLabel(mode: string | null): string {
	return mode ? (MODE_LABELS[mode] ?? mode) : '';
}

export function poiKindFor(type: EventType): PoiKind | null {
	if (type === 'food') return 'food';
	if (type === 'activity') return 'attraction';
	return null;
}

export function placeLabel(type: EventType): string {
	return type === 'travel' ? 'Ends at' : typeLabel(type);
}

export function deriveTitle(placeName: string | null, notes: string, type: EventType): string {
	if (placeName) return placeName;
	const line = notes.split('\n').find((l) => l.trim());
	if (line) return line.trim();
	return typeLabel(type);
}

export function keepsPick(from: EventType, to: EventType, picked: SavedPoi | null): boolean {
	if ((from === 'stay') !== (to === 'stay')) return false;
	const wanted = poiKindFor(to);
	return !picked || !wanted || (picked.kind ?? 'attraction') === wanted;
}

export function placeOptions(
	saved: SavedPoi[],
	cities: (Cell | null)[],
	currentCityId: string | null,
	type: EventType
) {
	const known = cities.filter((c): c is Cell => c != null);
	const names = new Map(known.map((c) => [c.id, c.name]));
	const rank = (id: string) =>
		id === currentCityId ? -1 : known.findIndex((c) => c.id === id) + 1 || known.length + 1;
	const wanted = poiKindFor(type);
	const offered = wanted ? saved.filter((p) => (p.kind ?? 'attraction') === wanted) : saved;
	return [...offered]
		.sort(
			(a, b) =>
				rank(a.city_id) - rank(b.city_id) || b.votes - a.votes || a.name.localeCompare(b.name)
		)
		.map((p) => ({
			key: p.id,
			label: p.name,
			detail: [
				names.get(p.city_id) ?? 'Elsewhere',
				p.votes ? `${p.votes} ${p.votes === 1 ? 'vote' : 'votes'}` : ''
			]
				.filter(Boolean)
				.join(', ')
		}));
}

export const NO_PEOPLE = 'An event must include at least one person.';
