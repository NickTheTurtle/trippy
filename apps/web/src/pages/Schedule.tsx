import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useLiveSection } from '../hooks/useTripEvents';
import useMediaQuery from '../hooks/useMediaQuery';
import useSlideIn, { dayRank } from '../hooks/useSlideIn';
import { useTrip } from './TripShell';
import FormError from '../components/ui/FormError';
import EmptyState from '../components/ui/EmptyState';
import Select from '../components/ui/Select';
import WarnMark from '../components/ui/WarnMark';
import { useToast } from '../components/ui/Toast';
import GoogleMap, { type MapTrack } from '../components/GoogleMap';
import TripMap from '../components/TripMap';

import { type Layout } from '@trippy/core/layout';
import { layoutBoard, legLaneId } from '@trippy/core/travel';
import type { EventType } from '@trippy/core/types';
import { copy } from '../copy';
import AddEventDialog from './schedule/AddEventDialog';
import EventDialog from './schedule/EventDialog';
import { applyDraft, replanLegs } from './schedule/replan';
import {
	DAY_END,
	DRAFT_ID,
	MIN_EVENT_MINS,
	PX_PER_MIN,
	clock,
	clockRange,
	dayLabel,
	heightPx,
	hourLabel,
	hoursFrom,
	modeLabel,
	topPx,
	typeLabel,
	whoBudget,
	windowStart
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
	{ v: 'agenda', label: 'Agenda' }
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

/** A block under the pointer. */
type Drag = {
	id: string;
	day: string;
	pointerStartY: number;
	/** Where the pointer is now, so the edge loop can run without one moving. */
	pointerY: number;
	origStart: number;
	/** How long the block is, so a drag cannot push it off the end of the day. */
	mins: number;
	/** Minutes the viewport has been travelled past where the pointer reaches. */
	creep: number;
	liveStart: number;
};

/** A block's bottom edge under the pointer. */
type Resize = {
	id: string;
	pointerStartY: number;
	startMin: number;
	origEnd: number;
	liveEnd: number;
};

/** How close to an edge of the day's viewport counts as pushing against it. */
const EDGE_PX = 72;
/** Minutes a second the board travels at when the pointer is at the very edge. */
const EDGE_RATE = 150;
/** The shortest day viewport worth scrolling inside, on a short screen. */
const MIN_VIEW_H = 320;
/**
 * Breathing room under the board card, so it does not sit on the bottom edge
 * of the screen.
 *
 * This is the whole of the guess in the height. What the card keeps for itself
 * under the box is measured off the card, and what the page keeps under the
 * card is measured off the document, so neither is repeated here as a number
 * that could drift out of step with the stylesheet.
 */
const VIEW_AIR = 8;
/**
 * The room the scroll box leaves above the first hour line, for the label that
 * hangs over it. Set in `schedule.css` as `.boardscroll`'s `padding-top`, and
 * repeated here because a drag measures where the block it is holding sits
 * inside the box against `scrollTop`, whose origin is the top of that padding
 * rather than the top of the grid.
 */
const BOARD_PAD_PX = 12;

/**
 * Where a dragged block sits: the pointer's own travel, plus whatever the edge
 * loop has added to it.
 *
 * `creep` is minutes, positive for the top edge and negative for the bottom, so
 * one number covers pushing against either end of the viewport.
 *
 * Snapped to five minutes, because the block carries its time as a label and a
 * board that reads 9:37 while a hand is moving is noise rather than precision.
 */
function liveStartFor(d: Drag, creep: number, y: number): number {
	const raw = d.origStart + (y - d.pointerStartY) / PX_PER_MIN - creep;
	return Math.max(0, Math.min(DAY_END - d.mins, Math.round(raw / 5) * 5));
}

/**
 * One event on the day board.
 *
 * Lifted out of the page and memoised, which is the drag fix. A pointer move
 * changes where one block is drawn, but it used to re-render every one of them:
 * a busy day is forty blocks, each of them a title, a time and a row of names,
 * and rebuilding all of it to move one cost about ten milliseconds a move,
 * which is most of a frame before the browser has drawn anything.
 *
 * So everything this needs arrives as a number, a string or a value that keeps
 * its identity between renders: the event row off the board, the callbacks
 * behind `useCallback`, the column as two numbers rather than the layout object
 * that is rebuilt each pass. Only the block under the pointer sees a changed
 * prop, so only that one renders. When the window opens, `boardStart` moves and
 * they all render, which is right: they have all moved.
 *
 * `didDrag` is a ref rather than a value because the click that follows a drag
 * has to read it in the same event sequence that set it.
 */
type BlockProps = {
	ev: EventRow;
	day: string;
	lanePx: number;
	left: number;
	width: number;
	from: number;
	to: number;
	boardStart: number;
	dragging: boolean;
	resizing: boolean;
	editing: boolean;
	memberCount: number;
	shortName: (id: string) => string;
	didDrag: React.RefObject<boolean>;
	onDown: (e: React.PointerEvent, ev: EventRow, day: string) => void;
	onMove: (e: React.PointerEvent) => void;
	onUp: () => void;
	onOpen: (id: string) => void;
	onGripDown: (e: React.PointerEvent, ev: EventRow) => void;
	onGripMove: (e: React.PointerEvent) => void;
	onGripUp: () => void;
};

const Block = memo(function Block({
	ev,
	day,
	lanePx,
	left,
	width,
	from,
	to,
	boardStart,
	dragging,
	resizing,
	editing,
	memberCount,
	shortName,
	didDrag,
	onDown,
	onMove,
	onUp,
	onOpen,
	onGripDown,
	onGripMove,
	onGripUp
}: BlockProps) {
	const bud = whoBudget(width, to - from, ev.title, lanePx);
	const cls = [
		'block',
		ev.type,
		dragging ? 'dragging' : '',
		resizing ? 'resizing' : '',
		editing ? 'editingnow' : '',
		width < 0.34 ? 'narrow' : ''
	]
		.filter(Boolean)
		.join(' ');

	return (
		<div
			className={cls}
			role="button"
			tabIndex={0}
			aria-label={`${ev.title}, ${clock(ev.start_min)} to ${clock(ev.end_min)}. Open, or drag to reschedule.`}
			style={{
				left: `${left * 100}%`,
				width: `calc(${width * 100}% - 6px)`,
				top: `${topPx(from, boardStart)}px`,
				height: `${heightPx(from, to, boardStart)}px`,
				['--trows' as string]: bud.trows,
				['--wrows' as string]: bud.wrows
			}}
			onPointerDown={(e) => onDown(e, ev, day)}
			onPointerMove={onMove}
			onPointerUp={onUp}
			onClick={(e) => {
				if ((e.target as HTMLElement).closest('.bresize')) return;
				if (didDrag.current) return;
				onOpen(ev.id);
			}}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onOpen(ev.id);
				}
			}}
		>
			<div className="bt">{ev.title}</div>
			<div className="bmeta">
				{bud.showTime && <span>{bud.compact ? clock(from) : clockRange(from, to)}</span>}
			</div>
			<div className="bwho">
				{ev.people.length === 0 || ev.people.length === memberCount ? (
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
				onPointerDown={(e) => onGripDown(e, ev)}
				onPointerMove={onGripMove}
				onPointerUp={onGripUp}
			/>
		</div>
	);
});

