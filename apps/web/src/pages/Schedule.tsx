import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useLiveSection } from '../hooks/useTripEvents';
import useMediaQuery from '../hooks/useMediaQuery';
import { useTrip } from './TripShell';
import FormError from '../components/ui/FormError';
import EmptyState from '../components/ui/EmptyState';
import Select from '../components/ui/Select';
import GoogleMap, { type MapTrack } from '../components/GoogleMap';
import TripMap from '../components/TripMap';

import { personBands, type Layout, type Placed } from '@trippy/core/layout';
import { isLegLaneId, layoutBoard, legLaneId } from '@trippy/core/travel';
import { copy } from '../copy';
import AddEventDialog from './schedule/AddEventDialog';
import EventDialog from './schedule/EventDialog';
import TravelDialog from './schedule/TravelDialog';
import {
	DAY_END,
	DAY_START,
	HOURS,
	PX_PER_MIN,
	dayLabel,
	heightPx,
	hhmm,
	modeLabel,
	pctLeft,
	pctWidth,
	topPx,
	typeLabel,
	whoBudget
} from './schedule/shared';
import type { BoardDay, EventRow, LegRow, Member, ScheduleData, ViewMode } from './schedule/types';
import '../styles/schedule.css';

const VIEW_OPTIONS: { v: ViewMode; label: string }[] = [
	{ v: 'day', label: 'Day' },
	{ v: '3day', label: '3-day' },
	{ v: 'people', label: 'People' }
];

/** The lane holds both kinds of block, and they are laid out together. */
type LaneItem = { kind: 'event'; ev: EventRow } | { kind: 'leg'; leg: LegRow };

/** Lane keys are shared with `layoutDay`, so a leg cannot collide with an event. */
const legKey = legLaneId;

/** One connector per pair of blocks, however many people or journeys it carries. */
function pairKey(from: string, to: string): string {
	return `${from}>${to}`;
}

/* --- Connector geometry ---------------------------------------------------
 *
 * A connector leaves the bottom edge of one block and arrives at the top edge
 * of another. Right angles rather than curves: a curve across a column layout
 * crosses the blocks it passes and reads as decoration, where a line that turns
 * once reads as a route. The corners are rounded so the turn is legible at a
 * 1.5px stroke.
 */

/** How far inside a block's edges a connector may leave it. */
const INSET = 10;
/** How far above an arrival its shared channel runs. */
const CHANNEL_GAP = 12;
/** How far a connector drops clear of its departure before turning. */
const MIN_DROP = 8;
/** Corner radius, shrunk to fit when the space is tighter than this. */
const CORNER = 8;

function connector(x1: number, y1: number, x2: number, y2: number, ch: number): string {
	const r = (n: number) => Math.round(n * 10) / 10;
	if (Math.abs(x1 - x2) < 1) return `M ${r(x1)} ${r(y1)} L ${r(x1)} ${r(y2)}`;
	const dir = x2 > x1 ? 1 : -1;
	const c = Math.max(
		0,
		Math.min(CORNER, Math.abs(x2 - x1) / 2, Math.max(0, ch - y1), Math.max(0, y2 - ch))
	);
	return [
		`M ${r(x1)} ${r(y1)}`,
		`L ${r(x1)} ${r(ch - c)}`,
		`Q ${r(x1)} ${r(ch)} ${r(x1 + dir * c)} ${r(ch)}`,
		`L ${r(x2 - dir * c)} ${r(ch)}`,
		`Q ${r(x2)} ${r(ch)} ${r(x2)} ${r(ch + c)}`,
		`L ${r(x2)} ${r(y2)}`
	].join(' ');
}

