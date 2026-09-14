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

import { personBands, type Layout } from '@trippy/core/layout';
import { layoutBoard, legLaneId } from '@trippy/core/travel';
import { copy } from '../copy';
import AddEventDialog from './schedule/AddEventDialog';
import EventDialog from './schedule/EventDialog';
import { applyDraft, replanLegs } from './schedule/replan';
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
import type {
	BoardDay,
	EventDraft,
	EventRow,
	LegRow,
	Member,
	ScheduleData,
	ViewMode
} from './schedule/types';
import '../styles/schedule.css';

const VIEW_OPTIONS: { v: ViewMode; label: string }[] = [
	{ v: 'day', label: 'Day' },
	{ v: '3day', label: '3-day' },
	{ v: 'people', label: 'People' }
];

/** The lane holds both kinds of block, and they are laid out together. */
type LaneItem =
	{ kind: 'event'; ev: EventRow } | { kind: 'leg'; leg: LegRow; left: number; width: number };

/** Lane keys are namespaced, so a leg cannot collide with an event. */
const legKey = legLaneId;

/**
 * The shortest journey that can be drawn with a name on one line and its times
 * on another: two lines of type plus the block's own padding. Anything shorter
 * is drawn as a single rule, because two lines in less than this clip.
 */
const TWO_LINE_H = 44;

/**
 * The width below which a bar has to give up its padding to keep its duration.
 * Seven columns of a 3-day day leave about thirty pixels each, which is less
 * than the ordinary padding wants, and the duration is the last thing that
 * should go.
 */
const TINY_W = 64;

/**
 * The same journey, moved by `by` minutes.
 *
 * Used wherever the board is showing an event somewhere the server has not
 * agreed to yet: under the pointer during a drag, and while an edit dialog is
 * open. A journey is anchored to the thing it arrives at, so a block that moves
 * has to take its journeys with it or they are left pointing at empty track.
 * The duration is untouched: moving an event later does not make the walk to it
 * any shorter.
 */
