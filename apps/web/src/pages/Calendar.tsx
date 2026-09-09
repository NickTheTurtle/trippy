import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError } from '../api';
import { useApi } from '../useApi';
import { useTrip } from './TripShell';
import Modal from '../components/Modal';
import Select, { type Option } from '../components/Select';
import MultiSelect from '../components/MultiSelect';
import GoogleMap, { type MapTrack } from '../components/GoogleMap';
import TripMap from '../components/TripMap';
import { localTime, zoneAbbr, localDayMinutes } from '@trippy/core/tz';
import { layoutDay, personBands, type Layout } from '@trippy/core/layout';
import '../calendar.css';

// --- Types mirroring GET /trips/:id/calendar --------------------------------

type Member = { id: string; name: string; role: string };
type Cell = { id: string; name: string; tz: string; lat: number | null; lng: number | null };
type Lodging = { name: string; tag: string; locked: number; url: string | null };

type ItemRow = {
	id: string;
	title: string;
	type: string;
	start_min: number;
	end_min: number;
	booking: string | null;
	travel_mode: string | null;
	travel_mins: number | null;
	travel_before_min: number | null;
	poi_id: string | null;
	lat: number | null;
	lng: number | null;
	assignees: string[];
};

type Track = {
	id: string;
	name: string;
	color: string;
	partyId: string | null;
	partyName: string | null;
	partyColor: string | null;
	partyMembers: string[];
	items: ItemRow[];
};

type Membership = {
	partyId: string;
	userId: string;
	day: string;
	startMin: number;
	endMin: number;
};

type Party = {
	id: string;
	name: string;
	color: string;
	isSolo: boolean;
	isDefault: boolean;
	sort: number;
};

type PartyCell = { city: Cell | null; lodging: Lodging | null };

type BoardEntry = {
	day: string;
	city: Cell | null;
	lodging: Lodging | null;
	partyCells: Record<string, PartyCell>;
	membership: Membership[];
	tracks: Track[];
};

type SavedPoi = {
	id: string;
	name: string;
	city_id: string;
	lat: number | null;
	lng: number | null;
};

type Data = {
	days: string[];
	day: string;
	view: string;
	board: BoardEntry[];
	members: Member[];
	dayCity: Cell | null;
	mapsKey: string;
	saved: SavedPoi[];
	parties: Party[];
	cities: { id: string; name: string }[];
};

/** An item with its track resolved, and the attendees the board should show. */
type DayEvent = ItemRow & {
	trackId: string;
	trackName: string;
	trackColor: string;
	people: string[];
};

type SwitchLine = { min: number; kind: 'split' | 'rejoin' | 'move'; label: string; detail: string };

// --- Board geometry ---------------------------------------------------------

/* The visible window is a fixed 8:00 to 18:00 rather than the full day: a
   24-hour board spends most of its height on hours nobody schedules, and the
   pixels-per-minute that makes a 30-minute block readable would make it
   scroll. Times outside the window are clamped onto the edges. */
const DAY_START = 8 * 60;
const DAY_END = 18 * 60;
const PX_PER_MIN = 1.2;
const HEAD_PX = 34;
const HOURS = Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => 8 + i);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayLabel(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	return `${WEEKDAYS[wd]}, ${MONTHS[m - 1]} ${d}`;
}

function hhmm(min: number): string {
	const h = Math.floor(min / 60);
	const m = min % 60;
	return `${h}:${String(m).padStart(2, '0')}`;
}