/**
 * A journey, drawn as the block it is, in the column of the event it arrives
 * at and directly on top of it.
 *
 * An automatic leg and a travel event somebody typed describe the same act, so
 * they are the same block: same colour, same column, same name on the front. A
 * leg keeps one difference, and it is a fact about the leg rather than about
 * where it came from: it cannot be dragged, because its position is the gap
 * between the two events it joins, and moving it would mean moving one of them.
 *
 * Memoised for the same reason as `Block`: a drag moves the journeys arriving
 * at the block under the pointer and leaves every other one of them where it
 * was. The two names it draws are worked out by the page and handed over as
 * strings, which compare by value, so they cost a render only when they differ.
 */
type LegProps = {
	leg: LegRow;
	lanePx: number;
	left: number;
	width: number;
	boardStart: number;
	name: string;
	title: string;
	editing: boolean;
	onOpen: (leg: LegRow) => void;
};

const Leg = memo(function Leg({
	leg,
	lanePx,
	left,
	width,
	boardStart,
	name,
	title,
	editing,
	onOpen
}: LegProps) {
	const wpx = width * lanePx;
	const mins = leg.endMin - leg.startMin;
	// A short hop cannot carry two lines of type, so it is drawn as a rule
	// across the gap with its duration on it, floored to a height a pointer
	// can hit. The floor grows upwards, into the waiting time before the
	// journey, because downwards is the block it arrives at.
	const trueH = heightPx(leg.startMin, leg.endMin, boardStart);
	const h = Math.max(trueH, 15);
	const thin = trueH < TWO_LINE_H;
	const bud = whoBudget(width, mins, name, lanePx);
	const cls = [
		'block',
		'travel',
		'leg',
		thin ? 'thin' : '',
		wpx < TINY_W ? 'tiny' : '',
		leg.tight ? 'tight' : '',
		editing ? 'editingnow' : '',
		width < 0.34 ? 'narrow' : ''
	]
		.filter(Boolean)
		.join(' ');

	return (
		<div
			className={cls}
			role="button"
			tabIndex={0}
			aria-label={`${name}, ${clock(leg.startMin)} to ${clock(leg.endMin)}. Open.`}
			title={title}
			style={{
				left: `${left * 100}%`,
				width: `calc(${width * 100}% - 6px)`,
				top: `${topPx(leg.endMin, boardStart) - h}px`,
				height: `${h}px`,
				['--trows' as string]: bud.trows,
				['--wrows' as string]: bud.wrows
			}}
			onClick={() => onOpen(leg)}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onOpen(leg);
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
					{bud.showTime && <span>{clockRange(leg.startMin, leg.endMin)}</span>}
					<span>{leg.resolvedMins}m</span>
				</div>
			)}
		</div>
	);
});

/**
 * The clock the day is read against.
 *
 * It depends on nothing but where the window starts, so it is memoised on that
 * alone: a block dragged around inside an open window does not move the hours,
 * and redrawing twenty rules and their labels for every pointer move was a
 * measurable part of what made the drag late.
 */
const Axis = memo(function Axis({ boardStart }: { boardStart: number }) {
	return (
		<div className="axis">
			{hoursFrom(boardStart).map((h) => (
				<div
					key={h}
					className="hourline"
					style={{ top: `${(h * 60 - boardStart) * PX_PER_MIN}px` }}
				>
					{/* Every rule is named, the closing midnight included.
					    It used to be left bare, on the reasoning that a board
					    dragged fully open would then carry two "12 AM"s. It would,
					    but they are a day and 1440px apart with twenty-three named
					    hours between them, and a box capped at 70vh has to be over
					    1440px tall before both are even on screen at once. What the
					    bare rule cost instead was on every ordinary board: the day
					    ran 11 PM, blank, and stopped without saying where. Each
					    midnight is true where it sits, one opening the day and one
					    closing it, so both are written. */}
					<span>{hourLabel(h)}</span>
				</div>
			))}
		</div>
	);
});

/** The url for a day and a view. The schedule is addressable; see `navUrl`. */
const navUrl = (day: string, v: string) => `?day=${day}&view=${v}`;

/**
 * The controls that apply to the whole schedule, and the board's own title bar.
 *
 * Both are memoised because neither has anything to do with a drag, and both
 * are built out of router links, which are not free: a `Link` resolves its
 * path on every render, and the eight of them across these two rows were
 * costing a JSON round trip each per pointer move.
 */
type ToolbarProps = {
	view: string;
	day: string;
	memberCount: number;
	readAs: string;
	viewAsOptions: { value: string; label: string; warn?: string }[];
	onViewAs: (id: string) => void;
	onAdd: () => void;
};

const Toolbar = memo(function Toolbar({
	view,
	day,
	memberCount,
	readAs,
	viewAsOptions,
	onViewAs,
	onAdd
}: ToolbarProps) {
	return (
		<div className="toolbar">
			<div className="pills" role="group" aria-label="Schedule view">
				{VIEW_OPTIONS.map((o) => (
					<Link
						key={o.v}
						className={o.v === view ? 'pill on' : 'pill'}
						aria-current={o.v === view ? 'true' : undefined}
						to={navUrl(day, o.v)}
					>
						{o.label}
					</Link>
				))}
			</div>

			<div className="tools">
				{/* On a solo trip the only person to read the board as is you, and the
				    control would be a dropdown with one name that changes nothing. */}
				{memberCount > 1 && (
					<div className="viewas">
						<span className="muted">{copy.viewAs.label}</span>
						<Select
							value={readAs}
							onChange={onViewAs}
							options={viewAsOptions}
							ariaLabel="View the schedule as"
						/>
					</div>
				)}
				<button className="btn primary" type="button" onClick={onAdd}>
					+ Add
				</button>
			</div>
		</div>
	);
});

/* The day stepper is the board's own title bar: it names the day being drawn
   and steps to the next one, so it belongs to the board rather than to the page
   toolbar, which is left holding only the controls that apply to the whole
   schedule.

   The day name is also the way to jump. A trip can be long - the Montreal one
   runs from September 2024 to September 2026, which is 400 days - and a stepper
   that moves one day at a time is no way to reach the middle of it. Rather than
   add a second control beside the arrows, the label itself opens a native date
   picker bounded by the first and last day the trip offers, which is the same
   range the arrows walk. That keeps the row to three things at 390px, needs no
   label of its own since the control is the date, and gives a phone the
   platform's own picker. The input underneath is the picker; the button on top
   is what stays readable as `Fri, Apr 17`. */