export default function Schedule() {
	const { trip } = useTrip();
	const base = `/trips/${trip.id}/schedule`;

	// Read-only: every day and view change is a <Link>, so the board stays
	// addressable and the back button walks back through the days.
	const [params] = useSearchParams();
	const dayParam = params.get('day');
	const viewParam = params.get('view');
	const query = new URLSearchParams();
	if (dayParam) query.set('day', dayParam);
	if (viewParam) query.set('view', viewParam);
	const qs = query.toString();

	const { data, error, reload } = useApi<ScheduleData>(qs ? `${base}?${qs}` : base);
	// The payload carries the events, the crews that fill their people picker,
	// the stays behind the lodging band and the roster it is filtered by.
	useLiveSection(['schedule', 'lodging', 'members', 'trip'], reload);

	/**
	 * Who the board is being read for: a member id, or '' for everyone.
	 *
	 * One person or the whole trip, the same choice the money pages offer, and
	 * for the same reason: the question is "what is my day", not "what is the day
	 * of this arbitrary subset". Everyone is the default and stays the default as
	 * people join, since holding the roster in state would pin the filter to
	 * whoever was a member when the page loaded.
	 */
	const [viewAs, setViewAs] = useState('');
	/** Which day an add is for, and where on its clock it started, when it started at a time. */
	const [adding, setAdding] = useState<{ day: string; start: number | null } | null>(null);
	const [openEventId, setOpenEventId] = useState('');
	const [openLegId, setOpenLegId] = useState('');
	const [notice, setNotice] = useState('');

	/* How many hours apart the People view labels its time axis.
	 *
	 * Every second hour is ten labels, which needs about 340px of track. On a
	 * phone the track is nearer 230 and they ran into each other, printing
	 * "6:008:0010:00". Thinned to every sixth hour they read as a scale again.
	 * Measured rather than styled: which labels are drawn is the component's
	 * call, and hiding half of them in CSS would leave the gaps uneven. */
	const tightAxis = useMediaQuery('(max-width: 700px)');
	const axisStep = tightAxis ? 6 : 2;

	// Live drag and resize of a single block.
	const [drag, setDrag] = useState<{
		id: string;
		day: string;
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
	/* Where a block was let go, held until the reloaded day agrees.
	 *
	 * Clearing the drag on pointer-up is not enough on its own: the write is a
	 * round trip, so for the length of it the block would render at the position
	 * it started from and then jump forward when the new day arrived. Without a
	 * transition that read as a flicker; with one it reads as a rubber band,
	 * which is worse. The override bridges exactly that gap and is dropped the
	 * moment a fresh payload lands, whatever that payload says, so a value the
	 * server clamps or refuses still wins. */
	const [pending, setPending] = useState<{ id: string; start?: number; end?: number } | null>(null);
	useEffect(() => {
		setPending(null);
	}, [data]);
	/* Set while a pointer drag actually moves, so the click that follows a drag
	   does not also open the event. A ref, not state: it is read during the same
	   event sequence that writes it and must never lag a render behind. */
	const didDrag = useRef(false);

	// Measured width of the day view's event area, for fitting text into blocks.
	const [laneW, setLaneW] = useState(0);
	const laneRef = useCallback((node: HTMLDivElement | null) => {
		if (!node) return;
		setLaneW(node.clientWidth);
		const ro = new ResizeObserver(() => setLaneW(node.clientWidth));
		ro.observe(node);
		return () => ro.disconnect();
	}, []);

	async function act(fn: () => Promise<unknown>) {
		setNotice('');
		try {
			await fn();
			reload();
		} catch (err) {
			setPending(null);
			setNotice(err instanceof ApiError ? err.message : copy.api.saveFallback);
		}
	}

	const eventOp = useCallback(
		(eventId: string, body: Record<string, unknown>) =>
			api(`${base}/events/${eventId}/op`, { method: 'POST', body }),
		[base]
	);

	const members: Member[] = useMemo(() => data?.members ?? [], [data]);
	const memberIds = useMemo(() => members.map((m) => m.id), [members]);
	const memberName = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
	const memberOptions = useMemo(
		() => members.map((m) => ({ value: m.id, label: m.name })),
		[members]
	);
	/* The "view as" choices: the whole trip, or one person. Names carry the same
	   "(you)" suffix the money pages use, so the reader finds themselves in the
	   list by the same mark everywhere. */
	const viewAsOptions = useMemo(
		() => [
			{ value: '', label: copy.viewAs.everyone },
			...members.map((m) => ({
				value: m.id,
				label: m.name + (m.id === data?.me ? copy.preparation.youSuffix : '')
			}))
		],
		[members, data?.me]
	);
	/** First name only: chips and journey labels get cramped fast. */
	const shortName = useCallback(
		(id: string) => (memberName.get(id) ?? '?').split(' ')[0],
		[memberName]
	);

	const selected = useMemo(() => {
		const roster = new Set(memberIds);
		return new Set(viewAs && roster.has(viewAs) ? [viewAs] : memberIds);
	}, [viewAs, memberIds]);

	/**
	 * The board with "view as" applied.
	 *
	 * An event with nobody on it belongs to the whole group and is always shown;
	 * otherwise the chosen person has to be on it. Travel legs are not: a leg
	 * belongs to the people making that journey, and a leg they are not on is not
	 * part of their day.
	 */
	const board: BoardDay[] = useMemo(() => {
		const showEvent = (e: EventRow) =>
			e.people.length === 0 || e.people.some((p) => selected.has(p));
		const showLeg = (l: LegRow) => l.people.some((p) => selected.has(p));
		return (data?.board ?? []).map((entry) => ({
			...entry,
			events: entry.events.filter(showEvent),
			legs: entry.legs.filter(showLeg)
		}));
	}, [data, selected]);

	const anchor = useMemo(
		() => (data ? (board.find((b) => b.day === data.day) ?? board[0] ?? null) : null),
		[board, data]
	);
	const anchorCity = anchor?.city ?? null;

	/** Which city a day is spent in, for ordering the place picker. */
	const cityOfDay = useCallback(
		(day: string) => board.find((b) => b.day === day)?.city?.id ?? null,
		[board]
	);

	/** Every event on the board, for looking one up by id from a dialog. */
	const eventById = useMemo(() => {
		const out = new Map<string, EventRow>();
		for (const entry of board) for (const e of entry.events) out.set(e.id, e);
		return out;
	}, [board]);

	const legById = useMemo(() => {
		const out = new Map<string, LegRow>();
		for (const entry of board) for (const l of entry.legs) out.set(l.id, l);
		return out;
	}, [board]);

	const openEvent = openEventId ? (eventById.get(openEventId) ?? null) : null;
	const openLeg = openLegId ? (legById.get(openLegId) ?? null) : null;

	const peopleLabel = useCallback(
		(ids: string[]) => {
			if (ids.length === 0) return 'Everyone';
			if (ids.length === members.length) return 'Everyone';
			return ids.map((id) => shortName(id)).join(', ');
		},
		[members.length, shortName]
	);

	// --- Drag and resize ----------------------------------------------------

	function startFor(ev: EventRow): number {
		if (drag && drag.id === ev.id) return drag.liveStart;
		if (pending && pending.id === ev.id && pending.start !== undefined) return pending.start;
		return ev.start_min;
	}
	function endFor(ev: EventRow): number {
		if (resize && resize.id === ev.id) return resize.liveEnd;
		if (pending && pending.id === ev.id && pending.end !== undefined) return pending.end;
		return startFor(ev) + (ev.end_min - ev.start_min);
	}

	function onPointerDown(e: React.PointerEvent, ev: EventRow, day: string) {
		// Let the resize grip through.
		if ((e.target as HTMLElement).closest('.bresize')) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		didDrag.current = false;
		setDrag({
			id: ev.id,
			day,
			pointerStartY: e.clientY,
			origStart: ev.start_min,
			liveStart: ev.start_min
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
					{
						...d,
						liveStart: Math.round((d.origStart + (y - d.pointerStartY) / PX_PER_MIN) / 5) * 5
					}
				: d
		);
	}

	async function onPointerUp() {
		if (!drag) return;
		const snapped = Math.round(drag.liveStart / 5) * 5;
		const { id, origStart, day } = drag;
		setDrag(null);
		if (snapped !== origStart) {
			setPending({ id, start: snapped });
			// The day rides along because a move carries one, and sending the block's
			// own day keeps a drag in the 3-day view on the column it was drawn in.
			await act(() => eventOp(id, { op: 'move', startMin: snapped, day }));
		}
	}

	function onResizeDown(e: React.PointerEvent, ev: EventRow) {
		e.stopPropagation();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		didDrag.current = false;
		setResize({
			id: ev.id,
			pointerStartY: e.clientY,
			startMin: ev.start_min,
			origEnd: ev.end_min,
			liveEnd: ev.end_min
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
			setPending({ id, end: snapped });
			await act(() => eventOp(id, { op: 'resize', endMin: snapped }));
		}
	}

	if (!data) return error ? <FormError message={error} variant="banner" /> : null;

	const view = data.view;
	const wide = view !== 'day';
	const navUrl = (day: string, v: string) => `?day=${day}&view=${v}`;

	/* The day one step either way, or null at the ends.
	 *
	 * Steps through `data.days`, the days the trip actually offers, rather than
	 * by the calendar: that is what bounds the walk, and it also skips the gap to
	 * an event stranded outside the range instead of landing on a day the trip
	 * has not got. The 3-day view is a window, so its anchor stops where the far
	 * edge reaches the last day. The server clamps the same way, since the day is
	 * a url and a url can arrive without passing through these buttons. */
	const dayStep = (delta: number): string | null => {
		const days = data.days;
		const span = view === '3day' ? 3 : 1;
		const lastAnchor = Math.max(0, days.length - span);
		const at = days.indexOf(data.day);
		if (at < 0) return null;
		const to = at + delta;
		return to >= 0 && to <= lastAnchor ? (days[to] ?? null) : null;
	};

	// --- Board pieces -------------------------------------------------------

	function lodgingBand(entry: BoardDay) {
		if (!entry.lodging) return null;
		const l = entry.lodging;
		return (
			<div className={l.locked ? 'lodgeband locked' : 'lodgeband'}>
				<span className="lodgename">{l.name}</span>
				{l.tag && <span className="lodgetag">{l.tag}</span>}
				{l.url && (
					<a className="lodgelink" href={l.url} target="_blank" rel="noopener">
						Details
					</a>
				)}
			</div>
		);
	}

	function blockNode(ev: EventRow, day: string, lanePx: number, place: Layout) {
		const p = place.placed.get(ev.id);
		if (!p) return null;

		const from = startFor(ev);
		const to = endFor(ev);
		const box = { left: `${p.left * 100}%`, width: `calc(${p.width * 100}% - 6px)` };
		const bud = whoBudget(p.width, to - from, ev.title, lanePx);
		const cls = [
			'block',
			ev.type,
			drag?.id === ev.id ? 'dragging' : '',
			resize?.id === ev.id ? 'resizing' : '',
			openEventId === ev.id ? 'editingnow' : '',
			p.width < 0.34 ? 'narrow' : ''
		]
			.filter(Boolean)
			.join(' ');

		return (
			<div
				key={ev.id}
				className={cls}
				role="button"
				tabIndex={0}
				aria-label={`${ev.title}, ${hhmm(ev.start_min)} to ${hhmm(ev.end_min)}. Open, or drag to reschedule.`}
				style={{
					...box,
					top: `${topPx(from)}px`,
					height: `${heightPx(from, to)}px`,
					['--trows' as string]: bud.trows,
					['--wrows' as string]: bud.wrows
				}}
				onPointerDown={(e) => onPointerDown(e, ev, day)}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onClick={(e) => {
					if ((e.target as HTMLElement).closest('.bresize')) return;
					if (didDrag.current) return;
					setOpenEventId(ev.id);
				}}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						setOpenEventId(ev.id);
					}
				}}
			>
				<div className="bt">{ev.title}</div>
				<div className="bmeta">
					{bud.showTime && <span>{bud.compact ? hhmm(from) : `${hhmm(from)}-${hhmm(to)}`}</span>}
				</div>
				<div className="bwho">
					{ev.people.length === 0 || ev.people.length === members.length ? (
						<span className="who all">Everyone</span>
					) : ev.people.length <= bud.fit ? (
						ev.people.map((id) => (
							<span key={id} className="who">
								{shortName(id)}
							</span>
						))
					) : bud.fit > 0 ? (
						<>
							{ev.people.slice(0, bud.fit - 1).map((id) => (
								<span key={id} className="who">
									{shortName(id)}
								</span>
							))}
							<span className="who more" title={ev.people.map((id) => shortName(id)).join(', ')}>
								+{ev.people.length - (bud.fit - 1)}
							</span>
						</>
					) : null}
				</div>
				<div
					className="bresize"
					role="separator"
					aria-label="Drag to change the end time"
					onPointerDown={(e) => onResizeDown(e, ev)}
					onPointerMove={onResizeMove}
					onPointerUp={onResizeUp}
				/>
			</div>
		);
	}

	/** What a journey is called: the name somebody gave it, or where it lands. */
	function legName(leg: LegRow): string {
		if (leg.title) return leg.title;
		const to = eventById.get(leg.toEventId)?.title;
		return to ? `${modeLabel(leg.resolvedMode)} to ${to}` : modeLabel(leg.resolvedMode);
	}

	/**
	 * A journey, drawn as the block it is.
	 *
	 * An automatic leg and a travel event somebody typed describe the same act,
	 * so they are the same block: same colour, same column, same name on the
	 * front. A leg keeps one difference, and it is a fact about the leg rather
	 * than about where it came from: it cannot be dragged, because its position
	 * is the gap between the two events it joins, and moving it would mean
	 * moving one of them.
	 */
	function legNode(leg: LegRow, lanePx: number, place: Layout, soleArrival: boolean) {
		const p = place.placed.get(legKey(leg));
		if (!p) return null;

		/* A journey nothing else overlaps is given the whole board, which reads
		   as the whole group moving. Where it is the only journey into its
		   arrival, it is drawn in that block's column instead: a rule the width
		   of the thing it leads into, over the people actually on it. */
		const to = place.placed.get(leg.toEventId);
		const box = soleArrival && to && to.width < p.width ? to : p;
		const name = legName(leg);
		const mins = leg.endMin - leg.startMin;
		// A short hop cannot carry two lines of type, so it is drawn as a rule
		// across the gap with its duration on it, floored to a height a pointer
		// can hit. The floor grows upwards, into the waiting time before the
		// journey, because downwards is the block it arrives at.
		const trueH = heightPx(leg.startMin, leg.endMin);
		const h = Math.max(trueH, 15);
		const thin = trueH < 24;
		const bud = whoBudget(box.width, mins, name, lanePx);
		const cls = [
			'block',
			'travel',
			'leg',
			thin ? 'thin' : '',
			leg.tight ? 'tight' : '',
			openLegId === leg.id ? 'editingnow' : '',
			box.width < 0.34 ? 'narrow' : ''
		]
			.filter(Boolean)
			.join(' ');

		return (
			<div
				key={legKey(leg)}
				className={cls}
				role="button"
				tabIndex={0}
				aria-label={`${name}, ${hhmm(leg.startMin)} to ${hhmm(leg.endMin)}. Open.`}
				title={legTitle(leg)}
				style={{
					left: `${box.left * 100}%`,
					width: `calc(${box.width * 100}% - 6px)`,
					top: `${topPx(leg.endMin) - h}px`,
					height: `${h}px`,
					['--trows' as string]: bud.trows,
					['--wrows' as string]: bud.wrows
				}}
				onClick={() => setOpenLegId(leg.id)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						setOpenLegId(leg.id);
					}
				}}
			>
				<div className="bt">{thin ? `${name}, ${leg.resolvedMins}m` : name}</div>
				{!thin && (
					<div className="bmeta">
						{bud.showTime && <span>{`${hhmm(leg.startMin)}-${hhmm(leg.endMin)}`}</span>}
						<span>{leg.resolvedMins}m</span>
					</div>
				)}
			</div>
		);
	}

	/**
	 * People moving from one block to the next, as connectors between them.
	 *
	 * The board draws journeys as blocks wherever it can, so a connector is the
	 * exception: a move the blocks alone do not account for.
	 *
	 * A hop that touches a journey block is never drawn. The block is already
	 * the answer to "how did they get there", and a line into and out of it
	 * would triple the ink for nothing.
	 *
	 * Of what is left, a hop is drawn only when the block it arrives at is not
	 * already under the block it leaves. The same containment rule the layout
	 * uses to choose blocks over arrows: if the next thing sits beneath the last
	 * one, the eye reads that for free and a line would only repeat it.
	 *
	 * The line itself leaves the departure at the point nearest its arrival
	 * rather than from the middle, so a hop that does not have to cross is a
	 * plain vertical, and a hop that does has exactly one corner. Everything
	 * arriving at a block shares one horizontal channel just above it and one
	 * stub down into it, which is what turns four people rejoining from four
	 * directions into a junction instead of four crossing curves.
	 *
	 * A journey that could not be a block has nothing to click, so its connector
	 * carries the count and opens it.
	 */
	function flowArrows(
		place: Layout,
		spans: Map<string, { start: number; end: number }>,
		stranded: Map<string, LegRow[]>,
		lanePx: number
	) {
		if (lanePx <= 0) return [];
		// The blocks are a hair narrower than their column, so their middle is
		// not the column's middle and a line drawn to one would sit off-centre.
		const centre = (p: Placed) => p.left * lanePx + (p.width * lanePx - 6) / 2;
		const edges = (p: Placed) => ({
			l: p.left * lanePx + INSET,
			r: (p.left + p.width) * lanePx - 6 - INSET
		});

		const raw = place.flows.flatMap((f) => {
			if (isLegLaneId(f.from) || isLegLaneId(f.to)) return [];
			const a = place.placed.get(f.from);
			const b = place.placed.get(f.to);
			const sa = spans.get(f.from);
			const sb = spans.get(f.to);
			if (!a || !b || !sa || !sb) return [];
			const legs = stranded.get(pairKey(f.from, f.to)) ?? [];
			const from = edges(a);
			const x2 = centre(b);
			// Leaving from the point nearest the arrival, so only a hop that
			// genuinely crosses gets a corner.
			const x1 = Math.min(Math.max(x2, from.l), from.r);
			if (Math.abs(x1 - x2) < 1 && legs.length === 0) return [];
			const y1 = topPx(sa.end);
			// Two blocks that overlap leave no gap to fall through, so the line
			// runs flat across from the end of the first instead of backwards.
			const top = topPx(sb.start);
			const y2 = Math.max(top, y1);
			return [
				{ key: pairKey(f.from, f.to), to: f.to, people: f.people, legs, x1, y1, x2, y2, top }
			];
		});

		// One channel per arrival, just above it and clear of everything leaving
		// for it, so four people rejoining meet before they land rather than
		// each drawing their own approach.
		const floors = new Map<string, number>();
		for (const h of raw) floors.set(h.to, Math.max(floors.get(h.to) ?? 0, h.y1 + MIN_DROP));

		const headed = new Set<string>();

		return raw.map((h) => {
			const ch = Math.min(Math.max(h.top - CHANNEL_GAP, floors.get(h.to) ?? 0), h.y2);
			const head = !headed.has(h.to);
			headed.add(h.to);
			const straightDown = Math.abs(h.x1 - h.x2) < 1;
			return {
				...h,
				head,
				d: connector(h.x1, h.y1, h.x2, h.y2, ch),
				tagX: straightDown ? h.x1 : (h.x1 + h.x2) / 2,
				tagY: straightDown ? (h.y1 + h.y2) / 2 : ch
			};
		});
	}

	function legTitle(leg: LegRow): string {
		const from = eventById.get(leg.fromEventId)?.title ?? '?';
		const to = eventById.get(leg.toEventId)?.title ?? '?';
		const tail = leg.tight ? ', does not fit the gap' : leg.manual ? ', pinned' : '';
		return `${from} to ${to}: ${modeLabel(leg.resolvedMode)}, ${leg.resolvedMins}m${tail}\n${peopleLabel(leg.people)}`;
	}

	function dayBoard(entry: BoardDay, opts: { lanePx: number; measure?: boolean }) {
		if (entry.events.length === 0 && entry.legs.length === 0) {
			return <EmptyState graphic message={copy.common.nothingAdded} />;
		}

		/* Journeys share the event columns rather than sitting in a lane of their
		   own. Travel is part of the day, not a footnote to it: an hour on a
		   ferry is an hour you cannot be anywhere else, and drawing it beside the
		   day made the gap it fills look free. A journey that would have to cross
		   the board to join its two events cannot be a block in either of their
		   columns, so that one is an arrow. */
		const {
			layout: place,
			blocks: legBlocks,
			stranded: stray
		} = layoutBoard(
			entry.events.map((ev) => ({
				id: ev.id,
				// The stored times, not the dragged ones: re-laying out the columns
				// under the pointer would move every other block on the day while one
				// is being nudged.
				start: ev.start_min,
				end: ev.end_min,
				// An event with nobody on it is the whole group, and saying so here is
				// what keeps it from being ranked as a lane of its own.
				people: ev.people.length ? ev.people : memberIds
			})),
			entry.legs
		);

		const items: LaneItem[] = [
			// Journeys first, so where a short hop's floored height has to reach
			// back past the block it left, the block stays on top of it.
			...legBlocks.map((leg) => ({ kind: 'leg', leg }) as const),
			...entry.events.map((ev) => ({ kind: 'event', ev }) as const)
		];

		// Arrows run between events only, so only events need a span.
		const spans = new Map(
			entry.events.map((ev) => [ev.id, { start: ev.start_min, end: ev.end_min }])
		);

		const arrivals = new Map<string, number>();
		for (const l of legBlocks) arrivals.set(l.toEventId, (arrivals.get(l.toEventId) ?? 0) + 1);

		const stranded = new Map<string, LegRow[]>();
		for (const leg of stray) {
			const k = pairKey(leg.fromEventId, leg.toEventId);
			const list = stranded.get(k);
			if (list) list.push(leg);
			else stranded.set(k, [leg]);
		}

		const hops = flowArrows(place, spans, stranded, opts.lanePx);

		return (
			<div className="grid" style={{ height: `${(DAY_END - DAY_START) * PX_PER_MIN + 16}px` }}>
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

				<div
					className="lane"
					ref={opts.measure ? laneRef : undefined}
					onDoubleClick={(e) => {
						// A double click on empty track is "put something here". On a
						// block or a journey tag it is not: those have their own dialogs,
						// and opening a second one over the top would be a trap.
						if ((e.target as HTMLElement).closest('.block, .flowtag')) return;
						const rect = e.currentTarget.getBoundingClientRect();
						const mins = DAY_START + (e.clientY - rect.top) / PX_PER_MIN;
						const snapped = Math.round(mins / 15) * 15;
						setAdding({
							day: entry.day,
							start: Math.min(Math.max(snapped, DAY_START), DAY_END - 15)
						});
					}}
				>
					{/* Under the blocks, so a connector reaches a block's edge and
					    stops there rather than crossing its face. */}
					{hops.length > 0 && (
						<svg
							className="flows"
							width={opts.lanePx}
							height={(DAY_END - DAY_START) * PX_PER_MIN}
							aria-hidden="true"
						>
							{hops.map((h) => (
								<g key={h.key}>
									<path d={h.d} />
									{h.head && (
										<path
											className="head"
											d={`M ${h.x2 - 4} ${h.y2 - 5} L ${h.x2} ${h.y2} L ${h.x2 + 4} ${h.y2 - 5}`}
										/>
									)}
								</g>
							))}
						</svg>
					)}
					{items.map((it) =>
						it.kind === 'event'
							? blockNode(it.ev, entry.day, opts.lanePx, place)
							: legNode(it.leg, opts.lanePx, place, arrivals.get(it.leg.toEventId) === 1)
					)}
					{hops
						.filter((h) => h.legs.length > 0)
						.map((h) => (
							<button
								key={h.key}
								type="button"
								className="flowtag"
								style={{ left: `${h.tagX}px`, top: `${h.tagY}px` }}
								title={
									h.legs.length === 1
										? legTitle(h.legs[0])
										: `${h.legs.length} journeys, ${peopleLabel(h.people)}`
								}
								onClick={() => setOpenLegId(h.legs[0].id)}
							>
								{h.legs.length}
							</button>
						))}
				</div>
			</div>
		);
	}

	function peopleBoard(entry: BoardDay) {
		if (entry.events.length === 0) return <EmptyState graphic message={copy.common.nothingAdded} />;

		const rows = members.filter((m) => selected.has(m.id));
		const bands = personBands(
			entry.events.map((ev) => ({
				id: ev.id,
				start: ev.start_min,
				end: ev.end_min,
				people: ev.people.length ? ev.people : memberIds
			})),
			rows.map((m) => m.id),
			DAY_START,
			DAY_END
		);
		const byId = new Map(entry.events.map((ev) => [ev.id, ev]));

		return (
			<div className="swim">
				<div className="swimhead">
					<span className="swimname" />
					<div className="swimaxis">
						{HOURS.filter((h) => h % axisStep === 0).map((h) => (
							<span key={h} className="swimhour" style={{ left: `${pctLeft(h * 60)}%` }}>
								{h}:00
							</span>
						))}
					</div>
				</div>

				<div className="swimbody">
					{rows.map((person) => (
						<div key={person.id} className="swimrow">
							<span className="swimname" title={memberName.get(person.id)}>
								{shortName(person.id)}
							</span>
							<div className="swimtrack">
								{HOURS.map((h) => (
									<span key={h} className="swimgrid" style={{ left: `${pctLeft(h * 60)}%` }} />
								))}
								{(bands.get(person.id) ?? []).map((band) => {
									const ev = band.eventId ? byId.get(band.eventId) : null;
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
												title={`Free ${hhmm(band.start)} to ${hhmm(band.end)}`}
											/>
										);
									}
									return (
										<button
											key={ev.id}
											type="button"
											className={`swimband ${ev.type}`}
											style={pos}
											title={`${ev.title}, ${hhmm(band.start)} to ${hhmm(band.end)}\n${peopleLabel(ev.people)}`}
											onClick={() => setOpenEventId(ev.id)}
										>
											<span className="swimlabel">{ev.title}</span>
										</button>
									);
								})}
							</div>
						</div>
					))}
				</div>
			</div>
		);
	}

	// --- Agenda -------------------------------------------------------------

	/**
	 * One person's day, end to end, under the map.
	 *
	 * Only when a single person is being read. For the whole group the same list
	 * would be every track at once, which the board already draws better; it is
	 * one person's thread through a day that the columns make hard to follow.
	 * The board is already filtered to them, so this is just what is left, in
	 * order, journeys included.
	 */
	const agenda =
		viewAs && memberName.has(viewAs)
			? [
					...(anchor?.events ?? []).map((ev) => ({
						key: ev.id,
						start: ev.start_min,
						title: ev.title,
						meta: `${typeLabel(ev.type)} · ${hhmm(ev.start_min)}-${hhmm(ev.end_min)}`,
						tight: false,
						open: () => setOpenEventId(ev.id)
					})),
					...(anchor?.legs ?? []).map((leg) => ({
						key: legKey(leg),
						start: leg.startMin,
						title: legName(leg),
						meta: `${modeLabel(leg.resolvedMode)} · ${leg.resolvedMins}m`,
						tight: leg.tight,
						open: () => setOpenLegId(leg.id)
					}))
				].sort((a, b) => a.start - b.start)
			: null;

	// --- Map ----------------------------------------------------------------

	/* Every place the trip saved in Discover is on the map, so the day is read
	   against everything that was considered rather than against a blank field:
	   grey for the places this day does not visit, green for the ones it does. */
	const dayPins = (anchor?.events ?? []).filter((e) => e.lat != null && e.lng != null);
	const scheduledPoiIds = new Set(
		(anchor?.events ?? []).map((e) => e.poi_id).filter((id): id is string => id !== null)
	);
	const restPins = data.saved.filter(
		(p) => p.lat != null && p.lng != null && !scheduledPoiIds.has(p.id)
	);

	/**
	 * Whether the day's places are a sequence, and so whether the pins may be
	 * numbered.
	 *
	 * Two conditions, both about honesty rather than tidiness. Nothing may
	 * overlap, because two things at once have no first. And everybody on the
	 * day must be doing the same things, because a day that splits has one order
	 * per track and no order overall. People with nothing scheduled do not
	 * break it: they are simply absent from every event's list. Reading the day
	 * as one person drops the second condition, because their own thread through
	 * a day is a sequence however the rest of the group divides.
	 */
	const ordered = ((): boolean => {
		const evs = [...dayPins].sort((a, b) => a.start_min - b.start_min);
		if (evs.length < 2) return true;
		for (let i = 1; i < evs.length; i++) {
			if (evs[i].start_min < evs[i - 1].end_min) return false;
		}
		if (viewAs) return true;
		const who = (e: EventRow) => (e.people.length ? [...e.people].sort().join(',') : '*');
		return evs.every((e) => who(e) === who(evs[0]));
	})();

	const mapTracks: MapTrack[] = [];
	if (restPins.length) {
		const cityName = new Map(data.cities.filter((c) => c !== null).map((c) => [c.id, c.name]));
		mapTracks.push({
			name: 'Saved places',
			color: '#9aa39c',
			items: restPins.map((p) => ({
				title: p.name,
				lat: p.lat,
				lng: p.lng,
				// Which city it is in, which the colour and the track name do not say.
				detail: [cityName.get(p.city_id)].filter((n): n is string => Boolean(n))
			})),
			line: false,
			numbered: false
		});
	}
	if (dayPins.length) {
		mapTracks.push({
			name: dayLabel(data.day),
			color: '#2f6d5e',
			items: [...dayPins]
				.sort((a, b) => a.start_min - b.start_min)
				.map((e) => ({
					title: e.title,
					lat: e.lat,
					lng: e.lng,
					detail: [
						`${typeLabel(e.type)} · ${hhmm(e.start_min)}-${hhmm(e.end_min)}`,
						peopleLabel(e.people)
					]
				})),
			numbered: ordered
		});
	}

	return (
		<div className="sched">
			<div className="toolbar">
				<div className="navgroup">
					<div className="daynav">
						{dayStep(-1) ? (
							<Link
								className="navbtn"
								to={navUrl(dayStep(-1) as string, view)}
								aria-label="Previous day"
							>
								‹
							</Link>
						) : (
							<button className="navbtn" type="button" disabled aria-label="Previous day">
								‹
							</button>
						)}
						<span className="curday">{dayLabel(data.day)}</span>
						{dayStep(1) ? (
							<Link
								className="navbtn"
								to={navUrl(dayStep(1) as string, view)}
								aria-label="Next day"
							>
								›
							</Link>
						) : (
							<button className="navbtn" type="button" disabled aria-label="Next day">
								›
							</button>
						)}
					</div>
					<div className="pills" role="group" aria-label="Schedule view">
						{VIEW_OPTIONS.map((o) => (
							<Link
								key={o.v}
								className={o.v === view ? 'pill on' : 'pill'}
								aria-current={o.v === view ? 'true' : undefined}
								to={navUrl(data.day, o.v)}
							>
								{o.label}
							</Link>
						))}
					</div>
				</div>

				<div className="tools">
					{/* On a solo trip the only person to read the board as is you, and the
					    control would be a dropdown with one name that changes nothing. */}
					{members.length > 1 && (
						<div className="viewas">
							<span className="muted">{copy.viewAs.label}</span>
							<Select
								compact
								value={viewAs}
								onChange={setViewAs}
								options={viewAsOptions}
								ariaLabel="View the schedule as"
							/>
						</div>
					)}
					<button
						className="btn primary"
						type="button"
						onClick={() => setAdding({ day: data.day, start: null })}
					>
						+ Add
					</button>
				</div>
			</div>

			{notice && (
				<p role="alert" className="mb-4 text-body text-danger-ink">
					{notice}
				</p>
			)}

			<div className={wide ? 'split wide' : 'split'}>
				<div className="boardcol">
					{view === 'people' ? (
						<div className="board card">
							{anchor && lodgingBand(anchor)}
							{anchor ? peopleBoard(anchor) : null}
						</div>
					) : view === 'day' ? (
						<div className="board card">
							{anchor && lodgingBand(anchor)}
							{anchor ? dayBoard(anchor, { lanePx: laneW || 560, measure: true }) : null}
						</div>
					) : (
						<div className="multiboard">
							{board.map((entry) => (
								<div key={entry.day} className="board card dayblock">
									<div className="dayblockhead">
										<Link className="dayblocklink" to={navUrl(entry.day, 'day')}>
											{dayLabel(entry.day)}
										</Link>
										{entry.city && <span className="muted">{entry.city.name}</span>}
									</div>
									{lodgingBand(entry)}
									{dayBoard(entry, { lanePx: 220 })}
								</div>
							))}
						</div>
					)}
				</div>

				{!wide && (
					<aside className="mapwrap card">
						{data.mapsKey ? (
							<GoogleMap tracks={mapTracks} apiKey={data.mapsKey} center={anchorCity} />
						) : (
							<TripMap tracks={mapTracks} />
						)}
						{agenda && (
							<div className="agenda">
								<h4>{memberName.get(viewAs)}</h4>
								{agenda.length ? (
									<ul>
										{agenda.map((row) => (
											<li key={row.key}>
												<button
													type="button"
													className={row.tight ? 'agendarow tight' : 'agendarow'}
													onClick={row.open}
												>
													<span className="agendawhen">{hhmm(row.start)}</span>
													<span className="agendawhat">{row.title}</span>
													<span className="agendameta">{row.meta}</span>
												</button>
											</li>
										))}
									</ul>
								) : (
									<EmptyState graphic message={copy.common.nothingAdded} />
								)}
							</div>
						)}
					</aside>
				)}
			</div>

			{adding && (
				<AddEventDialog
					base={base}
					day={adding.day}
					defaults={data.defaults}
					startMin={adding.start}
					memberOptions={memberOptions}
					crews={data.crews}
					saved={data.saved}
					cities={data.cities}
					cityId={cityOfDay(adding.day)}
					onClose={() => setAdding(null)}
					onDone={() => {
						setAdding(null);
						reload();
					}}
				/>
			)}

			{openEvent && (
				<EventDialog
					key={openEvent.id}
					base={base}
					event={openEvent}
					memberOptions={memberOptions}
					crews={data.crews}
					saved={data.saved}
					cities={data.cities}
					cityId={openEvent.city_id ?? cityOfDay(openEvent.day)}
					onClose={() => setOpenEventId('')}
					onDone={() => {
						setOpenEventId('');
						reload();
					}}
				/>
			)}

			{openLeg && (
				<TravelDialog
					key={openLeg.id}
					base={base}
					leg={openLeg}
					fromTitle={eventById.get(openLeg.fromEventId)?.title ?? '?'}
					toTitle={eventById.get(openLeg.toEventId)?.title ?? '?'}
					whoLabel={peopleLabel(openLeg.people)}
					onClose={() => setOpenLegId('')}
					onDone={() => {
						setOpenLegId('');
						reload();
					}}
				/>
			)}
		</div>
	);
}