function shiftDay(iso: string, delta: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

function clampMin(v: number): number {
	return Math.max(DAY_START, Math.min(v, DAY_END));
}

const VIEW_OPTIONS = [
	{ v: 'day', label: 'Day' },
	{ v: '3day', label: '3-day' },
	{ v: 'people', label: 'People' },
	{ v: 'agenda', label: 'Agenda' }
];

const ITEM_TYPES: Option[] = [
	{ value: 'poi', label: 'Sight' },
	{ value: 'food', label: 'Food' },
	{ value: 'transport', label: 'Transport' },
	{ value: 'travel', label: 'Travel' },
	{ value: 'lodging', label: 'Lodging' },
	{ value: 'freetime', label: 'Free time' }
];

const DURATION_OPTIONS: Option[] = [
	{ value: '15', label: '15m' },
	{ value: '30', label: '30m' },
	{ value: '45', label: '45m' },
	{ value: '60', label: '1h' },
	{ value: '90', label: '1h 30m' },
	{ value: '120', label: '2h' },
	{ value: '180', label: '3h' },
	{ value: '240', label: '4h' }
];

const TRAVEL_OPTIONS: Option[] = [
	{ value: '0', label: 'None' },
	{ value: '10', label: '10m' },
	{ value: '15', label: '15m' },
	{ value: '30', label: '30m' },
	{ value: '45', label: '45m' },
	{ value: '60', label: '1h' }
];

const EDIT_TRAVEL_OPTIONS: Option[] = [
	{ value: '0', label: 'No travel' },
	{ value: '10', label: '+10m' },
	{ value: '15', label: '+15m' },
	{ value: '30', label: '+30m' },
	{ value: '45', label: '+45m' },
	{ value: '60', label: '+1h' }
];

/* 15-minute steps keep the picker short; dragging still snaps to 5. */
const START_OPTIONS: Option[] = Array.from(
	{ length: (DAY_END - DAY_START) / 15 + 1 },
	(_, i) => DAY_START + i * 15
).map((s) => ({ value: String(s), label: hhmm(s) }));

/** One-click standard slots: prefill title, type and length. */
const TEMPLATES = [
	{ label: 'Flight', type: 'transport', title: 'Flight', duration: '180' },
	{ label: 'Travel', type: 'travel', title: 'Travel', duration: '30' },
	{ label: 'Breakfast', type: 'food', title: 'Breakfast', duration: '60' },
	{ label: 'Lunch', type: 'food', title: 'Lunch', duration: '60' },
	{ label: 'Dinner', type: 'food', title: 'Dinner', duration: '90' },
	{ label: 'Coffee', type: 'food', title: 'Coffee break', duration: '30' },
	{ label: 'Free time', type: 'freetime', title: 'Free time', duration: '120' },
	{ label: 'Hotel', type: 'lodging', title: 'Hotel check-in', duration: '60' }
];

const BOOKING_ORDER = ['booked', 'tentative', 'unbooked'];

/**
 * Blocks clip their overflow, so on a five-room morning names end up sliced in
 * half. Budget the space instead: the title is clamped to `trows` lines and the
 * chips to `wrows` rows, both 15px, so the content is guaranteed to fit.
 * Anything past the budget collapses into a `+N` chip.
 */
function whoBudget(widthFrac: number, mins: number, title: string, lanePx: number) {
	const px = Math.max(36, widthFrac * lanePx - 16);
	const trows = Math.min(3, Math.max(1, Math.ceil((title.length * 7) / px)));
	const perRow = Math.max(1, Math.floor(px / 48));
	const free = mins * PX_PER_MIN - 14 - 16 - trows * 15;
	const wrows = Math.max(0, Math.min(4, Math.floor(free / 15)));
	return {
		trows,
		wrows,
		fit: wrows * perRow,
		compact: px < 150,
		showTime: px >= 92,
		showTag: px >= 58
	};
}

// --- Page -------------------------------------------------------------------

export default function Calendar() {
	const { trip } = useTrip();
	const base = `/trips/${trip.id}/calendar`;

	// Read-only: every day/view change is a <Link>, so the board stays addressable
	// and the browser's back button walks back through the days.
	const [params] = useSearchParams();
	const dayParam = params.get('day');
	const viewParam = params.get('view');

	/* The day and view live in the URL, as they did in SvelteKit: the board is
	   addressable, so a link to a specific day of the trip keeps working, and the
	   query string is also what the loader keys off. */
	const query = new URLSearchParams();
	if (dayParam) query.set('day', dayParam);
	if (viewParam) query.set('view', viewParam);
	const qs = query.toString();
	const { data, error, reload } = useApi<Data>(qs ? `${base}?${qs}` : base);

	const [notice, setNotice] = useState('');
	const [viewAs, setViewAs] = useState('');
	const [showAddTrack, setShowAddTrack] = useState(false);
	const [showSchedule, setShowSchedule] = useState(false);
	const [showCrews, setShowCrews] = useState(false);
	const [newTrackName, setNewTrackName] = useState('');
	const [newTrackParty, setNewTrackParty] = useState('');
	/** The event whose detail popup is open. */
	const [openEvent, setOpenEvent] = useState<DayEvent | null>(null);

	// Live drag/resize state for a single block.
	const [drag, setDrag] = useState<{
		id: string;
		pointerStartY: number;
		origStart: number;
		liveStart: number;
	} | null>(null);
	const [resize, setResize] = useState<{
		id: string;
		pointerStartY: number;
		startMin: number;
		origEnd: number;
		liveEnd: number;
	} | null>(null);
	/* Set while a pointer drag actually moves, so the click that follows a drag
	   does not also open the detail popup. A ref, not state: it is read during the
	   same event sequence that writes it and must never lag a render behind. */
	const didDrag = useRef(false);

	// Measured width of the day board's event area, for positioning arrows.
	const [laneW, setLaneW] = useState(0);
	const laneRef = useCallback((node: HTMLDivElement | null) => {
		if (!node) return;
		setLaneW(node.clientWidth);
		const ro = new ResizeObserver(() => setLaneW(node.clientWidth));
		ro.observe(node);
		return () => ro.disconnect();
	}, []);

	// Live clock for the destination city's zone.
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), 30_000);
		return () => clearInterval(id);
	}, []);

	async function act(fn: () => Promise<unknown>) {
		setNotice('');
		try {
			await fn();
			reload();
		} catch (err) {
			setNotice(err instanceof ApiError ? err.message : 'Something went wrong.');
		}
	}

	const itemOp = useCallback(
		(itemId: string, body: Record<string, unknown>) =>
			api(`${base}/items/${itemId}/op`, { method: 'POST', body }),
		[base]
	);

	const members = useMemo(() => data?.members ?? [], [data]);
	const memberName = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
	const memberOptions = useMemo(
		() => members.map((m) => ({ value: m.id, label: m.name })),
		[members]
	);

	/** First name only: arrow labels and chips get cramped fast. */
	const shortName = useCallback(
		(id: string) => (memberName.get(id) ?? '?').split(' ')[0],
		[memberName]
	);

	// Tracks and items with the "view as" filter applied.
	const filteredBoard = useMemo(() => {
		const itemVisible = (item: ItemRow) =>
			// Unassigned items are shared/whole-group, so always shown.
			!viewAs || item.assignees.length === 0 || item.assignees.includes(viewAs);
		// A lane is shown in "view as X" only when X belongs to that crew on the
		// day. The Everyone crew holds all members, so single-group trips are
		// unaffected.
		const trackVisible = (t: Track) => !viewAs || t.partyMembers.includes(viewAs);
		return (data?.board ?? []).map((b) => ({
			...b,
			tracks: b.tracks.filter(trackVisible).map((t) => ({ ...t, items: t.items.filter(itemVisible) }))
		}));
	}, [data, viewAs]);

	const anchor = useMemo(
		() => (data ? (data.board.find((b) => b.day === data.day) ?? data.board[0] ?? null) : null),
		[data]
	);
	// The add/schedule forms list every track regardless of the filter.
	const anchorTracks = anchor?.tracks ?? [];
	const filteredAnchor = data
		? (filteredBoard.find((b) => b.day === data.day) ?? filteredBoard[0] ?? null)
		: null;

	const defaultParty = data?.parties.find((p) => p.isDefault)?.id ?? null;

	/**
	 * Which crew's lens are we viewing a day through? Without "view as", the
	 * default Everyone crew. With it, the crew the viewer belongs to that day (the
	 * segment running latest into the day; else Everyone).
	 */
	const cellFor = useCallback(
		(entry: BoardEntry): PartyCell => {
			const mine = viewAs ? entry.membership.filter((m) => m.userId === viewAs) : [];
			const pid = !viewAs
				? defaultParty
				: mine.length
					? mine.reduce((a, b) => (b.endMin > a.endMin ? b : a)).partyId
					: defaultParty;
			const cell = pid ? entry.partyCells[pid] : null;
			return cell ?? { city: entry.city, lodging: entry.lodging };
		},
		[viewAs, defaultParty]
	);

	const anchorCityView = anchor ? cellFor(anchor).city : (data?.dayCity ?? null);

	/**
	 * Flatten a day's tracks into events with resolved attendees. Explicit
	 * assignees win; otherwise the event belongs to everyone on its track's crew.
	 * Layout and the swimlane both work off this, so "who is on this event" has a
	 * single answer.
	 */
	const eventsFor = useCallback(
		(entry: { tracks: Track[] } | null): DayEvent[] =>
			!entry
				? []
				: entry.tracks.flatMap((t) =>
						t.items.map((i) => ({
							...i,
							trackId: t.id,
							trackName: t.name,
							trackColor: t.color,
							people: i.assignees.length ? i.assignees : t.partyMembers
						}))
					),
		[]
	);

	const layoutFor = useCallback(
		(events: DayEvent[]) =>
			layoutDay(events.map((e) => ({ id: e.id, start: e.start_min, end: e.end_min, people: e.people }))),
		[]
	);

	const anchorEvents = useMemo(() => eventsFor(filteredAnchor), [eventsFor, filteredAnchor]);
	const anchorLayout = useMemo(() => layoutFor(anchorEvents), [layoutFor, anchorEvents]);
	const eventById = useMemo(() => new Map(anchorEvents.map((e) => [e.id, e])), [anchorEvents]);

	/**
	 * Arrows worth drawing: hops where the travelling group differs from either
	 * end's full party, and where the two events sit in different columns. A hop
	 * straight down the same column is just "what happens next" and needs no arrow.
	 */
	const anchorHops = useMemo(
		() =>
			anchorLayout.flows.filter((f) => {
				const from = eventById.get(f.from);
				const to = eventById.get(f.to);
				if (!from || !to) return false;
				const a = anchorLayout.placed.get(f.from);
				const b = anchorLayout.placed.get(f.to);
				if (!a || !b || a.col === b.col) return false;
				return f.people.length < from.people.length || f.people.length < to.people.length;
			}),
		[anchorLayout, eventById]
	);

	/**
	 * Split / rejoin moments for the day, derived from the event flow graph rather
	 * than from crew membership, since the events' attendee lists are the single
	 * source of truth for who is where. A moment is a "split" when one event feeds
	 * several, a "rejoin" when several feed one, and a "move" otherwise.
	 */
	const switchLines: SwitchLine[] = useMemo(() => {
		const byMin = new Map<number, typeof anchorHops>();
		for (const h of anchorHops) {
			const arr = byMin.get(h.at) ?? [];
			arr.push(h);
			byMin.set(h.at, arr);
		}
		return [...byMin.entries()]
			.map(([min, hops]) => {
				const froms = new Set(hops.map((h) => h.from));
				const tos = new Set(hops.map((h) => h.to));
				const kind: SwitchLine['kind'] =
					froms.size === 1 && tos.size > 1
						? 'split'
						: tos.size === 1 && froms.size > 1
							? 'rejoin'
							: 'move';
				const movers = [...new Set(hops.flatMap((h) => h.people))];
				const verb = { split: 'split off', rejoin: 'rejoin', move: 'switch' } as const;
				const label =
					movers.length === 1
						? `${shortName(movers[0])} → ${eventById.get(hops[0].to)?.title ?? 'elsewhere'}`
						: `${movers.length} people ${verb[kind]}`;
				const detail = hops
					.map(
						(h) =>
							`${h.people.map((p) => shortName(p)).join(', ')}: ` +
							`${eventById.get(h.from)?.title ?? '?'} → ${eventById.get(h.to)?.title ?? '?'}`
					)
					.join('\n');
				return { min, kind, label, detail };
			})
			.sort((a, b) => a.min - b.min);
	}, [anchorHops, eventById, shortName]);

	const allTracks = useMemo(() => filteredBoard.flatMap((b) => b.tracks), [filteredBoard]);

	/**
	 * Discovered places in the anchor day's city, shown as faded dots so it is easy
	 * to see which candidates sit near the scheduled stops. Ones already scheduled
	 * are skipped: they have a numbered pin already.
	 */
	const poiPinTrack: MapTrack | null = useMemo(() => {
		const cityId = anchorCityView?.id;
		if (!cityId || !data) return null;
		const scheduled = new Set(allTracks.flatMap((t) => t.items.map((i) => i.poi_id)));
		const items = data.saved
			.filter((p) => p.city_id === cityId && p.lat != null && p.lng != null && !scheduled.has(p.id))
			.map((p) => ({ title: p.name, lat: p.lat, lng: p.lng }));
		return items.length
			? { name: 'Places', color: '#9aa39c', items, line: false, dot: true }
			: null;
	}, [anchorCityView, data, allTracks]);

	const mapTracks: MapTrack[] = useMemo(
		() => (poiPinTrack ? [...allTracks, poiPinTrack] : allTracks),
		[allTracks, poiPinTrack]
	);

	const legs = useMemo(
		() =>
			allTracks.flatMap((t) =>
				t.items
					.filter((i) => i.travel_mins != null)
					.map((i) => ({
						id: i.id,
						title: i.title,
						mode: i.travel_mode,
						mins: i.travel_mins,
						tight: (i.travel_mins ?? 0) >= 25
					}))
			),
		[allTracks]
	);

	// --- Drag and resize ----------------------------------------------------

	function startFor(item: ItemRow): number {
		return drag && drag.id === item.id ? drag.liveStart : item.start_min;
	}
	function endFor(item: ItemRow): number {
		if (resize && resize.id === item.id) return resize.liveEnd;
		return startFor(item) + (item.end_min - item.start_min);
	}

	function onPointerDown(e: React.PointerEvent, item: ItemRow) {
		// Let button clicks and the resize grip through.
		if ((e.target as HTMLElement).closest('.tag, .bdel, .bresize')) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		didDrag.current = false;
		setDrag({
			id: item.id,
			pointerStartY: e.clientY,
			origStart: item.start_min,
			liveStart: item.start_min
		});
	}

	function onPointerMove(e: React.PointerEvent) {
		if (!drag) return;
		const y = e.clientY;
		if (Math.abs(y - drag.pointerStartY) > 3) didDrag.current = true;
		setDrag((d) =>
			d
				? // Snap the live position to 5-minute steps so the label never shows
					// decimals while dragging.
					{ ...d, liveStart: Math.round((d.origStart + (y - d.pointerStartY) / PX_PER_MIN) / 5) * 5 }
				: d
		);
	}

	async function onPointerUp() {
		if (!drag) return;
		const snapped = Math.round(drag.liveStart / 5) * 5;
		const { id, origStart } = drag;
		setDrag(null);
		if (snapped !== origStart) {
			await act(() => itemOp(id, { op: 'move', startMin: snapped }));
		}
	}

	function onResizeDown(e: React.PointerEvent, item: ItemRow) {
		e.stopPropagation();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		didDrag.current = false;
		setResize({
			id: item.id,
			pointerStartY: e.clientY,
			startMin: item.start_min,
			origEnd: item.end_min,
			liveEnd: item.end_min
		});
	}

	function onResizeMove(e: React.PointerEvent) {
		if (!resize) return;
		const y = e.clientY;
		if (Math.abs(y - resize.pointerStartY) > 3) didDrag.current = true;
		setResize((r) =>
			r
				? {
						...r,
						liveEnd: Math.max(
							r.startMin + 15,
							Math.round((r.origEnd + (y - r.pointerStartY) / PX_PER_MIN) / 5) * 5
						)
					}
				: r
		);
	}

	async function onResizeUp() {
		if (!resize) return;
		const snapped = Math.round(resize.liveEnd / 5) * 5;
		const { id, origEnd } = resize;
		setResize(null);
		if (snapped !== origEnd) {
			await act(() => itemOp(id, { op: 'resize', endMin: snapped }));
		}
	}

	/**
	 * Minutes-since-midnight for the "now" line on `day`, or null when that day is
	 * not today in the destination's zone (or now falls outside the window).
	 */
	function nowLineFor(day: string, tz: string | null | undefined): number | null {
		if (!tz) return null;
		const local = localDayMinutes(tz, now);
		if (local.day !== day) return null;
		if (local.minutes < DAY_START || local.minutes > DAY_END) return null;
		return local.minutes;
	}

	if (!data) return error ? <p className="text-warn">{error}</p> : null;

	const view = data.view;
	const wide = view === '3day' || view === 'people' || view === 'agenda';
	const navUrl = (day: string, v: string) => `?day=${day}&view=${v}`;

	const trackOptions = anchorTracks.map((t) => ({ value: t.id, label: t.name }));
	const crews = data.parties.filter((p) => !p.isDefault);
	const trackPartyChoices = data.parties.map((p) => ({
		value: p.isDefault ? '' : p.id,
		label: p.name
	}));

	/** Compact attendee text for dense single-line rows (agenda). */
	function peopleLabel(ids: string[], max = 3): string {
		if (ids.length === members.length) return 'Everyone';
		const names = ids.map((a) => memberName.get(a) ?? '?');
		if (names.length <= max) return names.join(', ');
		return `${names.slice(0, max).join(', ')} +${names.length - max}`;
	}

	/**
	 * SVG text cannot wrap or ellipsize, so a twenty-person merge would otherwise
	 * paint its whole roster across the board. Name a couple of people, count the rest.
	 */
	function hopLabel(people: string[]): string {
		if (people.length <= 3) return people.map((p) => shortName(p)).join(', ');
		return `${people
			.slice(0, 2)
			.map((p) => shortName(p))
			.join(', ')} +${people.length - 2}`;
	}

	function pctLeft(min: number): number {
		return ((clampMin(min) - DAY_START) / (DAY_END - DAY_START)) * 100;
	}
	function pctWidth(start: number, end: number): number {
		return ((clampMin(end) - clampMin(start)) / (DAY_END - DAY_START)) * 100;
	}

	async function addTrack() {
		const name = newTrackName.trim();
		await act(() =>
			api(`${base}/tracks`, {
				method: 'POST',
				body: { day: data!.day, name, partyId: newTrackParty || undefined }
			})
		);
		setNewTrackName('');
		setShowAddTrack(false);
	}

	// --- Board rendering ----------------------------------------------------

	function lodgingBanner(lodging: Lodging | null) {
		if (!lodging) return null;
		return (
			<div className={lodging.locked ? 'lodgeband locked' : 'lodgeband'}>
				<span className="lodgeicon" aria-hidden="true">
					🛏
				</span>
				<span className="lodgename">{lodging.name}</span>
				{lodging.tag && <span className="lodgetag">{lodging.tag}</span>}
				{lodging.locked ? (
					<span className="lodgepick">Booked stay</span>
				) : (
					<span className="muted small">top pick</span>
				)}
				{lodging.url && (
					<a className="lodgelink" href={lodging.url} target="_blank" rel="noopener">
						Details
					</a>
				)}
			</div>
		);
	}

	function switchStrip() {
		if (!switchLines.length) return null;
		return (
			<div className="switchbar daybar">
				<span className="switchcap muted small">Crew changes today</span>
				{switchLines.map((sw) => (
					<span key={sw.min} className={`switchpill ${sw.kind}`} title={sw.detail}>
						<span className="swico" aria-hidden="true">
							{sw.kind === 'rejoin' ? '⇄' : sw.kind === 'move' ? '→' : '⋔'}
						</span>
						<b>{hhmm(sw.min)}</b> {sw.label}
					</span>
				))}
			</div>
		);
	}

	function eventBoard({
		events,
		place,
		switches = [],
		day,
		tz,
		hops = [],
		measure = false,
		lanePx = 0
	}: {
		events: DayEvent[];
		place: Layout;
		switches?: SwitchLine[];
		day: string;
		tz: string | null;
		hops?: typeof anchorHops;
		measure?: boolean;
		lanePx?: number;
	}) {
		if (events.length === 0) {
			return (
				<div className="empty">
					<p>Nothing scheduled for this day.</p>
					<p className="muted">
						Add an event to start planning. Two events at the same time are laid out side by side.
					</p>
				</div>
			);
		}

		const nowMin = nowLineFor(day, tz);

		return (
			<div
				className="tracks"
				style={{ height: `${HEAD_PX + (DAY_END - DAY_START) * PX_PER_MIN + 20}px` }}
			>
				<div className="axis">
					{HOURS.map((h) => (
						<div
							key={h}
							className="hourline"
							style={{ top: `${(h * 60 - DAY_START) * PX_PER_MIN}px` }}
						>
							<span>{h}:00</span>
						</div>
					))}
				</div>

				{/* crew split / rejoin moments, drawn across the whole board */}
				{switches.map((sw) => (
					<div
						key={sw.min}
						className={`switchline ${sw.kind}`}
						style={{ top: `${HEAD_PX + (clampMin(sw.min) - DAY_START) * PX_PER_MIN}px` }}
						title={sw.detail}
					>
						<span className="switchtag">
							{hhmm(sw.min)} · {sw.label}
						</span>
					</div>
				))}

				{/* live "now" line, only on the day that is current in the city's zone */}
				{nowMin !== null && (
					<div
						className="nowline"
						style={{ top: `${HEAD_PX + (nowMin - DAY_START) * PX_PER_MIN}px` }}
					>
						<span className="nowtag">{hhmm(nowMin)}</span>
					</div>
				)}

				<div className="lane">
					{measure && <div ref={laneRef} className="lanemeasure" />}

					{/* people-flow arrows: who peels off where, and who rejoins */}
					{hops.length > 0 && laneW > 0 && (
						<svg
							className="flowlayer"
							viewBox={`0 0 ${laneW} ${(DAY_END - DAY_START) * PX_PER_MIN}`}
							width={laneW}
							height={(DAY_END - DAY_START) * PX_PER_MIN}
							aria-hidden="true"
						>
							<defs>
								<marker
									id="hoparrow"
									viewBox="0 0 8 8"
									refX="6"
									refY="4"
									markerWidth="6"
									markerHeight="6"
									orient="auto"
								>
									<path d="M0 0 L8 4 L0 8 z" fill="#6f6455" />
								</marker>
							</defs>
							{hops.map((hop) => {
								const a = place.placed.get(hop.from);
								const b = place.placed.get(hop.to);
								const ea = eventById.get(hop.from);
								const eb = eventById.get(hop.to);
								if (!a || !b || !ea || !eb) return null;
								const x1 = (a.left + a.width / 2) * laneW;
								const x2 = (b.left + b.width / 2) * laneW;
								const y1 = (clampMin(ea.end_min) - DAY_START) * PX_PER_MIN;
								const y2 = (clampMin(eb.start_min) - DAY_START) * PX_PER_MIN;
								const dy = Math.max(18, Math.abs(y2 - y1) / 2);
								const d = `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
								return (
									<g key={`${hop.from}-${hop.to}`}>
										<path className="hophalo" d={d} />
										<path className="hoppath" d={d} markerEnd="url(#hoparrow)" />
										<text className="hopcount" x={(x1 + x2) / 2} y={(y1 + y2) / 2 + dy / 2}>
											<title>{hop.people.map((p) => shortName(p)).join(', ')}</title>
											{hopLabel(hop.people)}
										</text>
									</g>
								);
							})}
						</svg>
					)}

					{events.map((item) => {
						const p = place.placed.get(item.id);
						if (!p) return null;
						const box = {
							left: `${p.left * 100}%`,
							width: `calc(${p.width * 100}% - 6px)`
						};
						const bud = whoBudget(
							p.width,
							endFor(item) - startFor(item),
							item.title,
							lanePx || 560
						);
						const open = () => {
							if (didDrag.current) return;
							setOpenEvent(item);
						};
						const cls = [
							'block',
							item.type,
							item.booking === 'unbooked' ? 'unbooked' : '',
							drag?.id === item.id ? 'dragging' : '',
							resize?.id === item.id ? 'resizing' : '',
							openEvent?.id === item.id ? 'editingnow' : '',
							p.width < 0.34 ? 'narrow' : ''
						]
							.filter(Boolean)
							.join(' ');

						return (
							<div key={item.id}>
								{item.travel_before_min ? (
									<div
										className="buffer"
										title={`${item.travel_before_min} min travel before`}
										style={{
											...box,
											top: `${(startFor(item) - item.travel_before_min - DAY_START) * PX_PER_MIN}px`,
											height: `${item.travel_before_min * PX_PER_MIN}px`,
											['--c' as string]: item.trackColor
										}}
									>
										<span>{item.travel_before_min}m travel</span>
									</div>
								) : null}

								<div
									className={cls}
									role="button"
									tabIndex={0}
									aria-label={`${item.title}, ${hhmm(item.start_min)} to ${hhmm(item.end_min)}. Click to open, drag to reschedule.`}
									style={{
										...box,
										top: `${(startFor(item) - DAY_START) * PX_PER_MIN}px`,
										height: `${(endFor(item) - startFor(item)) * PX_PER_MIN}px`,
										['--c' as string]: item.trackColor,
										['--trows' as string]: bud.trows,
										['--wrows' as string]: bud.wrows
									}}
									onPointerDown={(e) => onPointerDown(e, item)}
									onPointerMove={onPointerMove}
									onPointerUp={onPointerUp}
									onClick={(e) => {
										if ((e.target as HTMLElement).closest('.tag, .bdel, .bresize')) return;
										open();
									}}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											setOpenEvent(item);
										}
									}}
								>
									<div className="bt">{item.title}</div>
									<div className="bmeta">
										{bud.showTime && (
											<span>
												{bud.compact
													? hhmm(startFor(item))
													: `${hhmm(startFor(item))}-${hhmm(endFor(item))}`}
											</span>
										)}
										{item.booking && bud.showTag && (
											<button
												type="button"
												className={`tag ${item.booking}`}
												onClick={() => act(() => itemOp(item.id, { op: 'cycle' }))}
											>
												{item.booking}
											</button>
										)}
									</div>
									<div className="bwho">
										{item.people.length === members.length ? (
											<span className="who all">Everyone</span>
										) : item.people.length <= bud.fit ? (
											item.people.map((a) => (
												<span key={a} className="who">
													{shortName(a)}
												</span>
											))
										) : bud.fit > 0 ? (
											<>
												{item.people.slice(0, bud.fit - 1).map((a) => (
													<span key={a} className="who">
														{shortName(a)}
													</span>
												))}
												<span
													className="who more"
													title={item.people.map((a) => shortName(a)).join(', ')}
												>
													+{item.people.length - (bud.fit - 1)}
												</span>
											</>
										) : null}
									</div>
									<button
										type="button"
										className="bdel"
										title="Remove"
										aria-label={`Remove ${item.title}`}
										onClick={() => act(() => itemOp(item.id, { op: 'delete' }))}
									>
										×
									</button>
									<div
										className="bresize"
										role="separator"
										aria-label="Drag to change end time"
										onPointerDown={(e) => onResizeDown(e, item)}
										onPointerMove={onResizeMove}
										onPointerUp={onResizeUp}
									/>
								</div>
							</div>
						);
					})}
				</div>
			</div>
		);
	}

	function swimlane() {
		if (anchorEvents.length === 0) {
			return (
				<div className="empty">
					<p>Nothing scheduled for this day.</p>
					<p className="muted">Add an event and each person's day will appear as a band here.</p>
				</div>
			);
		}
		const swimPeople = viewAs ? members.filter((m) => m.id === viewAs) : members;
		const bands = personBands(
			anchorEvents.map((e) => ({
				id: e.id,
				start: e.start_min,
				end: e.end_min,
				people: e.people
			})),
			swimPeople.map((m) => m.id),
			DAY_START,
			DAY_END
		);
		const nowMin = nowLineFor(data!.day, anchorCityView?.tz ?? null);

		return (
			<div className="swim">
				<div className="swimhead">
					<span className="swimname" />
					<div className="swimaxis">
						{HOURS.map((h) => (
							<span key={h} className="swimhour" style={{ left: `${pctLeft(h * 60)}%` }}>
								{h}:00
							</span>
						))}
					</div>
				</div>

				<div className="swimbody">
					{/* one overlay for the whole board: split / rejoin moments and "now" */}
					<div className="swimlines">
						{switchLines.map((sw) => (
							<span
								key={sw.min}
								className={`swimswitch ${sw.kind}`}
								style={{ left: `${pctLeft(sw.min)}%` }}
								title={sw.detail}
							>
								<span className="swimswtag">{hhmm(sw.min)}</span>
							</span>
						))}
						{nowMin !== null && <span className="swimnow" style={{ left: `${pctLeft(nowMin)}%` }} />}
					</div>

					{swimPeople.map((person) => (
						<div key={person.id} className="swimrow">
							<span className="swimname" title={memberName.get(person.id)}>
								{shortName(person.id)}
							</span>
							<div className="swimtrack">
								{HOURS.map((h) => (
									<span key={h} className="swimgrid" style={{ left: `${pctLeft(h * 60)}%` }} />
								))}
								{(bands.get(person.id) ?? []).map((band) => {
									const ev = band.eventId ? eventById.get(band.eventId) : null;
									const pos = {
										left: `${pctLeft(band.start)}%`,
										width: `${pctWidth(band.start, band.end)}%`
									};
									if (!ev) {
										return (
											<span
												key={`free-${band.start}`}
												className="swimfree"
												style={pos}
												title={`Free ${hhmm(band.start)}–${hhmm(band.end)}`}
											/>
										);
									}
									return (
										<button
											key={ev.id}
											type="button"
											className={`swimband ${ev.type}`}
											style={{ ...pos, ['--c' as string]: ev.trackColor }}
											title={`${ev.title} · ${hhmm(ev.start_min)}–${hhmm(ev.end_min)}\nWith: ${ev.people
												.map((p) => shortName(p))
												.join(', ')}`}
											onClick={() => setOpenEvent(ev)}
										>
											<span className="swimlabel">{ev.title}</span>
										</button>
									);
								})}
							</div>
						</div>
					))}
				</div>

				<p className="swimhint muted small">
					Each row is one person's day. Where rows change colour at the same moment, the group split
					or came back together.
				</p>
			</div>
		);
	}

	function agendaDay(entry: BoardEntry) {
		const cell = cellFor(entry);
		const bare = entry.tracks.length === 0 || entry.tracks.every((t) => t.items.length === 0);
		return (
			<div key={entry.day} className="agday">
				<div className="agdayhead">
					<Link to={navUrl(entry.day, 'day')}>{dayLabel(entry.day)}</Link>
					{cell.city && <span className="muted">{cell.city.name}</span>}
					{cell.lodging && <span className="aglodge">🛏 {cell.lodging.name}</span>}
				</div>
				{bare ? (
					<p className="muted small agempty">Nothing scheduled.</p>
				) : (
					entry.tracks.map((track) =>
						track.items.length ? (
							<div key={track.id}>
								<div className="agtrack">
									<span className="agswatch" style={{ background: track.color }} />
									<span className="agtname">{track.name}</span>
								</div>
								<ul className="aglist">
									{track.items.map((item) => (
										<li key={item.id}>
											<span className="agtime">
												{hhmm(item.start_min)}–{hhmm(item.end_min)}
											</span>
											<span className="agtitle">{item.title}</span>
											{item.assignees.length > 0 && (
												<span
													className="agwho muted small"
													title={item.assignees.map((a) => memberName.get(a) ?? '?').join(', ')}
												>
													{peopleLabel(item.assignees)}
												</span>
											)}
											{item.travel_mins != null && (
												<span className="muted small">
													{item.travel_mode} · {item.travel_mins}m to next
												</span>
											)}
											{item.booking && <span className={`tag ${item.booking}`}>{item.booking}</span>}
										</li>
									))}
								</ul>
							</div>
						) : null
					)
				)}
			</div>
		);
	}

	return (
		<div className="cal">
			<div className="toolbar">
				<div className="navgroup">
					<div className="daynav">
						<Link className="navbtn" to={navUrl(shiftDay(data.day, -1), view)} aria-label="Previous day">
							‹
						</Link>
						<span className="curday">{dayLabel(data.day)}</span>
						<Link className="navbtn" to={navUrl(shiftDay(data.day, 1), view)} aria-label="Next day">
							›
						</Link>
					</div>
					<div className="viewswitch">
						{VIEW_OPTIONS.map((o) => (
							<Link
								key={o.v}
								className={o.v === view ? 'vbtn on' : 'vbtn'}
								to={navUrl(data.day, o.v)}
							>
								{o.label}
							</Link>
						))}
					</div>
				</div>
				<div className="tools">
					{anchorCityView && (
						<span
							className="zone"
							title={`Schedule times are in ${anchorCityView.name} local time`}
						>
							<span className="zdot" />
							{anchorCityView.name} · {localTime(anchorCityView.tz, now)}{' '}
							{zoneAbbr(anchorCityView.tz, now)}
						</span>
					)}
					<div className="viewas" title="Show one person's schedule">
						<span className="vaicon" aria-hidden="true">
							👤
						</span>
						<Select
							value={viewAs}
							onChange={setViewAs}
							options={[{ value: '', label: 'Everyone' }, ...memberOptions]}
							ariaLabel="View schedule as"
							compact
						/>
					</div>
					<button className="btn" type="button" onClick={() => setShowCrews(true)}>
						Crews
					</button>
					<button className="btn" type="button" onClick={() => setShowAddTrack((v) => !v)}>
						+ Add track
					</button>
					<button
						className="btn primary"
						type="button"
						disabled={anchorTracks.length === 0}
						onClick={() => setShowSchedule(true)}
					>
						+ Event
					</button>
				</div>
			</div>

			{notice && (
				<p role="alert" className="mb-4 text-[0.9rem] text-danger-ink">
					{notice}
				</p>
			)}

			{showAddTrack && (
				<form
					className="addtrack card"
					onSubmit={(e) => {
						e.preventDefault();
						addTrack();
					}}
				>
					<input
						autoFocus
						aria-label="Track name"
						placeholder="Track name, e.g. Museum group"
						value={newTrackName}
						onChange={(e) => setNewTrackName(e.target.value)}
					/>
					{crews.length > 0 && (
						<Select
							value={newTrackParty}
							onChange={setNewTrackParty}
							options={trackPartyChoices}
							ariaLabel="Crew for this track"
							compact
						/>
					)}
					<button className="btn primary" type="submit">
						Add
					</button>
				</form>
			)}

			<div className={wide ? 'split wide' : 'split'}>
				<div className="boardcol">
					{view === 'agenda' ? (
						<div className="agenda card">{filteredBoard.map((entry) => agendaDay(entry))}</div>
					) : view === 'people' ? (
						<div className="board card">
							{lodgingBanner(filteredAnchor ? cellFor(filteredAnchor).lodging : null)}
							{switchStrip()}
							{swimlane()}
						</div>
					) : view === 'day' ? (
						<div className="board card">
							{lodgingBanner(filteredAnchor ? cellFor(filteredAnchor).lodging : null)}
							{switchStrip()}
							{eventBoard({
								events: anchorEvents,
								place: anchorLayout,
								switches: switchLines,
								day: data.day,
								tz: anchorCityView?.tz ?? null,
								hops: anchorHops,
								measure: true,
								lanePx: laneW
							})}
						</div>
					) : (
						<div className="multiboard">
							{filteredBoard.map((entry) => {
								const evs = eventsFor(entry);
								const cell = cellFor(entry);
								return (
									<div key={entry.day} className="board card dayblock">
										<div className="dayblockhead">
											<Link className="dayblocklink" to={navUrl(entry.day, 'day')}>
												{dayLabel(entry.day)}
											</Link>
											{cell.city && <span className="muted">{cell.city.name}</span>}
										</div>
										{lodgingBanner(cell.lodging)}
										{eventBoard({
											events: evs,
											place: layoutFor(evs),
											day: entry.day,
											tz: cell.city?.tz ?? null,
											lanePx: 250
										})}
									</div>
								);
							})}
						</div>
					)}
				</div>

				{!wide && (
					<aside className="mapwrap card">
						{data.mapsKey ? (
							<GoogleMap tracks={mapTracks} apiKey={data.mapsKey} center={anchorCityView} />
						) : (
							<TripMap tracks={mapTracks} />
						)}
						<div className="legs">
							{poiPinTrack && (
								<p className="maplegend muted small">
									<span className="dotmark" /> Discovered places (not yet scheduled)
								</p>
							)}
							<h4>Travel legs</h4>
							{legs.length ? (
								<ul>
									{legs.map((l) => (
										<li key={l.id} className={l.tight ? 'warn-leg' : undefined}>
											<span>{l.title}</span>
											<span className={l.tight ? undefined : 'muted'}>
												{l.mode} · {l.mins}m
											</span>
										</li>
									))}
								</ul>
							) : (
								<p className="muted small">No travel legs yet.</p>
							)}
							<p className="hint muted">
								Click a block to open its details. Drag to reschedule, drag the bottom edge to
								resize. Click its status to cycle booked, tentative, unbooked.
							</p>
						</div>
					</aside>
				)}
			</div>

			{showSchedule && anchorTracks.length > 0 && (
				<AddEvent
					subtitle={dayLabel(data.day)}
					tracks={trackOptions}
					saved={data.saved}
					memberOptions={memberOptions}
					onClose={() => setShowSchedule(false)}
					onSubmit={async (body) => {
						await api(`${base}/items`, { method: 'POST', body });
						reload();
						setShowSchedule(false);
					}}
				/>
			)}

			{openEvent && (
				<EventDetail
					key={openEvent.id}
					event={openEvent}
					subtitle={`${openEvent.trackName} · ${dayLabel(data.day)}`}
					cityName={anchorCityView?.name ?? null}
					memberOptions={memberOptions}
					onClose={() => setOpenEvent(null)}
					onCycle={async () => {
						await itemOp(openEvent.id, { op: 'cycle' });
						reload();
					}}
					onDelete={() => {
						const id = openEvent.id;
						setOpenEvent(null);
						act(() => itemOp(id, { op: 'delete' }));
					}}
					onSave={async (edit) => {
						/* Four calls, because the API keeps position, size and content as
						   separate operations: they have different validity rules (a resize
						   can be rejected for crossing its start) and the board fires them
						   individually while dragging. */
						await itemOp(openEvent.id, {
							op: 'edit',
							title: edit.title,
							type: edit.type,
							travelBefore: edit.travelBefore
						});
						await itemOp(openEvent.id, { op: 'move', startMin: edit.startMin });
						await itemOp(openEvent.id, { op: 'resize', endMin: edit.endMin });
						await api(`${base}/items/${openEvent.id}/assignees`, {
							method: 'PUT',
							body: { assignees: edit.assignees }
						});
						setOpenEvent(null);
						reload();
					}}
				/>
			)}

			{showCrews && (
				<Crews
					subtitle={dayLabel(data.day)}
					day={data.day}
					base={base}
					parties={data.parties}
					members={members}
					membership={anchor?.membership ?? []}
					partyCells={anchor?.partyCells ?? {}}
					cities={data.cities}
					defaultParty={defaultParty}
					act={act}
					onClose={() => setShowCrews(false)}
				/>
			)}
		</div>
	);
}

// --- Dialogs ----------------------------------------------------------------

function AddEvent({
	subtitle,
	tracks,
	saved,
	memberOptions,
	onClose,
	onSubmit
}: {
	subtitle: string;
	tracks: Option[];
	saved: SavedPoi[];
	memberOptions: Option[];
	onClose: () => void;
	onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
	const [title, setTitle] = useState('');
	const [type, setType] = useState('poi');
	const [duration, setDuration] = useState('60');
	const [travel, setTravel] = useState('0');
	const [poi, setPoi] = useState('');
	const [trackId, setTrackId] = useState(tracks[0]?.value ?? '');
	const [start, setStart] = useState(String(9 * 60));
	const [assignees, setAssignees] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState('');

	// Keep the track selection valid as the day's tracks change under it.
	useEffect(() => {
		if (tracks.length && !tracks.some((t) => t.value === trackId)) setTrackId(tracks[0].value);
	}, [tracks, trackId]);

	const poiOptions: Option[] = [
		{ value: '', label: 'No place (custom)' },
		...saved.map((p) => ({ value: p.id, label: p.name }))
	];

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setErr('');
		try {
			await onSubmit({
				trackId,
				start: Number(start),
				duration: Number(duration),
				travelBefore: Number(travel),
				title: title.trim(),
				type,
				poiId: poi || undefined,
				assignees
			});
		} catch (ex) {
			setErr(ex instanceof ApiError ? ex.message : 'Could not add that event.');
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal open title="Add event" subtitle={subtitle} size="lg" onClose={onClose}>
			<form className="mform schedule" onSubmit={submit}>
				<div className="mbody">
					<div className="templates">
						<span className="tlabel muted">Quick add:</span>
						{TEMPLATES.map((t) => (
							<button
								key={t.label}
								type="button"
								className="tchip"
								onClick={() => {
									setTitle(t.title);
									setType(t.type);
									setDuration(t.duration);
								}}
							>
								{t.label}
							</button>
						))}
					</div>

					<div className="srow">
						<label className="grow">
							<span>Title</span>
							<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
						</label>
						<label className="grow">
							<span>Place {type === 'freetime' ? '(n/a for free time)' : ''}</span>
							<Select
								value={poi}
								onChange={setPoi}
								options={poiOptions}
								placeholder="No place (custom)"
								ariaLabel="Place"
							/>
						</label>
						<label className="tf2">
							<span>Type</span>
							<Select value={type} onChange={setType} options={ITEM_TYPES} ariaLabel="Activity type" />
						</label>
					</div>

					<div className="srow">
						<label className="tftrack">
							<span>Track</span>
							<Select value={trackId} onChange={setTrackId} options={tracks} ariaLabel="Track" />
						</label>
						<label className="tf2">
							<span>Start</span>
							<Select
								value={start}
								onChange={setStart}
								options={START_OPTIONS}
								ariaLabel="Start time"
							/>
						</label>
						<label className="tf2">
							<span>Length</span>
							<Select
								value={duration}
								onChange={setDuration}
								options={DURATION_OPTIONS}
								ariaLabel="Length"
							/>
						</label>
						<label className="tf2">
							<span>Travel before</span>
							<Select
								value={travel}
								onChange={setTravel}
								options={TRAVEL_OPTIONS}
								ariaLabel="Travel before"
							/>
						</label>
						<label className="tf3">
							<span>Assign to</span>
							<MultiSelect
								selected={assignees}
								onChange={setAssignees}
								options={memberOptions}
								placeholder="Everyone"
							/>
						</label>
					</div>

					<div className="sactions">
						<span className="muted hint-inline">
							Pick a place to carry its location (and onward travel times). Add a title for what
							you'll do there, handy when one place has several activities. Assign people, or leave
							as everyone.
						</span>
					</div>
				</div>
				<div className="mfoot">
					{err && (
						<p role="alert" className="mfoot-note m-0 text-[0.86rem] text-danger-ink">
							{err}
						</p>
					)}
					<button className="btn" type="button" onClick={onClose}>
						Cancel
					</button>
					<button className="btn primary" type="submit" disabled={busy}>
						Add to schedule
					</button>
				</div>
			</form>
		</Modal>
	);
}

function EventDetail({
	event,
	subtitle,
	cityName,
	memberOptions,
	onClose,
	onSave,
	onDelete,
	onCycle
}: {
	event: DayEvent;
	subtitle: string;
	cityName: string | null;
	memberOptions: Option[];
	onClose: () => void;
	onSave: (edit: {
		title: string;
		type: string;
		travelBefore: string;
		startMin: number;
		endMin: number;
		assignees: string[];
	}) => Promise<void>;
	onDelete: () => void;
	onCycle: () => Promise<void>;
}) {
	const [title, setTitle] = useState(event.title);
	const [type, setType] = useState(event.type);
	const [start, setStart] = useState(String(event.start_min));
	const [duration, setDuration] = useState(String(event.end_min - event.start_min));
	const [travelBefore, setTravelBefore] = useState(String(event.travel_before_min ?? 0));
	const [assignees, setAssignees] = useState<string[]>([...event.assignees]);
	// Kept locally so cycling the status updates the pill without closing the popup.
	const [booking, setBooking] = useState(event.booking);
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState('');

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (saving) return;
		setSaving(true);
		setErr('');
		try {
			const startMin = Number(start);
			await onSave({
				title,
				type,
				travelBefore,
				startMin,
				endMin: startMin + Number(duration),
				assignees
			});
		} catch (ex) {
			setErr(ex instanceof ApiError ? ex.message : 'Could not save that.');
			setSaving(false);
		}
	}

	return (
		<Modal
			open
			title="Event details"
			subtitle={subtitle}
			swatch={event.trackColor}
			size="md"
			onClose={onClose}
		>
			<form className="mform schedule" onSubmit={submit}>
				<div className="mbody">
					<div className="srow">
						<label className="grow">
							<span>Title</span>
							<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
						</label>
						<label>
							<span>Type</span>
							<Select value={type} onChange={setType} options={ITEM_TYPES} ariaLabel="Type" />
						</label>
					</div>

					<div className="srow">
						<label>
							<span>Start</span>
							<Select
								value={start}
								onChange={setStart}
								options={START_OPTIONS}
								ariaLabel="Start time"
							/>
						</label>
						<label>
							<span>Duration</span>
							<Select
								value={duration}
								onChange={setDuration}
								options={DURATION_OPTIONS}
								ariaLabel="Duration"
							/>
						</label>
						<label>
							<span>Travel before</span>
							<Select
								value={travelBefore}
								onChange={setTravelBefore}
								options={EDIT_TRAVEL_OPTIONS}
								ariaLabel="Travel before"
							/>
						</label>
					</div>

					<div className="srow">
						<label className="grow">
							<span>Who's going</span>
							<MultiSelect
								selected={assignees}
								onChange={setAssignees}
								options={memberOptions}
								placeholder="Everyone on this track"
							/>
						</label>
					</div>

					<div className="dfacts">
						<span className="dfact">
							🕑 {hhmm(Number(start))}–{hhmm(Number(start) + Number(duration))}
							{cityName && <span className="muted"> · {cityName} time</span>}
						</span>
						{event.travel_mins != null && (
							<span className="dfact">
								🚇 {event.travel_mode} · {event.travel_mins}m to next stop
							</span>
						)}
						{booking && (
							<button
								type="button"
								className={`tag ${booking}`}
								onClick={() => {
									const i = BOOKING_ORDER.indexOf(booking ?? 'unbooked');
									setBooking(BOOKING_ORDER[(i + 1) % BOOKING_ORDER.length]);
									onCycle();
								}}
							>
								{booking}
							</button>
						)}
					</div>
				</div>

				<div className="mfoot">
					{err && (
						<p role="alert" className="mfoot-note m-0 text-[0.86rem] text-danger-ink">
							{err}
						</p>
					)}
					<button type="button" className="btn danger mfoot-note" onClick={onDelete}>
						Delete
					</button>
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button className="btn primary" type="submit" disabled={saving}>
						{saving ? 'Saving…' : 'Save'}
					</button>
				</div>
			</form>
		</Modal>
	);
}

function Crews({
	subtitle,
	day,
	base,
	parties,
	members,
	membership,
	partyCells,
	cities,
	defaultParty,
	act,
	onClose
}: {
	subtitle: string;
	day: string;
	base: string;
	parties: Party[];
	members: Member[];
	membership: Membership[];
	partyCells: Record<string, PartyCell>;
	cities: { id: string; name: string }[];
	defaultParty: string | null;
	act: (fn: () => Promise<unknown>) => Promise<void>;
	onClose: () => void;
}) {
	const everyone = parties.find((p) => p.isDefault) ?? null;
	const crews = parties.filter((p) => !p.isDefault);

	const [newCrewName, setNewCrewName] = useState('');
	const [crewCity, setCrewCity] = useState<Record<string, string>>({});
	const [crewEdit, setCrewEdit] = useState<Record<string, { name: string; color: string }>>({});
	const [splitMembers, setSplitMembers] = useState<string[]>([]);
	const [splitParty, setSplitParty] = useState('');
	const [splitFrom, setSplitFrom] = useState(String(DAY_START));

	// Seed the per-crew pickers from the resolved values whenever the day or the
	// crew list changes under the dialog.
	useEffect(() => {
		const city: Record<string, string> = {};
		const edit: Record<string, { name: string; color: string }> = {};
		for (const c of crews) {
			city[c.id] = partyCells[c.id]?.city?.id ?? '';
			edit[c.id] = { name: c.name, color: c.color };
		}
		setCrewCity(city);
		setCrewEdit(edit);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [day, parties, partyCells]);

	/** The crew a member ends the day with: their end-of-day location. */
	function endOfDayParty(userId: string): string | null {
		const mine = membership.filter((m) => m.userId === userId);
		if (!mine.length) return defaultParty;
		return mine.reduce((a, b) => (b.endMin > a.endMin ? b : a)).partyId;
	}
	const membersOf = (partyId: string | null) =>
		members.filter((m) => endOfDayParty(m.id) === partyId);

	const cityChoices: Option[] = [
		{ value: '', label: 'Default (trip)' },
		...cities.map((c) => ({ value: c.id, label: c.name }))
	];
	const crewAssignChoices: Option[] = crews.map((p) => ({ value: p.id, label: p.name }));

	return (
		<Modal open title="Crews" subtitle={subtitle} size="md" onClose={onClose}>
			<div className="mbody crewbody">
				<p className="muted small crewintro">
					Split the group into crews. A crew can be in a different city and keep its own tracks; use
					"View as" to see one person's day.
				</p>

				<form
					className="crewnew"
					onSubmit={async (e) => {
						e.preventDefault();
						const name = newCrewName.trim();
						if (!name) return;
						await act(() => api(`${base}/crews`, { method: 'POST', body: { name } }));
						setNewCrewName('');
					}}
				>
					<input
						autoFocus
						aria-label="New crew name"
						placeholder="New crew, e.g. Museum group"
						value={newCrewName}
						onChange={(e) => setNewCrewName(e.target.value)}
					/>
					<button className="btn primary" type="submit" disabled={!newCrewName.trim()}>
						Add crew
					</button>
				</form>

				<div className="crewcard">
					<div className="crewhd">
						<span className="swatch" style={{ background: everyone?.color ?? '#2f6d5e' }} />
						<strong>Everyone</strong>
						<span className="muted small">base group</span>
					</div>
					<div className="crewmem">
						{membersOf(everyone?.id ?? null).length === 0 ? (
							<span className="muted small">Nobody here right now.</span>
						) : (
							membersOf(everyone?.id ?? null).map((m) => (
								<span key={m.id} className="memchip">
									{m.name}
								</span>
							))
						)}
					</div>
				</div>

				{crews.map((crew) => {
					const edit = crewEdit[crew.id] ?? { name: crew.name, color: crew.color };
					return (
						<div key={crew.id} className="crewcard">
							<div className="crewhd">
								<span className="swatch" style={{ background: crew.color }} />
								<form
									className="crewrename"
									onSubmit={(e) => {
										e.preventDefault();
										act(() =>
											api(`${base}/crews/${crew.id}`, {
												method: 'PATCH',
												body: { name: edit.name, color: edit.color }
											})
										);
									}}
								>
									<input
										type="text"
										value={edit.name}
										aria-label="Crew name"
										onChange={(e) =>
											setCrewEdit((v) => ({ ...v, [crew.id]: { ...edit, name: e.target.value } }))
										}
									/>
									<input
										type="color"
										value={edit.color}
										aria-label="Crew color"
										onChange={(e) =>
											setCrewEdit((v) => ({ ...v, [crew.id]: { ...edit, color: e.target.value } }))
										}
									/>
									<button className="btn small" type="submit">
										Save
									</button>
								</form>
								<button
									className="btn small danger"
									type="button"
									title="Delete crew"
									onClick={() =>
										act(() => api(`${base}/crews/${crew.id}`, { method: 'DELETE' }))
									}
								>
									Delete
								</button>
							</div>

							<form
								className="crewday"
								onSubmit={(e) => {
									e.preventDefault();
									act(() =>
										api(`${base}/crews/${crew.id}/day`, {
											method: 'PUT',
											body: { day, cityId: crewCity[crew.id] || null }
										})
									);
								}}
							>
								<span className="muted small">City today</span>
								<Select
									value={crewCity[crew.id] ?? ''}
									onChange={(v) => setCrewCity((c) => ({ ...c, [crew.id]: v }))}
									options={cityChoices}
									ariaLabel="Crew city"
									compact
								/>
								<button className="btn small" type="submit">
									Set
								</button>
							</form>

							<div className="crewmem">
								{membersOf(crew.id).length === 0 ? (
									<span className="muted small">No one assigned.</span>
								) : (
									membersOf(crew.id).map((m) => (
										<span key={m.id} className="memchip">
											{m.name}
											<button
												className="rejoin"
												type="button"
												title="Return to Everyone"
												aria-label={`Return ${m.name} to Everyone`}
												onClick={() =>
													act(() =>
														api(`${base}/crews/rejoin`, {
															method: 'POST',
															body: { day, fromMin: DAY_START, userIds: [m.id] }
														})
													)
												}
											>
												×
											</button>
										</span>
									))
								)}
							</div>
						</div>
					);
				})}

				{crews.length > 0 && (
					<form
						className="splitform"
						onSubmit={async (e) => {
							e.preventDefault();
							await act(() =>
								api(`${base}/crews/split`, {
									method: 'POST',
									body: {
										day,
										userIds: splitMembers,
										partyId: splitParty,
										fromMin: Number(splitFrom)
									}
								})
							);
							setSplitMembers([]);
						}}
					>
						<div className="splithd">
							<strong>Split people off</strong>
						</div>
						<div className="splitgrid">
							<label>
								<span className="muted small">People</span>
								<MultiSelect
									selected={splitMembers}
									onChange={setSplitMembers}
									options={members.map((m) => ({ value: m.id, label: m.name }))}
									placeholder="Choose people"
									ariaLabel="People to split off"
								/>
							</label>
							<label>
								<span className="muted small">Into crew</span>
								<Select
									value={splitParty}
									onChange={setSplitParty}
									options={crewAssignChoices}
									placeholder="Choose a crew"
									ariaLabel="Target crew"
								/>
							</label>
							<label>
								<span className="muted small">From</span>
								<Select
									value={splitFrom}
									onChange={setSplitFrom}
									options={START_OPTIONS}
									ariaLabel="Split start time"
								/>
							</label>
						</div>
						<button
							className="btn primary"
							type="submit"
							disabled={!splitMembers.length || !splitParty}
						>
							Split off
						</button>
					</form>
				)}
			</div>
			<div className="mfoot">
				<button className="btn" type="button" onClick={onClose}>
					Done
				</button>
			</div>
		</Modal>
	);
}