function shiftLeg(leg: LegRow, by: number): LegRow {
	return by ? { ...leg, startMin: leg.startMin + by, endMin: leg.endMin + by } : leg;
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
	/** The open edit dialog's unsaved draft, drawn on the board as it is typed. */
	const [preview, setPreview] = useState<EventDraft | null>(null);

	/* Whether there is room beside the board for the edit dialog to peek.
	 *
	 * Below this the panel covers what it is previewing whichever edge it stands
	 * at, so it dims the page and holds it still like any other dialog. The
	 * preview is still computed: it costs nothing and the board is correct the
	 * moment the dialog is dismissed. */
	const roomToDock = useMediaQuery('(min-width: 1100px)');

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
	 * The board with "view as" and the edit in progress applied.
	 *
	 * An event with nobody on it belongs to the whole group and is always shown;
	 * otherwise the chosen person has to be on it. Travel legs are not: a leg
	 * belongs to the people making that journey, and a leg they are not on is not
	 * part of their day.
	 *
	 * A draft is patched in before the filter rather than drawn as a second
	 * ghost block. Everything downstream (the layout, the map, the agenda, who
	 * fits in a block) then reads one board, so the preview cannot disagree with
	 * itself, and an edit that takes the reader off the event correctly removes
	 * it from their day. A block being added is inserted the same way, which is
	 * what makes the two dialogs behave alike.
	 *
	 * The day's journeys are replanned against that draft rather than shifted or
	 * dropped. Who is on an event is the whole of splitting and rejoining, so an
	 * edit to it makes journeys appear, merge and vanish; waiting for the server
	 * to say so meant the board stood with holes in it while the reader decided.
	 * Pins survive, because a replanned journey is matched to its stored row by
	 * key.
	 */
	const board: BoardDay[] = useMemo(() => {
		const showEvent = (e: EventRow) =>
			e.people.length === 0 || e.people.some((p) => selected.has(p));
		const showLeg = (l: LegRow) => l.people.some((p) => selected.has(p));

		return (data?.board ?? []).map((entry) => ({
			...entry,
			events: applyDraft(entry, preview).filter(showEvent),
			legs: (preview ? replanLegs(entry, preview) : entry.legs).filter(showLeg)
		}));
	}, [data, selected, preview]);

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

	/* Pointing at a journey opens the event it arrives at, because that is where
	   a journey is edited: it belongs to its arrival rather than standing on its
	   own. The id is kept so the dialog can open on the journey that was meant,
	   since a block can have one arriving group of people or five. */
	const openLeg = (leg: LegRow) => {
		setOpenLegId(leg.id);
		setOpenEventId(leg.toEventId);
	};
	/** The same panel, opened at the event itself rather than at an approach. */
	const openBlock = (id: string) => {
		setOpenLegId('');
		setOpenEventId(id);
	};
	const closeEvent = () => {
		setOpenEventId('');
		setOpenLegId('');
	};

	/* The saved row, deliberately not the previewed one: the dialog is the
	   source of the draft and handing it back its own edit would make the two
	   states race. It also keeps the delete confirmation naming the event as it
	   stands on the server rather than as it is being renamed. */
	const openEvent = useMemo(() => {
		if (!openEventId) return null;
		for (const entry of data?.board ?? [])
			for (const e of entry.events) if (e.id === openEventId) return e;
		return null;
	}, [openEventId, data]);

	/* The journeys that dialog edits, replanned live: an edit to who is going
	   makes groups split and merge as it is typed, and this is the same list the
	   board is drawing behind the panel. */
	const openLegs = useMemo(() => {
		if (!openEventId) return [];
		return board.flatMap((entry) => entry.legs.filter((l) => l.toEventId === openEventId));
	}, [openEventId, board]);

	/* Which edge the open dialog stands at. On one day the board is beside the
	   map on the right, so the panel takes the map's side; across three days it
	   takes the side the event is furthest from. Whichever dialog is open: an
	   add and an edit are the same panel over the same board. */
	const dockSide: 'left' | 'right' = useMemo(() => {
		const day = openEvent?.day ?? adding?.day;
		if (!day) return 'right';
		const at = board.findIndex((b) => b.day === day);
		return at >= 0 && at >= board.length / 2 ? 'left' : 'right';
	}, [openEvent, adding, board]);

	/* Keep the block being edited in sight.
	 *
	 * The board is as tall as the day, so a start moved from breakfast to
	 * midnight lands off screen and the preview would be showing nothing.
	 *
	 * The target is computed from the draft rather than measured off the block,
	 * because a block eases into its new position over `--sched-settle` and the
	 * rect at this point is still most of a day away from where it is going. The
	 * lane it sits in does not move, so its top plus the draft's own offset is
	 * the answer the animation is heading for. Only ever scrolls when the block
	 * would otherwise be out of view, and only as far as it has to. */
	useEffect(() => {
		if (!preview || !roomToDock) return;
		const lane = document.querySelector('.sched .block.editingnow')?.closest('.lane');
		if (!lane) return;
		const laneTop = lane.getBoundingClientRect().top;
		const top = laneTop + topPx(preview.start_min);
		const bottom = laneTop + topPx(preview.end_min);
		const margin = 56;
		const over = bottom - (window.innerHeight - margin);
		const under = top - margin;
		// Never past the block's own top: a long event cannot be shown whole, and
		// the end of one is worth less than knowing where it begins.
		const by = under < 0 ? under : over > 0 ? Math.min(over, under) : 0;
		if (by) window.scrollBy({ top: by, behavior: 'smooth' });
	}, [preview, roomToDock]);

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
			preview?.id === ev.id ? 'editingnow' : '',
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
					openBlock(ev.id);
				}}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						openBlock(ev.id);
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

	/**
	 * What a journey is called: the name somebody gave it, or where it came from.
	 *
	 * Where it came from, not where it lands. The bar sits on the event it leads
	 * into, so naming its arrival would repeat what the position already says.
	 * The origin is the one thing the drawing no longer carries, so the label
	 * carries it instead, and only while there is room to read it.
	 */
	function legName(leg: LegRow, wpx: number): string {
		if (leg.title) return leg.title;
		const mode = modeLabel(leg.resolvedMode);
		const from = eventById.get(leg.fromEventId)?.title;
		return wpx > 230 && from ? `${mode} from ${from}` : mode;
	}

	/**
	 * A journey, drawn as the block it is, in the column of the event it arrives
	 * at and directly on top of it.
	 *
	 * An automatic leg and a travel event somebody typed describe the same act,
	 * so they are the same block: same colour, same column, same name on the
	 * front. A leg keeps one difference, and it is a fact about the leg rather
	 * than about where it came from: it cannot be dragged, because its position
	 * is the gap between the two events it joins, and moving it would mean
	 * moving one of them.
	 */
	function legNode(leg: LegRow, lanePx: number, box: { left: number; width: number }) {
		const wpx = box.width * lanePx;
		const name = legName(leg, wpx);
		const mins = leg.endMin - leg.startMin;
		// A short hop cannot carry two lines of type, so it is drawn as a rule
		// across the gap with its duration on it, floored to a height a pointer
		// can hit. The floor grows upwards, into the waiting time before the
		// journey, because downwards is the block it arrives at.
		const trueH = heightPx(leg.startMin, leg.endMin);
		const h = Math.max(trueH, 15);
		const thin = trueH < TWO_LINE_H;
		const bud = whoBudget(box.width, mins, name, lanePx);
		const cls = [
			'block',
			'travel',
			'leg',
			thin ? 'thin' : '',
			wpx < TINY_W ? 'tiny' : '',
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
				onClick={() => openLeg(leg)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						openLeg(leg);
					}
				}}
			>
				<div className="bt">
					{thin
						? // A bar one column wide holds a duration and nothing else. It is
							// still the more legible mark: at that width the event title
							// beneath it has already truncated.
							wpx > 90
							? `${name} ${leg.resolvedMins}m`
							: `${leg.resolvedMins}m`
						: name}
				</div>
				{!thin && (
					<div className="bmeta">
						{bud.showTime && <span>{`${hhmm(leg.startMin)}-${hhmm(leg.endMin)}`}</span>}
						<span>{leg.resolvedMins}m</span>
					</div>
				)}
			</div>
		);
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
		   day made the gap it fills look free. Each journey hangs under the event
		   it arrives at, so it is under the thing it leads into by construction
		   and the board needs no lines.

		   A block being dragged or waiting on its write takes its arriving
		   journeys with it, since they are drawn in the gap in front of it. The
		   columns are laid out from the stored times either way: re-packing them
		   under the pointer would move every other block on the day while one is
		   being nudged. */
		const byId = new Map(entry.events.map((e) => [e.id, e]));
		const legs = entry.legs.map((l) => {
			const to = byId.get(l.toEventId);
			return to ? shiftLeg(l, startFor(to) - to.start_min) : l;
		});

		const { layout: place, bars } = layoutBoard(
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
			legs
		);

		const items: LaneItem[] = [
			// Journeys first, so where a short hop's floored height has to reach
			// back past the block it left, the block stays on top of it.
			...bars.map((b) => ({ kind: 'leg', leg: b.leg, left: b.left, width: b.width }) as const),
			...entry.events.map((ev) => ({ kind: 'event', ev }) as const)
		];

		return (
			<div className="daygrid" style={{ height: `${(DAY_END - DAY_START) * PX_PER_MIN + 16}px` }}>
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
						// block it is not: blocks have their own dialogs, and opening a
						// second one over the top would be a trap.
						if ((e.target as HTMLElement).closest('.block')) return;
						const rect = e.currentTarget.getBoundingClientRect();
						const mins = DAY_START + (e.clientY - rect.top) / PX_PER_MIN;
						const snapped = Math.round(mins / 15) * 15;
						setAdding({
							day: entry.day,
							start: Math.min(Math.max(snapped, DAY_START), DAY_END - 15)
						});
					}}
				>
					{items.map((it) =>
						it.kind === 'event'
							? blockNode(it.ev, entry.day, opts.lanePx, place)
							: legNode(it.leg, opts.lanePx, { left: it.left, width: it.width })
					)}
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
											onClick={() => openBlock(ev.id)}
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
						open: () => openBlock(ev.id)
					})),
					...(anchor?.legs ?? []).map((leg) => ({
						key: legKey(leg),
						start: leg.startMin,
						// A list row has a full line to itself, so it always names the origin.
						title: legName(leg, Number.POSITIVE_INFINITY),
						meta: `${modeLabel(leg.resolvedMode)} · ${leg.resolvedMins}m`,
						tight: leg.tight,
						open: () => openLeg(leg)
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
	 * numbered and joined up.
	 *
	 * Two conditions, both about honesty rather than tidiness. Nothing may
	 * overlap, because two things at once have no first. And everybody on the
	 * day must be doing the same things, because a day that splits has one order
	 * per track and no order overall: a line through those pins would draw a
	 * route nobody takes, crossing between groups that never met. People with
	 * nothing scheduled do not break it: they are simply absent from every
	 * event's list. Reading the day as one person drops the second condition,
	 * because their own thread through a day is a sequence however the rest of
	 * the group divides.
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
			numbered: ordered,
			line: ordered
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
					dock={dockSide}
					peek={roomToDock}
					onPreview={setPreview}
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
					legs={openLegs}
					focusLegId={openLegId}
					eventOf={(id) => eventById.get(id) ?? null}
					peopleLabel={peopleLabel}
					memberOptions={memberOptions}
					crews={data.crews}
					saved={data.saved}
					cities={data.cities}
					cityId={openEvent.city_id ?? cityOfDay(openEvent.day)}
					dock={dockSide}
					peek={roomToDock}
					onPreview={setPreview}
					onClose={closeEvent}
					onDone={() => {
						closeEvent();
						reload();
					}}
				/>
			)}
		</div>
	);
}