const BoardHead = memo(function BoardHead({
	label,
	view,
	day,
	first,
	last,
	prev,
	next
}: {
	label: string;
	view: string;
	day: string;
	first: string;
	last: string;
	prev: string | null;
	next: string | null;
}) {
	const navigate = useNavigate();
	const picker = useRef<HTMLInputElement | null>(null);
	const typing = useRef<number | null>(null);

	// `showPicker` is what opens the calendar on a click; where it is missing,
	// focusing the field still lets the keyboard and the platform take over.
	const openPicker = () => {
		const el = picker.current;
		if (!el) return;
		if (typeof el.showPicker === 'function') el.showPicker();
		else el.focus();
	};

	useEffect(() => () => window.clearTimeout(typing.current ?? undefined), []);

	/* The field is uncontrolled, and synced instead.
	 *
	 * As a controlled input it cannot be typed into at all: React restores the
	 * value after every change, so each segment entered is wiped before the next
	 * one arrives. Keeping the day in the DOM node and writing it back only when
	 * the board has moved, and only while the field is not the thing being
	 * typed into, leaves the calendar opening on the day being drawn without
	 * fighting the keyboard for the field. */
	useEffect(() => {
		const el = picker.current;
		if (el && document.activeElement !== el) el.value = day;
	}, [day]);

	/* A picked day is a day the board can draw.
	 *
	 * The range guard is not belt and braces: a date outside `min` and `max`
	 * reaches here whenever the field is typed into rather than picked, and
	 * following it would put a day in the url that the server then clamps away,
	 * leaving the address bar naming one day and the board drawing another.
	 *
	 * The delay is for the same path. A calendar pick arrives as a single
	 * change with the field unfocused, so it lands at once. Typing arrives a
	 * segment at a time, and every part-typed date is itself a complete date:
	 * entering 05/01/2026 walks through 2024-05-09 and 2024-06-09 on the way,
	 * and without the wait the board jumps to each of them and re-renders the
	 * field back to the day it landed on, so the rest of what you type is thrown
	 * away and the date can never be finished. */
	const jump = (value: string) => {
		if (!value || value < first || value > last || value === day) return;
		navigate(navUrl(value, view));
	};

	/* A one day trip has nothing to jump to.
	 *
	 * When the first day the board offers is also the last, the picker can only
	 * ever re-pick the day already drawn, so the day name goes back to being a
	 * day name: no button, no field, no affordance and nothing in the tab order.
	 * Leaving it focusable but plain would be worse than leaving it as it was,
	 * since a keyboard would still land on it and find nothing there. The text
	 * is identical either way. Two days is enough to jump, so the test is on the
	 * ends being equal rather than on any count of days. */
	const jumpable = first !== last;

	return (
		<div className="boardhead">
			{prev ? (
				<Link className="navbtn" to={navUrl(prev, view)} aria-label="Previous day">
					‹
				</Link>
			) : (
				<button className="navbtn" type="button" disabled aria-label="Previous day">
					‹
				</button>
			)}
			<span className="curday">
				{jumpable ? (
					<>
						<button
							type="button"
							className="daypick"
							onClick={openPicker}
							aria-label="Jump to a date"
						>
							{label}
						</button>
						<input
							ref={picker}
							className="daypickfield"
							type="date"
							defaultValue={day}
							min={first}
							max={last}
							tabIndex={-1}
							aria-hidden="true"
							onChange={(e) => {
								const value = e.target.value;
								window.clearTimeout(typing.current ?? undefined);
								if (document.activeElement === picker.current)
									typing.current = window.setTimeout(() => jump(value), 600);
								else jump(value);
							}}
						/>
					</>
				) : (
					label
				)}
			</span>
			{next ? (
				<Link className="navbtn" to={navUrl(next, view)} aria-label="Next day">
					›
				</Link>
			) : (
				<button className="navbtn" type="button" disabled aria-label="Next day">
					›
				</button>
			)}
		</div>
	);
});

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
	const toast = useToast();
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
	const [adding, setAdding] = useState<{
		day: string;
		start: number | null;
		type?: EventType;
	} | null>(null);
	const [openEventId, setOpenEventId] = useState('');
	const [openLegId, setOpenLegId] = useState('');
	/** The open edit dialog's unsaved draft, drawn on the board as it is typed. */
	const [preview, setPreview] = useState<EventDraft | null>(null);

	/* Whether there is room beside the board for the edit dialog to peek.
	 *
	 * Below this the panel covers what it is previewing whichever edge it stands
	 * at, so it dims the page and holds it still like any other dialog. The
	 * preview is still computed: it costs nothing and the board is correct the
	 * moment the dialog is dismissed. */
	const roomToDock = useMediaQuery('(min-width: 1100px)');

	/**
	 * Live drag of a single block, and the live resize of one, both held the same
	 * way.
	 *
	 * The ref is the truth and the state is the copy that renders. Pointer moves
	 * are continuous events, so React may defer the commit that follows the
	 * pointer-down that started the gesture, and every handler that read it
	 * through its closure saw `null` until it landed: a quick flick moved
	 * nothing, and a fast press-and-release could leave the gesture standing. The
	 * ref is right in the same tick that writes it, which is the only guarantee a
	 * gesture can be built on.
	 */
	const dragRef = useRef<Drag | null>(null);
	const [drag, setDrag] = useState<Drag | null>(null);
	const resizeRef = useRef<Resize | null>(null);
	const [resize, setResize] = useState<Resize | null>(null);

	/**
	 * A gesture that has moved but has not been drawn yet.
	 *
	 * Rendering straight out of the pointer handler meant a commit of the whole
	 * page per move: the board, its journeys, the toolbar and the map, to shift
	 * one block by three pixels. A mouse can report faster than the screen can
	 * draw, so some of those commits were thrown away unpainted, and on a busy
	 * day the rest arrived late enough to see.
	 *
	 * So a move writes the ref, which is what every handler and the drop read,
	 * and only marks the render dirty. The frame that is about to be painted is
	 * what clears it: `flush` below for a resize, and the edge-travel loop for a
	 * drag, which is already running a frame at a time for the whole gesture and
	 * so needs no second timer. At most one commit is drawn per frame, and the
	 * one that is drawn is always the latest position rather than the oldest
	 * unpainted one.
	 */
	const dirty = useRef(false);
	const flushRaf = useRef(0);
	const flush = useCallback(() => {
		flushRaf.current = 0;
		if (!dirty.current) return;
		dirty.current = false;
		setDrag(dragRef.current);
		setResize(resizeRef.current);
	}, []);
	/** Mark the gesture moved. Cheap enough to call on every pointer event. */
	const touch = useCallback(() => {
		dirty.current = true;
		if (!flushRaf.current) flushRaf.current = requestAnimationFrame(flush);
	}, [flush]);
	useEffect(() => () => cancelAnimationFrame(flushRaf.current), []);

	/** Start or end a gesture: drawn at once, since nothing else will draw it. */
	const putDrag = useCallback((next: Drag | null) => {
		dragRef.current = next;
		dirty.current = false;
		setDrag(next);
	}, []);
	const putResize = useCallback((next: Resize | null) => {
		resizeRef.current = next;
		dirty.current = false;
		setResize(next);
	}, []);

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

	/* The board's viewport: the box every view scrolls inside, with the day's
	   title bar, its stepper and the lodging band standing still above it, and
	   the map beside it stretched to the same height by the grid.

	   Its height is whatever is left between its own top and the bottom of the
	   screen, less what is drawn under it. Measured rather than stated, because
	   the board's top depends on a toolbar that wraps at narrow widths and a
	   lodging band holding anything from nothing to three stays, and because
	   what sits under the box is the card's own padding, which belongs to the
	   stylesheet rather than to this file. The measurement is taken in document
	   coordinates (`rect.top + scrollY`), which is where the box sits whatever
	   the page has been scrolled to: reading the viewport-relative top would
	   make the height grow as the page scrolls, which would grow the page,
	   which would let it scroll further.

	   The page's own trailing air is pulled back up in the same pass. The page
	   keeps 96px under its last section, which is right for a page that ends
	   where its content ends and wrong for this one, which is built to finish
	   at the bottom of the screen: all that air did was push the board past the
	   fold and grow a second scrollbar around a board that has its own. What is
	   pulled is measured and bounded by the air that is actually there, so a
	   board too tall for the screen still scrolls the page to its last row
	   rather than having its end cut off. */
	const scrollRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const pullRef = useRef(0);
	const [viewH, setViewH] = useState(0);
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const fit = () => {
			const card = el.parentElement;
			const root = rootRef.current;
			if (!card || !root) return;
			const box = el.getBoundingClientRect();
			const docTop = box.top + window.scrollY;
			// What the card draws under the box, which is its padding today.
			const cardTail = Math.max(0, card.getBoundingClientRect().bottom - box.bottom);
			setViewH(Math.max(MIN_VIEW_H, window.innerHeight - docTop - cardTail - VIEW_AIR));

			const doc = document.documentElement;
			const pull = pullRef.current;
			// Both measured with the current pull already applied, so one pass
			// lands on the fixed point rather than creeping towards it.
			const over = doc.scrollHeight - window.innerHeight;
			const air = doc.scrollHeight - (root.getBoundingClientRect().bottom + window.scrollY);
			const want = Math.round(Math.min(Math.max(0, pull + over), pull + air));
			if (Math.abs(want - pull) > 1) {
				pullRef.current = want;
				root.style.setProperty('--tailpull', `${want}px`);
			}
		};
		fit();
		window.addEventListener('resize', fit);
		/* The web font lands after the first paint, and it is narrower than the
		   fallback: on a phone the lodging band comes back from two rows to one
		   when it arrives. That moves the box up without changing the height of
		   the card around it, since the box absorbs what the band gave back, so
		   the observer below never fires and the board keeps a height measured
		   against a layout that no longer exists. Measured, that was 34px of
		   the day at 390px. */
		if (document.fonts) void document.fonts.ready.then(fit);
		// The card above the box is what moves its top: a toolbar that wraps, a
		// lodging band that gains a stay. Watching the card catches both without
		// a dependency list that has to list everything the board can grow.
		const ro = new ResizeObserver(fit);
		if (el.parentElement) ro.observe(el.parentElement);
		return () => {
			window.removeEventListener('resize', fit);
			ro.disconnect();
		};
	}, [data]);

	/* The board's one write path: a drag that lands, a resize that lands. Its
	   failures are corner toasts rather than a line above the board. The line
	   was in the wrong place twice over: the board is a scroll box that fills
	   the screen now, so the top of the page is not where the reader is, and a
	   refused gesture is answered where the block they just moved is, not a
	   screenful away. The corner is also in the top layer, so a dialog opened
	   afterwards cannot bury the message. The load failure further down stays
	   inline: it is not the result of an action, it is the whole of the page
	   when it fires, and a popup over a blank screen explains itself and then
	   leaves nothing behind. The two event dialogs report their own saves in
	   their own footers, beside the form that caused them. */
	const act = useCallback(
		async (fn: () => Promise<unknown>) => {
			try {
				await fn();
				reload();
			} catch (err) {
				setPending(null);
				toast.error(err instanceof ApiError ? err.message : copy.api.saveFallback);
			}
		},
		[reload, toast]
	);

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
	/** First name only: chips and journey labels get cramped fast. */
	const shortName = useCallback(
		(id: string) => (memberName.get(id) ?? '?').split(' ')[0],
		[memberName]
	);

	/**
	 * Who the board is being read as.
	 *
	 * The agenda is one person's day by definition, so it has no "Everyone" to
	 * fall back to: entering it with nobody chosen reads as you, which is the
	 * agenda a reader almost always wants and the one they can check fastest.
	 * Leaving the view does not strand that choice, because `viewAs` itself is
	 * untouched: an agenda read as yourself returns to a day board read as
	 * everyone.
	 */
	const readAs = useMemo(() => {
		if (data?.view !== 'agenda' || viewAs) return viewAs;
		const roster = new Set(memberIds);
		return data?.me && roster.has(data.me) ? data.me : (memberIds[0] ?? '');
	}, [data?.view, data?.me, viewAs, memberIds]);

	const selected = useMemo(() => {
		const roster = new Set(memberIds);
		return new Set(readAs && roster.has(readAs) ? [readAs] : memberIds);
	}, [readAs, memberIds]);

	/**
	 * The board with the edit in progress applied, before "view as".
	 *
	 * A draft is patched in here rather than drawn as a second ghost block.
	 * Everything downstream (the layout, the map, the agenda, who fits in a
	 * block) then reads one board, so the preview cannot disagree with itself,
	 * and an edit that takes the reader off the event correctly removes it from
	 * their day. A block being added is inserted the same way, which is what
	 * makes the two dialogs behave alike.
	 *
	 * The day's journeys are replanned against that draft rather than shifted or
	 * dropped. Who is on an event is the whole of splitting and rejoining, so an
	 * edit to it makes journeys appear, merge and vanish; waiting for the server
	 * to say so meant the board stood with holes in it while the reader decided.
	 * Pins survive, because a replanned journey is matched to its stored row by
	 * key.
	 */
	const planned: BoardDay[] = useMemo(
		() =>
			(data?.board ?? []).map((entry) => {
				const { events, stays } = applyDraft(entry, preview);
				return {
					...entry,
					events,
					stays,
					legs: preview ? replanLegs(entry, preview, memberIds) : entry.legs
				};
			}),
		[data, preview, memberIds]
	);

	/* The same board, through "view as". An event with nobody on it belongs to
	   the whole group and is always shown; otherwise the chosen person has to be
	   on it. Travel legs are not: a leg belongs to the people making that
	   journey, and a leg they are not on is not part of their day. */
	const board: BoardDay[] = useMemo(() => {
		const showEvent = (e: EventRow) =>
			e.people.length === 0 || e.people.some((p) => selected.has(p));
		const showLeg = (l: LegRow) => l.people.some((p) => selected.has(p));

		return planned.map((entry) => ({
			...entry,
			events: entry.events.filter(showEvent),
			stays: entry.stays.filter(showEvent),
			legs: entry.legs.filter(showLeg)
		}));
	}, [planned, selected]);

	/**
	 * Who cannot make one of today's journeys in the time the day leaves them.
	 *
	 * Read off `planned` rather than off `board`, which is to say before "view
	 * as" is applied. A warning that disappeared the moment you looked at
	 * somebody else would only ever reach the person who already knew, and the
	 * whole point of the mark is to be seen from a day you are not reading.
	 */
	const tightPeople = useMemo(() => {
		const out = new Set<string>();
		for (const entry of planned) {
			for (const leg of entry.legs) {
				if (leg.tight) for (const p of leg.people) out.add(p);
			}
		}
		return out;
	}, [planned]);

	/* The "view as" choices: the whole trip, or one person. Names carry the same
	   "(you)" suffix the money pages use, so the reader finds themselves in the
	   list by the same mark everywhere, and a warning mark beside one says that
	   person's day does not join up. "Everyone" carries it when anybody's does,
	   which is what puts the mark on the closed control by default, and it is
	   absent in the agenda, which is a list of one person's day and has nothing
	   to show for a group. */
	const viewAsOptions = useMemo(
		() => [
			...(data?.view === 'agenda'
				? []
				: [
						{
							value: '',
							label: copy.viewAs.everyone,
							warn: tightPeople.size ? copy.viewAs.travelWarning : undefined
						}
					]),
			...members.map((m) => ({
				value: m.id,
				label: m.name + (m.id === data?.me ? copy.preparation.youSuffix : ''),
				warn: tightPeople.has(m.id) ? copy.viewAs.travelWarning : undefined
			}))
		],
		[members, data?.me, data?.view, tightPeople]
	);

	const anchor = useMemo(
		() => (data ? (board.find((b) => b.day === data.day) ?? board[0] ?? null) : null),
		[board, data]
	);
	const anchorCity = anchor?.city ?? null;

	/**
	 * Whether Google has taken itself off the table.
	 *
	 * A key that is present but refused is worse than no key at all: the reader
	 * gets Google's own failure card where Leaflet would have drawn the map. The
	 * signal arrives seconds after the map is constructed, well after first
	 * paint, so this cannot be decided while choosing what to mount and has to
	 * be state the panel re-renders on. It only ever travels one way in a
	 * session, and it may be raised more than once, which setting a flag already
	 * absorbs.
	 */
	const [mapsOut, setMapsOut] = useState(false);

	/**
	 * The first minute the board draws when nothing is being dragged.
	 *
	 * The day's own contents decide it: its blocks and its journeys, both of
	 * which already carry the draft in an open dialog, so setting a block to 4:40
	 * opens the board as it is typed. A drag opens it further through `openFloor`
	 * rather than through here, because this snaps to the hour and a gesture
	 * needs the minute.
	 */
	const winStart = useMemo(
		() =>
			windowStart([
				...(anchor?.events ?? []).map((e) => e.start_min),
				...(anchor?.legs ?? []).map((l) => l.startMin)
			]),
		[anchor]
	);

	/**
	 * Where a dropped block has opened the window to, held until its day comes
	 * back from the server.
	 *
	 * The same gap `pending` bridges, for the same reason. A block let go at 3:30
	 * is drawn there immediately, and a window that snapped shut on pointer-up
	 * and reopened when the write landed would blink the board for the length of
	 * a round trip. Released when the day arrives, whatever it says.
	 */
	const [openFloor, setOpenFloor] = useState<number | null>(null);
	useEffect(() => {
		setOpenFloor(null);
	}, [data]);

	/**
	 * The first minute actually drawn, and the origin every position is measured
	 * from.
	 *
	 * A drag drives it directly: the window follows the block down to the minute,
	 * rather than the block being held inside the window. That is what lets a
	 * block be dragged into hours the board was not showing, and because it is
	 * continuous it never steps. `winStart` is the floor it returns to.
	 */
	const boardStart = Math.min(winStart, (drag ? drag.liveStart : openFloor) ?? winStart);

	/**
	 * Keep the dragged block under the pointer while the board moves beneath it.
	 *
	 * Two things move it, and both are corrected the same way, by scrolling the
	 * day's viewport in the same layout pass, before the browser paints.
	 *
	 * Opening the window is the first. The grid grows downwards from a top edge
	 * that stays put, so every minute already on the board, the one under the
	 * pointer included, slides down by whatever was opened above it. Scrolling
	 * the viewport down by exactly that cancels it, and there is always room
	 * because the content just grew by precisely that distance.
	 *
	 * Travelling at an edge is the second. A pointer held against the top or the
	 * bottom of the viewport keeps moving the block's time without moving the
	 * pointer, so the block would slide away from the cursor unless the hours
	 * slide past by the same amount. `creep` is exactly that distance in minutes,
	 * so scrolling by the negative of it keeps the block still and the day
	 * running past it.
	 *
	 * The two are one number, applied as a difference from the last pass, so a
	 * frame that does both nets out: opening the window while at the top of the
	 * box moves nothing, because the growth and the travel are the same growth.
	 *
	 * Then the block is held inside the box it is being dragged in. A viewport
	 * has edges the page did not: a pointer carried past the top of the box wants
	 * the block drawn above it, where it would be clipped and the gesture would
	 * be happening somewhere the reader cannot see. Staying visible is worth more
	 * than staying exactly under the cursor for the last few pixels, so the block
	 * is pinned at the edge it is pushing against and the day keeps running past
	 * it. The start wins over the end, since a block taller than the box cannot
	 * show both and the time it begins is the time being set.
	 *
	 * Only while a gesture owns the board. A window opened for a time typed into
	 * a dialog is not being held onto by anybody, and that one is better read as
	 * the board opening than hidden by moving the hours under it.
	 */
	const openedBy = winStart - boardStart;
	const glue = (openedBy - (drag?.creep ?? 0)) * PX_PER_MIN;
	const lastGlue = useRef(glue);
	useLayoutEffect(() => {
		const prev = lastGlue.current;
		lastGlue.current = glue;
		const el = scrollRef.current;
		const d = dragRef.current;
		if (!el || !d || glue === prev) return;
		el.scrollTop += glue - prev;
		const top = BOARD_PAD_PX + topPx(d.liveStart, boardStart);
		const foot = top + d.mins * PX_PER_MIN - el.clientHeight;
		el.scrollTop = Math.min(Math.max(el.scrollTop, foot), top);
	});

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
	const openLeg = useCallback((leg: LegRow) => {
		setOpenLegId(leg.id);
		setOpenEventId(leg.toEventId);
	}, []);
	/** The same panel, opened at the event itself rather than at an approach. */
	const openBlock = useCallback((id: string) => {
		setOpenLegId('');
		setOpenEventId(id);
	}, []);
	/** Add something to the day being read, with no time chosen yet. */
	const shownDay = data?.day;
	const addHere = useCallback(() => {
		if (shownDay) setAdding({ day: shownDay, start: null });
	}, [shownDay]);
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
		for (const entry of data?.board ?? []) {
			for (const e of entry.events) if (e.id === openEventId) return e;
			for (const s of entry.stays) if (s.id === openEventId) return s;
		}
		return null;
	}, [openEventId, data]);

	/* The journeys a dialog edits, replanned live: an edit to who is going makes
	   groups split and merge as it is typed, and this is the same list the board
	   is drawing behind the panel.

	   A block being added is on the board under the draft id, so it has journeys
	   before it exists. Those are read off `planned` rather than off `board`:
	   adding a block while reading as one person would otherwise hide the other
	   groups converging on it, and the same block reopened as everyone would
	   show them. A dialog about who is coming has to list everyone who is. */
	const legsTo = (entries: BoardDay[], eventId: string) =>
		entries.flatMap((entry) => entry.legs.filter((l) => l.toEventId === eventId));
	const openLegs = useMemo(
		() => (openEventId ? legsTo(board, openEventId) : []),
		[openEventId, board]
	);
	const draftLegs = useMemo(() => (adding ? legsTo(planned, DRAFT_ID) : []), [adding, planned]);

	/* Which edge the open dialog stands at. The board is beside the map, so the
	   panel takes the map's side and never covers the day it is describing.
	   Whichever dialog is open: an add and an edit are the same panel over the
	   same board. */
	const dockSide = 'right' as const;

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
		const el = scrollRef.current;
		const lane = document.querySelector('.sched .block.editingnow')?.closest('.lane');
		if (!el || !lane) return;
		const laneTop = lane.getBoundingClientRect().top;
		const top = laneTop + topPx(preview.start_min, boardStart);
		const bottom = laneTop + topPx(preview.end_min, boardStart);
		const box = el.getBoundingClientRect();
		const margin = 56;
		const over = bottom - (box.bottom - margin);
		const under = top - (box.top + margin);
		// Never past the block's own top: a long event cannot be shown whole, and
		// the end of one is worth less than knowing where it begins.
		const by = under < 0 ? under : over > 0 ? Math.min(over, under) : 0;
		if (by) el.scrollBy({ top: by, behavior: 'smooth' });
	}, [preview, roomToDock, boardStart]);

	const peopleLabel = useCallback(
		(ids: string[]) => {
			if (ids.length === 0) return 'Everyone';
			if (ids.length === members.length) return 'Everyone';
			return ids.map((id) => shortName(id)).join(', ');
		},
		[members.length, shortName]
	);

	// --- Map ----------------------------------------------------------------

	/**
	 * The pins and routes the map draws, and the panel that draws them.
	 *
	 * Both are memoised, and that is a drag fix rather than tidiness. Every
	 * pointer move commits a render of this page, and assembling the tracks
	 * inline handed the map a brand new array each time: the map then took a
	 * JSON signature of it to decide whether anything had moved, which came to
	 * thirty `JSON.stringify` calls and fifteen kilobytes of string per pointer
	 * move, to conclude every time that nothing had changed. None of this
	 * depends on the drag, so holding the whole panel by identity lets React
	 * skip the subtree outright while a block is under the pointer.
	 */
	const mapTracks: MapTrack[] = useMemo(() => {
		/* Every place the trip saved in Discover is on the map, so the day is read
		   against everything that was considered rather than against a blank
		   field: grey for the places this day does not visit, green for the ones
		   it does. */
		const dayPins = (anchor?.events ?? []).filter((e) => e.lat != null && e.lng != null);
		const scheduledPoiIds = new Set(
			(anchor?.events ?? []).map((e) => e.poi_id).filter((id): id is string => id !== null)
		);
		const restPins = (data?.saved ?? []).filter(
			(p) => p.lat != null && p.lng != null && !scheduledPoiIds.has(p.id)
		);

		/**
		 * Whether the day's places are a sequence, and so whether the pins may be
		 * numbered and joined up.
		 *
		 * Two conditions, both about honesty rather than tidiness. Nothing may
		 * overlap, because two things at once have no first. And everybody on the
		 * day must be doing the same things, because a day that splits has one
		 * order per track and no order overall: a line through those pins would
		 * draw a route nobody takes, crossing between groups that never met.
		 * People with nothing scheduled do not break it: they are simply absent
		 * from every event's list. Reading the day as one person drops the second
		 * condition, because their own thread through a day is a sequence however
		 * the rest of the group divides.
		 */
		const ordered = ((): boolean => {
			const evs = [...dayPins].sort((a, b) => a.start_min - b.start_min);
			if (evs.length < 2) return true;
			for (let i = 1; i < evs.length; i++) {
				if (evs[i].start_min < evs[i - 1].end_min) return false;
			}
			if (readAs) return true;
			const who = (e: EventRow) => (e.people.length ? [...e.people].sort().join(',') : '*');
			return evs.every((e) => who(e) === who(evs[0]));
		})();

		const tracks: MapTrack[] = [];
		if (restPins.length) {
			const cityName = new Map(
				(data?.cities ?? []).filter((c) => c !== null).map((c) => [c.id, c.name])
			);
			tracks.push({
				name: 'Saved locations',
				color: '#9aa39c',
				items: restPins.map((p) => ({
					title: p.name,
					lat: p.lat,
					lng: p.lng,
					/* Which city it is in, which neither the colour nor the track name
					   says, and how much appetite there is for it: a saved place is
					   read to decide whether to schedule it, and the vote is what that
					   decision turns on. */
					subtitle: cityName.get(p.city_id),
					detail: p.votes ? [p.votes === 1 ? '1 vote' : `${p.votes} votes`] : undefined
				})),
				line: false,
				numbered: false
			});
		}
		if (dayPins.length && data) {
			/* How you get here, which is the question a map is being asked. The legs
			   are the ones already on the board, so they answer it for whoever is
			   being read rather than for the group in the abstract. */
			const arrivals = new Map<string, LegRow[]>();
			for (const l of anchor?.legs ?? []) {
				const at = arrivals.get(l.toEventId);
				if (at) at.push(l);
				else arrivals.set(l.toEventId, [l]);
			}
			tracks.push({
				name: dayLabel(data.day),
				color: '#2f6d5e',
				items: [...dayPins]
					.sort((a, b) => a.start_min - b.start_min)
					.map((e) => {
						const legs = arrivals.get(e.id) ?? [];
						/* Two routes at most. A day that splits can have a journey per
						   group, and six of them turn the card into a timetable: the
						   board already holds the full list, and this is a glance. */
						const shown = legs.slice(0, 2).map((l) => {
							const from = eventById.get(l.fromEventId)?.title;
							const mode = modeLabel(l.resolvedMode);
							const lead = from ? `${mode} from ${from}` : mode;
							return `${lead} · ${l.resolvedMins}m`;
						});
						if (legs.length > shown.length) {
							shown.push(`+${legs.length - shown.length} more routes here`);
						}
						return {
							title: e.title,
							lat: e.lat,
							lng: e.lng,
							subtitle: `${typeLabel(e.type)} · ${clockRange(e.start_min, e.end_min)}`,
							detail: [peopleLabel(e.people), ...shown],
							warn: legs.some((l) => l.tight) ? copy.viewAs.travelWarning : undefined
						};
					}),
				numbered: ordered,
				line: ordered
			});
		}
		return tracks;
	}, [anchor, data, readAs, eventById, peopleLabel]);

	const mapPanel = useMemo(
		() => (
			<aside className="mapwrap card">
				{data?.mapsKey && !mapsOut ? (
					<GoogleMap
						tracks={mapTracks}
						apiKey={data.mapsKey}
						center={anchorCity}
						onUnavailable={() => setMapsOut(true)}
					/>
				) : (
					<TripMap tracks={mapTracks} center={anchorCity} />
				)}
			</aside>
		),
		// `mapsOut` belongs here and is easy to lose: the panel is held by identity
		// so a drag does not re-render it, which is the whole point of the memo,
		// and the refusal that raises the flag lands seconds after first paint.
		// Without the dep the swap to Leaflet waits for the next change to
		// `mapTracks`, which most board edits produce, so the bug would not be a
		// map that never falls back but one that falls back only sometimes.
		[data?.mapsKey, mapsOut, mapTracks, anchorCity]
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

	const onPointerDown = useCallback(
		(e: React.PointerEvent, ev: EventRow, day: string) => {
			// Let the resize grip through.
			if ((e.target as HTMLElement).closest('.bresize')) return;
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
			didDrag.current = false;
			putDrag({
				id: ev.id,
				day,
				pointerStartY: e.clientY,
				pointerY: e.clientY,
				origStart: ev.start_min,
				mins: ev.end_min - ev.start_min,
				creep: 0,
				liveStart: ev.start_min
			});
		},
		[putDrag]
	);

	const onPointerMove = useCallback(
		(e: React.PointerEvent) => {
			const d = dragRef.current;
			if (!d) return;
			const y = e.clientY;
			if (Math.abs(y - d.pointerStartY) > 3) didDrag.current = true;
			// The ref is the truth and is right immediately; the frame draws it.
			dragRef.current = { ...d, pointerY: y, liveStart: liveStartFor(d, d.creep, y) };
			touch();
		},
		[touch]
	);

	/**
	 * Keep travelling while the pointer is held against an edge of the viewport.
	 *
	 * Dragging on its own reaches whatever the pointer has room to travel to,
	 * which inside a box a few hundred pixels tall is a few hours either way. The
	 * day is nineteen, so both edges carry on: pushing against the top runs the
	 * hours back towards midnight before, opening the window past six when there
	 * is nothing left to scroll to, and pushing against the bottom runs them on
	 * towards midnight after. The rate is set by how far past the edge the hand
	 * is, barely moving at the threshold and a couple of hours a second at the
	 * very edge, which is slow enough to stop on a minute and quick enough to
	 * cross a night.
	 */
	useEffect(() => {
		if (!drag) return;
		let raf = 0;
		let last = performance.now();
		const tick = (now: number) => {
			// Capped, so a tab returning from the background does not open the day.
			const dt = Math.min(now - last, 100) / 1000;
			last = now;
			const d = dragRef.current;
			const box = scrollRef.current?.getBoundingClientRect();
			if (d && box) {
				const pastTop = box.top + EDGE_PX - d.pointerY;
				const pastBottom = d.pointerY - (box.bottom - EDGE_PX);
				const rate = (past: number) => (Math.min(past, EDGE_PX) / EDGE_PX) * EDGE_RATE * dt;
				// Only ever one of the two: a viewport shorter than two thresholds
				// would otherwise be past both at once and travel nowhere.
				const by =
					pastTop > 0 && d.liveStart > 0
						? rate(pastTop)
						: pastBottom > 0 && d.liveStart < DAY_END - d.mins
							? -rate(pastBottom)
							: 0;
				if (by) {
					const creep = d.creep + by;
					dragRef.current = { ...d, creep, liveStart: liveStartFor(d, creep, d.pointerY) };
					dirty.current = true;
				}
			}
			// The one commit this frame gets, carrying whatever the pointer and
			// the edge have done to the block since the last one.
			if (dirty.current) {
				dirty.current = false;
				setDrag(dragRef.current);
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [drag !== null]);

	const onPointerUp = useCallback(async () => {
		const d = dragRef.current;
		if (!d) return;
		const snapped = Math.round(d.liveStart / 5) * 5;
		const { id, origStart, day } = d;
		putDrag(null);
		if (snapped === origStart) return;
		setPending({ id, start: snapped });
		// Hold the window where the gesture left it until the day comes back.
		setOpenFloor(snapped);
		// The day rides along because a move carries one, and sending the block's
		// own day keeps a drag in the 3-day view on the column it was drawn in.
		await act(() => eventOp(id, { op: 'move', startMin: snapped, day }));
	}, [act, eventOp, putDrag]);

	const onResizeDown = useCallback(
		(e: React.PointerEvent, ev: EventRow) => {
			e.stopPropagation();
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
			didDrag.current = false;
			putResize({
				id: ev.id,
				pointerStartY: e.clientY,
				startMin: ev.start_min,
				origEnd: ev.end_min,
				liveEnd: ev.end_min
			});
		},
		[putResize]
	);

	const onResizeMove = useCallback(
		(e: React.PointerEvent) => {
			const r = resizeRef.current;
			if (!r) return;
			const y = e.clientY;
			if (Math.abs(y - r.pointerStartY) > 3) didDrag.current = true;
			resizeRef.current = {
				...r,
				liveEnd: Math.max(
					r.startMin + MIN_EVENT_MINS,
					Math.round((r.origEnd + (y - r.pointerStartY) / PX_PER_MIN) / 5) * 5
				)
			};
			touch();
		},
		[touch]
	);

	const onResizeUp = useCallback(async () => {
		const r = resizeRef.current;
		if (!r) return;
		const snapped = Math.round(r.liveEnd / 5) * 5;
		const { id, origEnd } = r;
		putResize(null);
		if (snapped === origEnd) return;
		setPending({ id, end: snapped });
		await act(() => eventOp(id, { op: 'resize', endMin: snapped }));
	}, [act, eventOp, putResize]);

	/**
	 * The board's entrance when the day or the view changes under it.
	 *
	 * One rank covers both, because only one of them moves at a time. A day is
	 * worth two of a view, so that stepping to tomorrow and switching Day to
	 * Agenda both read as a step forward and neither is mistaken for the other.
	 *
	 * Only the board moves. A day step changes what the calendar is drawing and
	 * nothing else on the page, so the toolbar and the map it shares the row
	 * with stay put. Moving the whole section is reserved for a tab change,
	 * where the whole section really is what was replaced.
	 */
	const boardRef = useRef<HTMLDivElement>(null);
	useSlideIn(
		boardRef,
		data && `${data.day}:${data.view}`,
		data ? dayRank(data.day) * 2 + VIEW_OPTIONS.findIndex((o) => o.v === data.view) : 0
	);

	if (!data) return error ? <FormError message={error} variant="banner" /> : null;

	const view = data.view;

	/* The day one step either way, or null at the ends.
	 *
	 * The server decides this now, and that is the point rather than a
	 * delegation for its own sake. `data.days` is a window around the day being
	 * drawn, so walking it by index would stop at the edge of the window and
	 * call it the end of the trip. It is the whole trip on every trip that
	 * exists today, which is what makes the mistake invisible until the one trip
	 * that is longer than the window.
	 *
	 * `prevDay` and `nextDay` are also the nearer of the in-range neighbour and
	 * the nearest scheduled day, so they still jump the gap to an event left
	 * outside the trip's dates by a shortening. An index walk cannot do that at
	 * all once the window no longer holds both sides of the gap. `null` means
	 * this really is an end, which is what disables the arrow. */
	const dayStep = (delta: number): string | null => (delta < 0 ? data.prevDay : data.nextDay);

	// --- Board pieces -------------------------------------------------------

	/**
	 * The day's lodgings, drawn above the day rather than inside it.
	 *
	 * A stay is a range of nights, not an hour, so it is a band on every day it
	 * covers and clicking it opens the same dialog a block does: that is the one
	 * place its dates, its place and who is in it are edited, and editing it on
	 * any day it covers edits the whole stay. There can be several, because half
	 * a group can be in one building and half in another, which is exactly what
	 * the old vote-derived band could not say.
	 *
	 * The band runs through the morning of checkout, because that morning is
	 * still spent in the room: it is where the first journey of the day starts
	 * from, and a day that drew nothing there read as a day with nowhere to
	 * sleep.
	 */
	function stayBands(entry: BoardDay) {
		return (
			<div className="stayband">
				{entry.stays.map((s) => (
					<button
						key={s.id}
						type="button"
						className={preview?.id === s.id ? 'staychip editingnow' : 'staychip'}
						onClick={() => openBlock(s.id)}
					>
						<span className="stayname">{s.title}</span>
						<span className="staywho">
							{s.people.length === 0 || s.people.length === members.length
								? 'Everyone'
								: s.people.map((id) => shortName(id)).join(', ')}
						</span>
					</button>
				))}
				<button
					type="button"
					className="stayadd"
					onClick={() => setAdding({ day: entry.day, start: null, type: 'stay' })}
				>
					+ Add stay
				</button>
			</div>
		);
	}

	function blockNode(ev: EventRow, day: string, lanePx: number, place: Layout) {
		const p = place.placed.get(ev.id);
		if (!p) return null;

		return (
			<Block
				key={ev.id}
				ev={ev}
				day={day}
				lanePx={lanePx}
				left={p.left}
				width={p.width}
				from={startFor(ev)}
				to={endFor(ev)}
				boardStart={boardStart}
				dragging={drag?.id === ev.id}
				resizing={resize?.id === ev.id}
				editing={preview?.id === ev.id}
				memberCount={members.length}
				shortName={shortName}
				didDrag={didDrag}
				onDown={onPointerDown}
				onMove={onPointerMove}
				onUp={onPointerUp}
				onOpen={openBlock}
				onGripDown={onResizeDown}
				onGripMove={onResizeMove}
				onGripUp={onResizeUp}
			/>
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
		return (
			<Leg
				key={legKey(leg)}
				leg={leg}
				lanePx={lanePx}
				left={box.left}
				width={box.width}
				boardStart={boardStart}
				name={legName(leg, box.width * lanePx)}
				title={legTitle(leg)}
				editing={openLegId === leg.id}
				onOpen={openLeg}
			/>
		);
	}

	function legTitle(leg: LegRow): string {
		const from = eventById.get(leg.fromEventId)?.title ?? '?';
		const to = eventById.get(leg.toEventId)?.title ?? '?';
		// The warning is a sentence, so it is punctuated as one rather than hung
		// off a comma, and it is the same sentence the mark beside it carries.
		const tail = leg.tight ? `. ${copy.viewAs.travelWarning}` : leg.manual ? ', pinned' : '';
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
			<div
				className={`daygrid${drag ? ' still' : ''}${drag && openedBy > 0 ? ' opening' : ''}`}
				style={{ height: `${(DAY_END - boardStart) * PX_PER_MIN + 16}px` }}
			>
				<Axis boardStart={boardStart} />

				<div
					className="lane"
					ref={opts.measure ? laneRef : undefined}
					onDoubleClick={(e) => {
						// A double click on empty track is "put something here". On a
						// block it is not: blocks have their own dialogs, and opening a
						// second one over the top would be a trap.
						if ((e.target as HTMLElement).closest('.block')) return;
						const rect = e.currentTarget.getBoundingClientRect();
						const mins = boardStart + (e.clientY - rect.top) / PX_PER_MIN;
						const snapped = Math.round(mins / 15) * 15;
						setAdding({
							day: entry.day,
							start: Math.min(Math.max(snapped, boardStart), DAY_END - 15)
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

	// --- Agenda -------------------------------------------------------------
	//
	// One person's day, end to end: what they are doing and how they get there.
	// It replaced a swimlane board of everybody at once, which answered a
	// question nobody asks: a trip of twenty drew twenty near-identical rows of
	// unreadable slivers, and "what does my day look like" was the hardest thing
	// to pick out of it. The day board already shows the group; this shows a
	// person, which is why "view as" drops "Everyone" here. The board arrives
	// filtered to them, so this is simply what is left, in order.

	/**
	 * The same journey, named for a list rather than for a bar.
	 *
	 * A row has no event drawn under it to say where the journey lands, so when
	 * the origin is off the board, which is the walk out of the night's stay,
	 * it names the destination rather than standing there as a bare "Walk".
	 */
	function agendaLegName(leg: LegRow): string {
		const named = legName(leg, Number.POSITIVE_INFINITY);
		if (named !== modeLabel(leg.resolvedMode)) return named;
		const to = eventById.get(leg.toEventId)?.title;
		return to ? `${named} to ${to}` : named;
	}

	const agenda = [
		...(anchor?.events ?? []).map((ev) => ({
			key: ev.id,
			start: ev.start_min,
			title: ev.title,
			meta: `${typeLabel(ev.type)} · ${clockRange(ev.start_min, ev.end_min)}`,
			tight: false,
			open: () => openBlock(ev.id)
		})),
		...(anchor?.legs ?? []).map((leg) => ({
			key: legKey(leg),
			start: leg.startMin,
			title: agendaLegName(leg),
			meta: `${modeLabel(leg.resolvedMode)} · ${leg.resolvedMins}m`,
			tight: leg.tight,
			open: () => openLeg(leg)
		}))
	].sort((a, b) => a.start - b.start);

	function agendaBoard() {
		if (!agenda.length) return <EmptyState graphic message={copy.common.nothingAdded} />;
		return (
			<div className="agenda">
				<ul>
					{agenda.map((row) => (
						<li key={row.key}>
							<button
								type="button"
								className={row.tight ? 'agendarow tight' : 'agendarow'}
								onClick={row.open}
							>
								<span className="agendawhen">{clock(row.start)}</span>
								<span className="agendawhat">{row.title}</span>
								<span className="agendameta">
									{row.meta}
									{row.tight && <WarnMark label={copy.viewAs.travelWarning} />}
								</span>
							</button>
						</li>
					))}
				</ul>
			</div>
		);
	}

	return (
		<div className="sched" ref={rootRef}>
			<Toolbar
				view={view}
				day={data.day}
				memberCount={members.length}
				readAs={readAs}
				viewAsOptions={viewAsOptions}
				onViewAs={setViewAs}
				onAdd={addHere}
			/>

			<div className="split">
				<div className="boardcol">
					<div className="board card" ref={boardRef}>
						<BoardHead
							label={dayLabel(data.day)}
							view={view}
							day={data.day}
							first={data.firstDay}
							last={data.lastDay}
							prev={dayStep(-1)}
							next={dayStep(1)}
						/>
						{anchor && stayBands(anchor)}
						{anchor ? (
							/* The board's viewport, whichever board is in it. The stepper and
							   the lodging band are outside it on purpose: they name the day,
							   so they stay while the day scrolls. The agenda used to be left
							   out of it, on the reasoning that a list that short did not need
							   a box; a full day of a busy trip is forty rows, and the agenda
							   then scrolled the title and the stepper off the top exactly as
							   the hours used to. It is the same box because it is the same
							   complaint, and `max-height` costs a short day nothing: no
							   overflow, no scrollbar. */
							<div
								className={view === 'agenda' ? 'boardscroll list' : 'boardscroll'}
								ref={scrollRef}
								style={viewH ? { maxHeight: `${viewH}px` } : undefined}
							>
								{view === 'agenda'
									? agendaBoard()
									: dayBoard(anchor, { lanePx: laneW || 560, measure: true })}
							</div>
						) : null}
					</div>
				</div>

				{mapPanel}
			</div>

			{adding && (
				<AddEventDialog
					base={base}
					day={adding.day}
					startMin={adding.start}
					initialType={adding.type}
					legs={draftLegs}
					eventOf={(id) => eventById.get(id) ?? null}
					peopleLabel={peopleLabel}
					memberOptions={memberOptions}
					crews={data.crews}
					saved={data.saved}
					stays={data.stays}
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
					stays={data.stays}
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
