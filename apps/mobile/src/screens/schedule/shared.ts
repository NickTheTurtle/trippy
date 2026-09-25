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
export const DEFAULT_START = 6 * 60;
export const PX_PER_MIN = 1.15;

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

export function hourLabel(hour: number): string {
	return clock(hour * 60).replace(':00', '');
}

export function hoursFrom(start: number): number[] {
	const first = Math.ceil(start / 60);
	return Array.from({ length: DAY_END / 60 - first + 1 }, (_, i) => first + i);
}

export function windowStart(mins: readonly number[]): number {
	const earliest = mins.reduce((a, b) => Math.min(a, b), DEFAULT_START);
	return Math.min(DEFAULT_START, Math.max(0, Math.floor(earliest / 60) * 60));
}

export function clampMin(value: number, start: number): number {
	return Math.max(start, Math.min(value, DAY_END));
}

export function topPx(min: number, start: number): number {
	return (clampMin(min, start) - start) * PX_PER_MIN;
}

export function heightPx(from: number, to: number, start: number): number {
	return Math.max(3, (clampMin(to, start) - clampMin(from, start)) * PX_PER_MIN);
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
