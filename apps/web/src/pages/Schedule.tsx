import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useLiveSection } from '../hooks/useTripEvents';
import useMediaQuery from '../hooks/useMediaQuery';
import useSlideIn from '../hooks/useSlideIn';
import { useTrip } from './TripShell';
import LoadError from '../components/ui/LoadError';
import Loading from '../components/ui/Loading';
import EmptyState from '../components/ui/EmptyState';
import Select from '../components/ui/Select';
import { LockIcon, PencilIcon, WarningIcon } from '../components/ui/icons';
import { useToast } from '../components/ui/Toast';
import GoogleMap, { type MapTrack, type MapCenter } from '../components/GoogleMap';
import TripMap from '../components/TripMap';

import { type Layout } from '@trippy/core/layout';
import { layoutBoard, legLaneId } from '@trippy/core/travel';
import { suggestStart } from '@trippy/core/plan';
import { onOneClock, segmentOn, type Segment } from '@trippy/core/span';
import type { EventType } from '@trippy/core/types';
import { copy } from '../copy';
import EventDialog from './schedule/EventDialog';
import { applyDraft, replanLegs } from './schedule/replan';
import {
	arrivalZone,
	endClock,
	segmentFor,
	segmentTime,
	spanRange,
	zoneLookup
} from './schedule/span-text';
import {
	DAY_END,
	DEFAULT_START,
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
	LegDrafts,
	LegRow,
	Member,
	ScheduleData,
	ViewMode
} from './schedule/types';
import '../styles/schedule.css';

/** No journey card has said anything. One object, so "nothing" compares by identity. */
const NO_LEG_DRAFTS: LegDrafts = Object.freeze({});

const cs = copy.schedule;

const VIEW_OPTIONS: { v: ViewMode; label: string }[] = [
	{ v: 'day', label: cs.views.day },
	{ v: 'agenda', label: cs.views.agenda }
];

/**
 * The board's per-type colours as hex, for the one surface CSS cannot reach:
 * the map pins built in `mapTracks`. These are the same five values that
 * `.sched .block.<type>` sets as `--c` in schedule.css, kept in step by hand so
 * the map and the calendar read as a single colour scheme. DESIGN.md records
 * why the copy has to exist rather than being imported from one place.
 */
const EVENT_COLORS: Record<EventType, string> = {
	activity: '#2f7a4f',
	food: '#c15a25',
	stay: '#7b4fa6',
	travel: '#2f6d9e',
	freetime: '#6b5bd2'
};

/**
 * A place the trip saved and has not scheduled.
 *
 * The one colour on the map that is not a type, because being unplanned is not
 * a kind of thing: it is the absence of one. Everything on the day wears its
 * block's colour, so a glance at the map answers both questions at once, what
 * is in the plan and what each planned thing is.
 */
const UNPLANNED = '#9aa39c';

/** The lane holds both kinds of block, and they are laid out together. */
type LaneItem =
	{ kind: 'event'; ev: EventRow } | { kind: 'leg'; leg: LegRow; left: number; width: number };

/* A leg's React key and lane id, namespaced so a leg cannot collide with an
   event. Not core's `legKey`, which is the journey's identity (`from>to`) and
   is what stored rows and edits are matched on; this one only has to be unique
   on the board. */
const laneKey = legLaneId;

/**
 * The shortest a journey is ever drawn, in pixels.
 *
 * A hop of a few minutes is thinner than a pointer can hit, so its box is
 * floored to this and the floor grows upwards, into the waiting time before it.
 * Where there is no waiting time, because the two events are exactly adjacent,
 * the block it left gives up these pixels instead: see `dayBoard`.
 */
const MIN_LEG_H = 15;

/**
 * The grid's room under midnight, for the last hour label to hang into.
 *
 * A block that carries on into tomorrow runs through it to the bottom of the
 * column rather than stopping on the midnight line, so it leaves the day
 * rather than ending at it.
 */
const GRID_TAIL_PX = 16;

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
	/** Where the pointer went down across the strip, so a sideways drag counts as a drag. */
	pointerStartX: number;
	/** Where the pointer is now, so the edge loop can run without one moving. */
	pointerY: number;
	/** Where the pointer is across the strip, for the same reason sideways. */
	pointerX: number;
	origStart: number;
	/** How long the block is, so a drag cannot push it off the end of the day. */
	mins: number;
	/** Minutes the viewport has been travelled past where the pointer reaches. */
	creep: number;
	liveStart: number;
	/** Where the strip stood when the block was picked up. */
	scrollLeft0: number;
	/**
	 * How far the strip has travelled since, which the block is offset by.
	 *
	 * A block is drawn inside its own day's panel, so it travels with that panel
	 * and would slide out from under a hand that has not moved. Offsetting it by
	 * exactly what the strip has done leaves it where the pointer put it while
	 * the days pass behind it, which is the whole picture of carrying something
	 * to another date.
	 */
	dx: number;
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
/**
 * Days a second the strip travels at when the pointer is held against a side.
 *
 * Expressed in days rather than pixels so it reads the same on a phone and on a
 * wide screen: what the hand is asking for is the next date, not a distance. A
 * little over one a second is fast enough not to feel stuck and slow enough to
 * stop on the day you meant.
 */
const EDGE_DAY_RATE = 1.1;
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
 * How long the strip has to be still before the day it is on becomes the url.
 *
 * Long enough to sit out the tail of a flick, which decelerates for a good part
 * of a second and crosses days while it does; short enough that letting go on a
 * day and reaching for the map does not find the address bar still behind. A
 * settle is only an address: the board has already been showing the day since
 * the scroll passed its middle, so nothing the reader can see waits on this.
 */
const SETTLE_MS = 140;

/**
 * How long an arrow takes to carry the strip to the next day.
 *
 * Scripted rather than the browser's own smooth scroll, which could not be told
 * where it was going once it had started: the payload for the new day landed
 * part-way through, the strip re-indexed under it, and the re-seat that keeps
 * the day still had to cancel the glide to do its job. What the reader saw was
 * thirty pixels of motion and then a jump. A tween owns its numbers, so the
 * re-seat moves both ends of it by the re-index and lets it finish.
 *
 * About a third of a second, eased out: long enough to read as travel, short
 * enough that a second click is not kept waiting.
 */
const GLIDE_MS = 320;

/**
 * A finger on the strip, which is driven by script rather than by the
 * browser's own sideways pan (`touch-action: pan-y` on `.boardscroll`).
 *
 * Native panning took every sideways wobble of a scroll down the hours as a
 * request for another day, and its momentum carried a short flick across one
 * or several. So a touch is read first: until it has moved `AXIS_LOCK_PX` it
 * is nothing, and then it is sideways only if it is clearly so
 * (`AXIS_RATIO` times more across than down); anything else is the browser's
 * vertical scroll for its whole length. A sideways one drags the strip under
 * the finger, at most one day either way, and on release goes to the
 * neighbour only past `SWIPE_SHARE` of a day or on a flick faster than
 * `FLICK_PX_PER_MS` that has travelled `FLICK_MIN_PX`; otherwise it springs
 * back. Either way it is the arrow's tween that finishes the move. The
 * velocity is read over the last `FLICK_WINDOW_MS`, so a finger that stopped
 * before it lifted has not flicked.
 */
const AXIS_LOCK_PX = 10;
const AXIS_RATIO = 1.5;
const SWIPE_SHARE = 0.3;
const FLICK_PX_PER_MS = 0.5;
const FLICK_MIN_PX = 24;
const FLICK_WINDOW_MS = 100;

/** The agenda's day step: a short slide in the direction of travel, with a fade. */
const AGENDA_SLIDE = { px: 28, ms: 200, fade: true } as const;

/**
 * How far a pointer may wander, in pixels, and still have been a click.
 *
 * A click that moved nothing must write nothing. Every drop snaps to five
 * minutes, so a block at 9:07 that was merely pressed used to be posted back as
 * 9:05: a plain click, the one gesture that is documented as only aiming the
 * map, silently moved it. Below this the gesture is a click, whatever the snap
 * would have said.
 */
const DRAG_SLOP_PX = 3;

/**
 * How long a finger has to rest on a block before it picks it up.
 *
 * With a mouse a press is unambiguous, so a drag starts at once. A finger
 * crossing the board is almost always scrolling it, and a block that started
 * moving on touch made a phone's board impossible to scroll without
 * rescheduling whatever the swipe began on. So on touch the board pans as any
 * page does, and a block is lifted only by a press held still for this long:
 * about the platform's own long-press, short enough not to feel like waiting.
 */
const LONG_PRESS_MS = 400;
/** How far a resting finger may drift before the press counts as a scroll instead. */
const HOLD_SLOP_PX = 8;

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
	/** How far the strip has travelled under a block being carried, in pixels. */
	dx: number;
	resizing: boolean;
	editing: boolean;
	memberCount: number;
	shortName: (id: string) => string;
	didDrag: React.RefObject<boolean>;
	onDown: (e: React.PointerEvent, ev: EventRow, day: string) => void;
	onMove: (e: React.PointerEvent) => void;
	onUp: () => void;
	/** The gesture was taken away (a system pan, a lost capture): end it, write nothing. */
	onCancel: () => void;
	onOpen: (id: string) => void;
	/** Aim the map at this block. This is what a plain click does now; opening
	    the editor is the pencil alone. */
	onFocus: (id: string) => void;
	onGripDown: (e: React.PointerEvent, ev: EventRow) => void;
	onGripMove: (e: React.PointerEvent) => void;
	onGripUp: () => void;
	/** A journey arrives on top of this block, so its top-left corner squares off
	    to let the two left borders run as one line. */
	hasLegAbove: boolean;
	/** Pixels of drawn height this block gives up at the bottom so a floored
	    journey leaving it stays visible. See `dayBoard`. */
	trim: number;
	/** A frozen board draws no grip and no pencil: nothing here can be changed. */
	locked: boolean;
	/**
	 * The block carries on past this day's edges: `top` from yesterday, `bottom`
	 * into tomorrow. The cut edge squares off, the way a phone calendar draws
	 * it, which is all it takes to read as "continues".
	 */
	cutTop: boolean;
	cutBottom: boolean;
	/** "From 10:00 PM", "Until 3:00 PM", "All day", or null for a one-day block. */
	spanLabel: string | null;
	/** The time in full: the range, with the arrival zone on a journey that changes clocks. */
	fullTime: string;
	/** The same, as the block's name is read out. */
	ariaTime: string;
	/**
	 * Not picked up off the board and given no grip. A span runs across days a
	 * single column cannot show, and a journey whose ends are on two clocks
	 * is drawn on one of them, so neither can be moved or stretched by its
	 * drawing. Both open their dialog on a click instead, the way a stay
	 * does; see DESIGN.md.
	 */
	fixed: boolean;
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
	dx,
	resizing,
	editing,
	memberCount,
	shortName,
	didDrag,
	onDown,
	onMove,
	onUp,
	onCancel,
	onOpen,
	onFocus,
	onGripDown,
	onGripMove,
	onGripUp,
	hasLegAbove,
	trim,
	locked,
	cutTop,
	cutBottom,
	spanLabel,
	fullTime,
	ariaTime,
	fixed
}: BlockProps) {
	// The height the block is drawn at, which is what its text has to fit in:
	// the clock's, less what it gives up to a journey leaving it, floored.
	const drawnH = Math.max(heightPx(from, to, boardStart) - trim, MIN_LEG_H);
	const narrow = width < 0.34;
	const bud = whoBudget(width, drawnH, ev.title, lanePx, { narrow });
	const cls = [
		'block',
		ev.type,
		dragging ? 'dragging' : '',
		resizing ? 'resizing' : '',
		editing ? 'editingnow' : '',
		hasLegAbove ? 'joined' : '',
		narrow ? 'narrow' : '',
		// Too short to stack: one line, padded only at the sides. See `whoBudget`.
		bud.rows !== 'stack' ? 'oneline' : '',
		cutTop ? 'cuttop' : '',
		cutBottom ? 'cutbottom' : '',
		fixed ? 'fixed' : ''
	]
		.filter(Boolean)
		.join(' ');

	/* The block is a box that holds two controls side by side: its face, which
	   is the button that selects or opens it, and the pencil. The face used to be
	   the box itself, with the pencil nested inside it, which is a button inside
	   a button: invalid, announced as one control with two names, and a click on
	   the pencil that the block underneath also had to be told to ignore. So the
	   box carries the geometry and the gesture, and the face fills it. */
	const open = () => {
		// Frozen, the block is the only way into its own details: there is no
		// pencil to reach them through and nothing on the block to drag. A span
		// cannot be dragged either, so its click opens it too, and still aims
		// the map on the way, which is what a click on a block has always done.
		if (locked) onOpen(ev.id);
		else if (fixed) {
			onFocus(ev.id);
			onOpen(ev.id);
		} else onFocus(ev.id);
	};

	return (
		<div
			className={cls}
			style={{
				left: `${left * 100}%`,
				width: `calc(${width * 100}% - 6px)`,
				top: `${topPx(from, boardStart)}px`,
				height: `${drawnH + (cutBottom ? GRID_TAIL_PX : 0)}px`,
				...(dx ? { transform: `translateX(${dx}px)` } : null),
				['--trows' as string]: bud.trows,
				['--wrows' as string]: bud.wrows
			}}
			onPointerDown={(e) => onDown(e, ev, day)}
			onPointerMove={onMove}
			onPointerUp={onUp}
			// On the box, not the face, because the box is what holds the pointer
			// capture during a press: the click that follows is dispatched to the
			// captured element, so a handler on the face never heard a mouse click.
			// A click that bubbles up from the pencil or the grip is theirs.
			onClick={(e) => {
				const from = e.target as HTMLElement;
				if (from.closest('.bresize') || from.closest('.bedit')) return;
				if (didDrag.current) return;
				open();
			}}
			onPointerCancel={onCancel}
			onLostPointerCapture={(e) => {
				// The face losing a capture is the touch handover in `pressThen`: a
				// touch is captured to what it landed on, and the long press moves
				// that capture up onto the block. Only the box's own loss (or the
				// grip's) is the gesture being taken away.
				if (!(e.target as HTMLElement).closest('.bface')) onCancel();
			}}
			onContextMenu={(e) => {
				// A long press on a phone is how a block is picked up, and the same
				// press is what raises the platform's context menu. The menu has
				// nothing to offer a block, so it gives way to the gesture.
				if (e.nativeEvent instanceof PointerEvent && e.nativeEvent.pointerType === 'touch') {
					e.preventDefault();
				}
			}}
		>
			<div
				className="bface"
				role="button"
				tabIndex={0}
				aria-label={`${ev.title}, ${ariaTime}. ${
					locked || fixed ? cs.block.openLabel : cs.block.moveLabel
				}`}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						open();
					}
				}}
			>
				<div className="bt">{ev.title}</div>
				{/* On one line the time follows the title, short, and only where
				    there is a line to share; stacked it is its own row, and a row
				    with nothing to say is not drawn, so it costs the people none. */}
				{bud.rows === 'line' && bud.showTime && (
					<div className="bmeta">
						<span>{spanLabel ?? clock(from)}</span>
					</div>
				)}
				{bud.rows === 'stack' && bud.showTime && (
					<div className="bmeta">
						<span>{spanLabel ?? (bud.compact ? clock(from) : fullTime)}</span>
					</div>
				)}
				{bud.wrows > 0 && (
					<div className="bwho">
						{ev.people.length === 0 || ev.people.length === memberCount ? (
							<span className="who all">{copy.common.everyone}</span>
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
				)}
			</div>
			{!locked && (
				<>
					{!fixed && (
						<div
							className="bresize"
							role="separator"
							aria-label={cs.block.resizeLabel}
							onPointerDown={(e) => onGripDown(e, ev)}
							onPointerMove={onGripMove}
							onPointerUp={onGripUp}
						/>
					)}
					<button
						type="button"
						className="bedit"
						aria-label={copy.common.editLabel(ev.title)}
						// Swallow the pointer so pressing the pencil opens the editor rather
						// than beginning a drag on the block behind it.
						onPointerDown={(e) => e.stopPropagation()}
						onClick={() => onOpen(ev.id)}
					>
						<PencilIcon />
					</button>
				</>
			)}
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
	/** The type of the event this journey arrives at, or null when that event is
	    not on the board. It gives the leg its colour, so the leg and its event
	    read as one. */
	arrivalType: EventType | null;
	/** Aim the map at the event this journey feeds. A leg has no editor of its
	    own; the journey is edited through its arrival event's pencil, and a
	    click on the leg just focuses the map like any other block. */
	onFocus: (id: string) => void;
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
	arrivalType,
	onFocus
}: LegProps) {
	const wpx = width * lanePx;
	// A short hop cannot carry two lines of type, so it is drawn as a rule
	// across the gap with its duration on it, floored to a height a pointer
	// can hit. The floor grows upwards, into the waiting time before the
	// journey, because downwards is the block it arrives at. Whether it can is
	// the same budget a block's text is held to: a name over a meta row, at
	// as many name lines as the height leaves after the meta row.
	const trueH = heightPx(leg.startMin, leg.endMin, boardStart);
	const h = Math.max(trueH, MIN_LEG_H);
	const bud = whoBudget(width, trueH, name, lanePx, { narrow: width < 0.34, meta: true });
	const thin = bud.rows !== 'stack';
	const cls = [
		'block',
		// The journey wears the colour of the event it feeds rather than a colour
		// of its own, so the pair reads as one. It falls back to `travel` when its
		// arrival is not on the board and there is nothing to match.
		arrivalType ?? 'travel',
		'leg',
		arrivalType ? 'joined' : '',
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
			aria-label={`${name}, ${clock(leg.startMin)} to ${clock(leg.endMin)}. ${cs.block.showOnMap}`}
			title={title}
			style={{
				left: `${left * 100}%`,
				width: `calc(${width * 100}% - 6px)`,
				top: `${topPx(leg.endMin, boardStart) - h}px`,
				height: `${h}px`,
				['--trows' as string]: bud.trows,
				['--wrows' as string]: bud.wrows
			}}
			onClick={() => onFocus(leg.toEventId)}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onFocus(leg.toEventId);
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
					{/* When to leave. The arrival is the start the block below already
					    prints, so it is only spelled out where that block is not on
					    the board. */}
					{bud.showTime && (
						<span>{arrivalType ? clock(leg.startMin) : clockRange(leg.startMin, leg.endMin)}</span>
					)}
					<span>{cs.journey.estimate(leg.resolvedMins)}</span>
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
 *
 * Drawn twice over, in two parts. Each day panel draws its rules, bare, across
 * the day's own width; the one time column beside the strip draws the labels
 * and the gutter's stretch of each rule. See `.timecol` in `schedule.css`.
 */
const Axis = memo(function Axis({
	boardStart,
	labels
}: {
	boardStart: number;
	/** The hour names, which only the fixed time column carries. */
	labels: boolean;
}) {
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
					{labels && <span>{hourLabel(h)}</span>}
				</div>
			))}
		</div>
	);
});

/**
 * How far apart the strip's days are, in pixels: the width of one day panel.
 *
 * Not the box's width. The time column stands at the left of the box and the
 * panels are the rest of it, so a day is the box less the gutter, and every
 * seat, slide and "which day is this offset on" is a multiple of that. Read
 * off a panel rather than worked out from the gutter, so the stylesheet owns
 * the number and a width change is never a stale constant.
 */
function stride(el: HTMLElement): number {
	const panel = el.querySelector<HTMLElement>('.daypanel');
	return panel ? panel.getBoundingClientRect().width : el.clientWidth;
}

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
	locked: boolean;
};

const Toolbar = memo(function Toolbar({
	view,
	day,
	memberCount,
	readAs,
	viewAsOptions,
	onViewAs,
	onAdd,
	locked
}: ToolbarProps) {
	return (
		<div className="toolbar">
			<div className="pills" role="group" aria-label={cs.viewAriaLabel}>
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
							ariaLabel={cs.viewAsAriaLabel}
						/>
					</div>
				)}
				{locked ? (
					<span className="lockmark" title={cs.lock.hint}>
						<LockIcon />
						{cs.lock.tag}
					</span>
				) : (
					<button className="btn primary" type="button" onClick={onAdd}>
						{cs.add}
					</button>
				)}
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
	next,
	onStep
}: {
	label: string;
	view: string;
	day: string;
	first: string;
	last: string;
	prev: string | null;
	next: string | null;
	/** Slide the strip to a neighbour, so an arrow makes the move a hand would. */
	onStep?: (day: string) => void;
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
				<Link
					className="navbtn"
					to={navUrl(prev, view)}
					aria-label={cs.nav.previousDay}
					onClick={() => onStep?.(prev)}
				>
					‹
				</Link>
			) : (
				<button className="navbtn" type="button" disabled aria-label={cs.nav.previousDay}>
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
							aria-label={cs.nav.jumpToDate}
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
				<Link
					className="navbtn"
					to={navUrl(next, view)}
					aria-label={cs.nav.nextDay}
					onClick={() => onStep?.(next)}
				>
					›
				</Link>
			) : (
				<button className="navbtn" type="button" disabled aria-label={cs.nav.nextDay}>
					›
				</button>
			)}
		</div>
	);
});

export default function Schedule() {
	const { trip } = useTrip();
	const base = `/trips/${trip.id}/schedule`;
	/**
	 * The board is frozen. Checked in front of every write the page starts, and
	 * again by the API, which is the boundary that matters: hiding a button is
	 * how a locked board reads, not how it holds.
	 */
	const locked = trip.schedule_locked === 1;

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
		/** A saved place the dialog opens with already picked. */
		poi?: { id: string; name: string };
	} | null>(null);
	const [opened, setOpened] = useState<EventRow | null>(null);
	const openEventId = opened?.id ?? '';
	const [openLegId, setOpenLegId] = useState('');
	/** The block whose location the map is aimed at. Clicking a block selects it
	    and pans the map here; it no longer opens the editor, which is now the
	    pencil's job alone. Kept apart from `openEventId` so the two acts, looking
	    and editing, do not drive each other. */
	const [focusId, setFocusId] = useState('');
	/** The open edit dialog's unsaved draft, drawn on the board as it is typed. */
	const [preview, setPreview] = useState<EventDraft | null>(null);
	/** What the open dialog's journey cards say, by leg key, drawn the same way. */
	const [legDrafts, setLegDrafts] = useState<LegDrafts>(NO_LEG_DRAFTS);
	/* Kept by identity when nothing changed, so a dialog re-reporting the same
	   cards after an unrelated edit does not replan the board a second time. */
	const previewLegs = useCallback((said: LegDrafts | null) => {
		const next = said && Object.keys(said).length ? said : NO_LEG_DRAFTS;
		setLegDrafts((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
	}, []);

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

	/**
	 * The day the strip is showing, which is not always the day in the url.
	 *
	 * The board is a strip of full-width days that scrolls sideways and settles
	 * on one. The url follows a settle, and while a gesture is still in flight it
	 * is behind, so the stepper and the lodging band read this instead: they name
	 * the day under the reader's eyes, and a band still naming the day they have
	 * scrolled away from is worse than no band at all. Null until the reader has
	 * moved, which is to say the url is the answer until a hand says otherwise.
	 */
	const [shownDay, setShownDay] = useState<string | null>(null);
	/** True while the strip is being positioned by code rather than by a hand. */
	const placing = useRef(false);
	/** The day the last settle committed, so it is not committed twice. */
	const committed = useRef<string | null>(null);
	/** True while a finger is dragging the strip sideways. See `AXIS_LOCK_PX`. */
	const swiping = useRef(false);
	/**
	 * Where that finger has the strip: a day by name, and how far off its seat.
	 * By name so a payload that re-indexes the strip mid-swipe can put the same
	 * place back under the finger; see the re-seat.
	 */
	const swipeAt = useRef<{ day: string; off: number } | null>(null);
	/**
	 * The days the strip's panels hold, in order, as of the last commit.
	 *
	 * Written by the re-seat in the same layout pass that re-indexes the panels,
	 * so it always describes what is in the DOM. The scroll listener reads it
	 * rather than the `board` its closure was made with: that closure is only
	 * replaced by a passive effect, after paint, and a scroll event fired in
	 * between read the new offset against the old three days.
	 */
	const seatDays = useRef<string[]>([]);
	/** The payload the last re-seat saw, so it can tell a new one from a re-render. */
	const seatData = useRef<ScheduleData | null>(null);
	/**
	 * An arrow's slide to a neighbour, while it runs. See `GLIDE_MS`.
	 *
	 * `at` is the offset the tween last wrote, which is the position the reader
	 * is looking at: the box's own `scrollLeft` can already have been clamped by
	 * a re-index that took a panel away, so it is not the thing to rebase.
	 */
	const glide = useRef<{
		day: string;
		from: number;
		to: number;
		at: number;
		t0: number;
		raf: number;
	} | null>(null);
	const stillness = useMediaQuery('(prefers-reduced-motion: reduce)');
	/** Stop a slide where it is and hand the strip back to its snap. */
	const endGlide = useCallback(() => {
		const g = glide.current;
		if (!g) return;
		cancelAnimationFrame(g.raf);
		glide.current = null;
		scrollRef.current?.style.removeProperty('scroll-snap-type');
	}, []);
	useEffect(() => endGlide, [endGlide]);
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
	/** Set around the reload that follows the reader's own write. See `lastOrigin`. */
	const ownWrite = useRef(false);
	/** Reload after a write of this reader's, so the window it opens is theirs. */
	const reloadMine = useCallback(() => {
		ownWrite.current = true;
		reload();
	}, [reload]);
	const act = useCallback(
		async (fn: () => Promise<unknown>) => {
			try {
				await fn();
				reloadMine();
			} catch (err) {
				setPending(null);
				toast.error(err instanceof ApiError ? err.message : copy.api.saveFallback);
			}
		},
		[reloadMine, toast]
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

	/** A city id to its IANA zone, which is what a span's two ends are read in. */
	const zoneOf = useMemo(() => zoneLookup(data?.cities ?? []), [data?.cities]);

	/**
	 * Where a block sits on one day: `segmentOn`, never its raw minutes. A span
	 * runs from its start to midnight on its first day, the whole of the days
	 * between, and from midnight to its end on its last.
	 */
	const segOf = useCallback(
		(ev: EventRow, day: string): Segment => segmentFor(ev, day, zoneOf),
		[zoneOf]
	);

	/**
	 * The minute a block holds open the top of its day's window.
	 *
	 * Its start where it starts. A span carried in from yesterday begins at
	 * midnight, and opening every day it continues into back to midnight would
	 * spend a third of the column on the hours it is merely passing through, so
	 * it holds the window open only far enough to show an hour of it ending:
	 * an overnight train arriving at 5:00 opens the board to 4:00, and one
	 * arriving at noon leaves the board at six and runs off its top edge, which
	 * its squared corners already say.
	 */
	const holdsOpen = useCallback(
		(ev: EventRow, day: string) => {
			const seg = segOf(ev, day);
			return seg.startsHere ? seg.start : Math.min(DEFAULT_START, Math.max(0, seg.end - 60));
		},
		[segOf]
	);

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
	 *
	 * The journey cards in the dialog are part of the same edit, so what they say
	 * is laid over the replan too (`legDrafts`). The dialog itself reads the plan
	 * without them (`unedited`) as its cards' baseline: a card compared with a
	 * row that already holds its own edit would read as untouched and not save.
	 */
	const planBoard = useCallback(
		(said: LegDrafts): BoardDay[] => {
			// Every stored journey in the window, so a block sent to a neighbouring
			// day keeps a pin that the server is about to carry across with it.
			const known = new Map(
				(data?.board ?? []).flatMap((entry) => entry.legs.map((l) => [l.key, l] as const))
			);
			// The city a draft starts in, which is the clock its start is read on on
			// every day it reaches.
			const cityOf = (day: string) =>
				(data?.board ?? []).find((b) => b.day === day)?.city?.id ?? null;
			return (data?.board ?? []).map((entry) => {
				const { events, stays } = applyDraft(entry, preview, cityOf);
				return {
					...entry,
					events,
					stays,
					legs: preview
						? replanLegs(entry, preview, memberIds, known, cityOf, zoneOf, said)
						: entry.legs
				};
			});
		},
		[data, preview, memberIds, zoneOf]
	);
	const unedited: BoardDay[] = useMemo(() => planBoard(NO_LEG_DRAFTS), [planBoard]);
	const planned: BoardDay[] = useMemo(
		() => (preview && legDrafts !== NO_LEG_DRAFTS ? planBoard(legDrafts) : unedited),
		[planBoard, unedited, preview, legDrafts]
	);

	/* The same board, through "view as". An event with nobody on it belongs to
	   the whole group and is always shown; otherwise the chosen person has to be
	   on it. Travel legs are not: a leg belongs to the people making that
	   journey, and a leg they are not on is not part of their day. */
	const showEvent = useCallback(
		(e: EventRow) => e.people.length === 0 || e.people.some((p) => selected.has(p)),
		[selected]
	);
	const showLeg = useCallback((l: LegRow) => l.people.some((p) => selected.has(p)), [selected]);
	const board: BoardDay[] = useMemo(
		() =>
			planned.map((entry) => ({
				...entry,
				events: entry.events.filter(showEvent),
				stays: entry.stays.filter(showEvent),
				legs: entry.legs.filter(showLeg)
			})),
		[planned, showEvent, showLeg]
	);

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

	/* The day under the reader, which the stepper, the band and the map name. */
	const reading = useMemo(() => {
		const on = shownDay && board.some((b) => b.day === shownDay) ? shownDay : (data?.day ?? null);
		return board.find((b) => b.day === on) ?? anchor;
	}, [board, shownDay, data?.day, anchor]);

	/* The day the map draws. In the agenda it is the day being read, so an arrow
	   moves the map on the tap together with the list it switches, rather than a
	   fetch later. On the day board it stays the url's day: the day being read
	   there changes at the halfway point of every swipe, and a camera that flew
	   off mid-gesture and back when the hand let go would be a second motion
	   arguing with the first. */
	const mapped = data?.view === 'agenda' ? reading : anchor;
	const mappedCity = mapped?.city ?? null;

	const navigate = useNavigate();

	/**
	 * Put the day the url names under the reader, without motion.
	 *
	 * The strip holds three days and recycles them: settling on the right-hand
	 * one makes it the middle one of a fresh three, so every step re-indexes the
	 * panels underneath a reader who has not moved. Re-seating the scroll here is
	 * what makes that invisible, because the day they are looking at is the same
	 * day before and after: only its index changed. This is also what makes the
	 * strip cover a four hundred day trip on three panels.
	 *
	 * Layout effect, so the seat is taken in the same frame the new panels are
	 * painted in. A passive effect would paint the old offset first, which is a
	 * flash of the wrong day.
	 *
	 * An arrow's slide that is still running when its own day's payload lands is
	 * rebased rather than cancelled. Both ends of it, and the offset on screen, move by
	 * exactly the re-index (how far a day the old three and the new three share
	 * changed index), so the day under the reader stays put and the slide goes on
	 * to where it was going. Seating it instead stopped the slide dead and jumped
	 * the rest of the way, which on a fast connection was nearly all of it.
	 *
	 * The agenda has no strip, so all it takes from here is the day: the one the
	 * url names is the one it reads once that day's rows are in.
	 */
	useLayoutEffect(() => {
		const el = scrollRef.current;
		const was = seatDays.current;
		const days = board.map((b) => b.day);
		seatDays.current = days;
		const fresh = seatData.current !== data;
		seatData.current = data;
		if (!el || !data) return;
		if (data.view === 'agenda') {
			endGlide();
			setShownDay(data.day);
			committed.current = data.day;
			return;
		}
		// Not under a hand. A live reload that lands while a block is being carried
		// to the next day would otherwise throw the strip back onto the url's day,
		// out from under the block and the pointer holding it. The drop reloads,
		// and the seat is taken then. A finger dragging the strip is the same: the
		// release decides the day, and the payload it asks for seats it. But the
		// strip under the finger still has to show the same place: a re-index
		// moves every panel, so the strip is put back on the day the finger
		// holds (`swipeAt`, by name), at the same offset. Not shifted by the
		// re-index from `scrollLeft`, which the browser may already have clamped
		// to a strip that just got shorter.
		if (swiping.current) {
			const w = stride(el);
			const at = swipeAt.current;
			const i = at ? days.indexOf(at.day) : -1;
			if (w && at && i >= 0) {
				placing.current = true;
				el.scrollLeft = i * w + at.off;
				const id = requestAnimationFrame(() => {
					placing.current = false;
				});
				return () => cancelAnimationFrame(id);
			}
			return;
		}
		if (dragRef.current) return;
		const w = stride(el);
		const g = glide.current;
		const shared = days.find((d) => was.includes(d));
		// Only the payload for the day the slide is going to may carry it on. A
		// payload for any other day means the reader has gone somewhere else since
		// the click (the back button, the date picker), and its three days can
		// still hold the slide's day: carried on, the slide landed there and the
		// settle wrote it over the entry the reader had just returned to. A board
		// that changed without a new payload ("view as", a draft) is the same
		// payload, so the slide goes on.
		const ours = !fresh || data.day === g?.day;
		if (g && w && ours && days.includes(g.day) && shared !== undefined) {
			const shift = (days.indexOf(shared) - was.indexOf(shared)) * w;
			g.from += shift;
			g.at += shift;
			g.to = days.indexOf(g.day) * w;
			el.scrollLeft = g.at;
			committed.current = data.day;
			return;
		}
		endGlide();
		const i = days.indexOf(data.day);
		if (i < 0) return;
		placing.current = true;
		el.scrollLeft = i * w;
		setShownDay(data.day);
		committed.current = data.day;
		// Released on the next frame: setting scrollLeft queues a scroll event,
		// and reading it as a gesture would commit the seat we just took.
		const id = requestAnimationFrame(() => {
			placing.current = false;
		});
		return () => cancelAnimationFrame(id);
	}, [data, board, endGlide]);

	/**
	 * Keep the seat when the box changes width.
	 *
	 * The seat is a pixel offset, `index * width`, taken when the payload lands.
	 * Anything that changes the box's width afterwards without a window resize
	 * (a page scrollbar arriving once the map has drawn, a font swap reflowing
	 * the toolbar, a phone rotating) left that offset pointing part-way into
	 * the neighbour: the stepper named one day while the url's day sat clipped
	 * at the edge. Whatever the reader is looking at is put back square.
	 */
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || data?.view === 'agenda') return;
		let w = stride(el);
		const ro = new ResizeObserver(() => {
			const now = stride(el);
			if (!now || now === w || dragRef.current || swiping.current) return;
			// A slide in flight is aimed at the old width; land it before squaring.
			endGlide();
			const i = Math.round(el.scrollLeft / w);
			w = now;
			placing.current = true;
			el.scrollLeft = i * now;
			requestAnimationFrame(() => {
				placing.current = false;
			});
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [data?.view, !!data, endGlide]);

	/**
	 * Open the day board on its first block when the box would otherwise hide it.
	 *
	 * The window starts at six, which a box 70% of a desktop screen tall shows
	 * with most of the day under it. A phone gets the 320px floor, which is five
	 * hours: a day that starts at eleven opened on an empty grid with the
	 * morning's first block a sliver along the bottom edge, and nothing to say
	 * the rest was there. Only when the first thing on the day would sit in the
	 * lower half of what is on screen, so a desktop board, whose box shows the
	 * morning whole, does not move at all.
	 *
	 * Only on arriving at the day board: the page loading, or coming back to it
	 * from the agenda. Never on a day step. It used to run on every day the board
	 * arrived at, and that is the clock moving under the reader: step from a day
	 * that starts at nine to one that starts at eleven and the hours scrolled two
	 * hours up, step back and they stayed there. Across days the hour at the top
	 * of the box is the reader's, the same as the scroll inside one day is.
	 */
	const openedOn = useRef<string | null>(null);
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el || !data) return;
		if (data.view === 'agenda') {
			openedOn.current = null;
			return;
		}
		if (!viewH || openedOn.current === trip.id) return;
		openedOn.current = trip.id;
		const today = board.find((b) => b.day === data.day);
		const firsts = [
			...(today?.events.map((e) => holdsOpen(e, today.day)) ?? []),
			...(today?.legs.map((l) => l.startMin) ?? [])
		];
		if (!firsts.length) return;
		const first = BOARD_PAD_PX + topPx(Math.min(...firsts), boardStart);
		// What of the box is actually on screen: on a phone the box's floor is
		// taller than what the chrome above it leaves, so its bottom is below the
		// fold and "inside the box" is not the same as "in sight".
		const box = el.getBoundingClientRect();
		const seen = Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0);
		if (first - el.scrollTop <= seen / 2) return;
		el.scrollTop = Math.max(0, first - 30 * PX_PER_MIN);
	});

	/**
	 * Follow the strip, and commit the day it comes to rest on.
	 *
	 * Two jobs on one listener because they are the same measurement. The day
	 * being read is updated continuously, so the stepper and the band keep up
	 * with the hand; the url is written only once the strip has stopped, because
	 * a url per frame would fill the back button with every day scrolled past.
	 *
	 * `replace`, for the same reason: the strip is one continuous movement
	 * through the trip, not a series of visits, so it leaves one entry behind
	 * rather than one per day. The arrows and the date picker still push, since
	 * those are decisions rather than travel.
	 */
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || !data || data.view === 'agenda') return;
		let settle = 0;
		const onScroll = () => {
			if (placing.current) return;
			const w = stride(el);
			if (!w) return;
			const landed = seatDays.current[Math.round(el.scrollLeft / w)];
			if (!landed) return;
			setShownDay(landed);
			window.clearTimeout(settle);
			settle = window.setTimeout(() => {
				// Not while something is being carried. The strip travelling is
				// half of a cross-day drag, and rewriting the url mid-gesture would
				// refetch the window and take the panel the block is drawn in out
				// from under the hand holding it. The drop writes the url itself, and
				// so does the release of a finger dragging the strip.
				if (placing.current || dragRef.current || swiping.current || landed === committed.current)
					return;
				committed.current = landed;
				navigate(navUrl(landed, data.view), { replace: true });
			}, SETTLE_MS);
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			el.removeEventListener('scroll', onScroll);
			window.clearTimeout(settle);
		};
	}, [data, navigate]);

	/* A hand on the strip takes it back from a slide in flight: a finger or a
	   press landing on it, or a sideways wheel. A vertical wheel is reading the
	   hours, not asking for another day, so it leaves the slide alone. */
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || data?.view === 'agenda') return;
		const onWheel = (e: WheelEvent) => {
			if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) endGlide();
		};
		el.addEventListener('pointerdown', endGlide, { passive: true });
		el.addEventListener('touchstart', endGlide, { passive: true });
		el.addEventListener('wheel', onWheel, { passive: true });
		return () => {
			el.removeEventListener('pointerdown', endGlide);
			el.removeEventListener('touchstart', endGlide);
			el.removeEventListener('wheel', onWheel);
		};
	}, [data?.view, !!data, endGlide]);

	/**
	 * Slide the strip to a neighbour, which is what an arrow now does.
	 *
	 * The arrows are still links, so the board stays addressable and the back
	 * button still walks the days. This runs first, over the panels that are on
	 * screen at the time of the click: the old three are still painted while the
	 * new day is being fetched, so the strip slides to the neighbour the reader
	 * asked for, and the re-seat above rebases the slide when the payload lands
	 * part-way through it. One motion, whether it was a hand or an arrow that
	 * started it, and the same scroll events, so the stepper renames the day at
	 * the halfway point exactly as it does under a finger.
	 *
	 * A tween rather than `scrollTo({ behavior: 'smooth' })`: see `GLIDE_MS`.
	 * Snapping is off while it runs, for the reason it is off under a carried
	 * block (`.held`): a mandatory snap container answers every per-frame write
	 * by throwing the strip back to the nearest day. Written as an inline style
	 * rather than a class so a render in the middle of the slide cannot take it
	 * away. A reader who asked for stillness gets the day at once.
	 *
	 * The agenda has no strip. When the payload already holds the day asked for,
	 * the list switches to it at once instead of waiting for the fetch.
	 */
	const stepTo = useCallback(
		(day: string) => {
			const el = scrollRef.current;
			if (!el) return;
			const i = board.findIndex((b) => b.day === day);
			if (i < 0) return;
			committed.current = day;
			if (data?.view === 'agenda') {
				setShownDay(day);
				return;
			}
			const to = i * stride(el);
			const was = glide.current;
			if (was) cancelAnimationFrame(was.raf);
			if (stillness) {
				endGlide();
				el.scrollLeft = to;
				return;
			}
			const from = was ? was.at : el.scrollLeft;
			el.style.setProperty('scroll-snap-type', 'none');
			const g = { day, from, to, at: from, t0: performance.now(), raf: 0 };
			glide.current = g;
			// Progress is counted a frame at a time, capped at two frames' worth,
			// rather than read off the clock. The payload lands mid-slide and
			// drawing the new panels is one long frame; read off the clock, the
			// strip leapt a third of a day to catch up with the time it missed.
			let done = 0;
			let last = g.t0;
			const tick = (now: number) => {
				if (glide.current !== g) return;
				done += Math.min(Math.max(0, now - last), 34);
				last = now;
				const t = Math.min(1, done / GLIDE_MS);
				g.at = g.from + (g.to - g.from) * (1 - (1 - t) ** 3);
				el.scrollLeft = g.at;
				if (t < 1) g.raf = requestAnimationFrame(tick);
				else endGlide();
			};
			g.raf = requestAnimationFrame(tick);
		},
		[board, data?.view, stillness, endGlide]
	);

	/**
	 * The strip follows the back and forward buttons, not only the arrows.
	 *
	 * A Back pressed while an arrow's slide was still running moved the url to
	 * the day the reader came from, and the slide went on to the day the arrow
	 * had asked for. A quick enough Back is never even rendered as a change: the
	 * router commits the entry it returns to, which is the one it was already
	 * on, so nothing is fetched and no payload ever comes to put the strip
	 * right. The reader was left looking at one day under an address naming
	 * another. So a history move is read off the url itself, as it happens: when
	 * the day it names is on the strip and the strip is not on it, the strip
	 * turns towards it from wherever it is, the same slide an arrow makes (or
	 * the same jump, for a reader who asked for stillness); when the day is not
	 * on the strip, a slide in flight is ended and that day's payload seats it.
	 */
	useEffect(() => {
		if (!data || data.view === 'agenda') return;
		const view = data.view;
		const onPop = () => {
			const q = new URLSearchParams(window.location.search);
			const day = q.get('day');
			const el = scrollRef.current;
			if (!day || q.get('view') !== view || !el || dragRef.current) return;
			const g = glide.current;
			const w = stride(el);
			const on = g ? g.day : w ? seatDays.current[Math.round(el.scrollLeft / w)] : day;
			if (on === day) return;
			if (seatDays.current.includes(day)) stepTo(day);
			else endGlide();
		};
		window.addEventListener('popstate', onPop);
		return () => window.removeEventListener('popstate', onPop);
	}, [data?.view, !!data, stepTo, endGlide]);

	/** The latest `stepTo`, for a listener that must not re-bind with every board. */
	const stepRef = useRef(stepTo);
	stepRef.current = stepTo;

	/**
	 * A finger moves the strip by script, one day at most, and only on purpose.
	 *
	 * See `AXIS_LOCK_PX` for the rules. The strip is `touch-action: pan-y`, so
	 * the browser only ever pans it up and down; a gesture this reads as
	 * sideways cancels its own moves as well, which is what keeps a scroll that
	 * the browser had not yet started from starting under it. A move that can no
	 * longer be cancelled means the browser has already taken the gesture as a
	 * scroll, so it stays one.
	 *
	 * The release hands over to `stepTo`, the arrow's tween, both to go on to the
	 * neighbour and to spring back, so the re-seat, the rebase and the url settle
	 * stay one path. Going on writes the url at once, replacing, as a settle
	 * does: the payload it fetches lands under the tween exactly as an arrow's
	 * does. A block lifted by a long press takes the touch over entirely; mouse,
	 * trackpad and wheel never reach here.
	 */
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || !data || data.view === 'agenda') return;
		const view = data.view;
		const step = (day: string) => stepRef.current(day);
		type Touch1 = {
			x: number;
			y: number;
			/** Where the finger came down, and where it is now. */
			x0: number;
			lastX: number;
			/**
			 * The day the strip was on when the finger took it, and how far off
			 * that day's seat it was. A day rather than an index: a payload that
			 * lands mid-swipe re-indexes the strip (`seatDays`), and an index read
			 * before it names a different day after it.
			 */
			fromDay: string;
			offset: number;
			axis: 'x' | 'y' | null;
			trail: { x: number; t: number }[];
		};
		let t: Touch1 | null = null;
		/** Where `t.fromDay` sits on the strip now, re-taken from the strip if it has gone. */
		const anchor = (cur: Touch1, w: number): number => {
			const i = seatDays.current.indexOf(cur.fromDay);
			if (i >= 0) return i;
			const j = Math.max(0, Math.min(seatDays.current.length - 1, Math.round(el.scrollLeft / w)));
			cur.fromDay = seatDays.current[j];
			cur.offset = 0;
			return j;
		};
		/** Put the strip back on the day it left, or on to the one it reached. */
		const land = (dir: number) => {
			const cur = t;
			swiping.current = false;
			swipeAt.current = null;
			t = null;
			const w = stride(el);
			if (!cur || !w) return;
			const i = anchor(cur, w);
			const day = seatDays.current[Math.max(0, Math.min(seatDays.current.length - 1, i + dir))];
			if (!day) return;
			step(day);
			// A reader who asked for stillness gets the day at once and no tween,
			// and the tween's end is what gives snapping back to the strip.
			if (!glide.current) el.style.removeProperty('scroll-snap-type');
			// Against the url, not the day the swipe started on: a swipe that
			// interrupted a slide, or started before the last one's payload came
			// back, can land on a day the address does not name yet, or no longer.
			const named = new URLSearchParams(window.location.search).get('day');
			if (day !== named) navigate(navUrl(day, view), { replace: true });
		};
		const onStart = (e: TouchEvent) => {
			if (swiping.current) land(0);
			t = null;
			if (e.touches.length !== 1 || dragRef.current) return;
			const p = e.touches[0];
			t = {
				x: p.clientX,
				y: p.clientY,
				x0: p.clientX,
				lastX: p.clientX,
				fromDay: '',
				offset: 0,
				axis: null,
				trail: [{ x: p.clientX, t: e.timeStamp }]
			};
		};
		const onMove = (e: TouchEvent) => {
			if (!t) return;
			if (dragRef.current || e.touches.length !== 1) {
				if (t.axis === 'x') land(0);
				t = null;
				return;
			}
			const p = e.touches[0];
			const dx = p.clientX - t.x;
			const dy = p.clientY - t.y;
			t.lastX = p.clientX;
			if (!t.axis) {
				if (Math.hypot(dx, dy) < AXIS_LOCK_PX) return;
				t.axis = e.cancelable && Math.abs(dx) > Math.abs(dy) * AXIS_RATIO ? 'x' : 'y';
				if (t.axis === 'y') return;
				endGlide();
				swiping.current = true;
				// Snapping would throw every per-move write back to the day.
				el.style.setProperty('scroll-snap-type', 'none');
				// Followed from here, so the strip does not jump the lock's ten pixels,
				// and taken from where the strip is now: a payload may have re-seated
				// it since the finger came down.
				t.x = p.clientX;
				const w = stride(el);
				const i = Math.max(0, Math.min(seatDays.current.length - 1, Math.round(el.scrollLeft / w)));
				t.fromDay = seatDays.current[i] ?? '';
				t.offset = el.scrollLeft - i * w;
			}
			if (t.axis !== 'x') return;
			if (e.cancelable) e.preventDefault();
			const w = stride(el);
			if (!w) return;
			const seat = anchor(t, w) * w;
			const max = el.scrollWidth - el.clientWidth;
			el.scrollLeft = Math.max(
				0,
				Math.min(max, seat + w, Math.max(seat - w, seat + t.offset - (p.clientX - t.x)))
			);
			swipeAt.current = { day: t.fromDay, off: el.scrollLeft - seat };
			t.trail.push({ x: p.clientX, t: e.timeStamp });
			while (t.trail.length > 2 && e.timeStamp - t.trail[0].t > FLICK_WINDOW_MS) t.trail.shift();
		};
		const onEnd = (e: TouchEvent) => {
			if (!t || t.axis !== 'x') {
				t = null;
				return;
			}
			const w = stride(el);
			// The whole of the finger's travel, the lock's ten pixels included:
			// positive is towards the next day.
			const moved = t.x0 - t.lastX;
			const first = t.trail[0];
			const last = t.trail[t.trail.length - 1];
			// Still moving when it lifted: a finger that paused first has not flicked.
			const live = last && e.timeStamp - last.t <= FLICK_WINDOW_MS;
			const v = live && first && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
			let dir = 0;
			if (w && Math.abs(moved) >= w * SWIPE_SHARE) dir = Math.sign(moved);
			else if (Math.abs(v) >= FLICK_PX_PER_MS && Math.abs(moved) >= FLICK_MIN_PX) {
				// Only a flick the way the strip was dragged; one back towards the
				// day it left is a change of mind, and lands it there.
				if (Math.sign(-v) === Math.sign(moved)) dir = Math.sign(moved);
			}
			land(dir);
		};
		// Taken away by the system: nobody let go anywhere, so it goes back.
		const onCancel = () => {
			if (t?.axis === 'x') land(0);
			t = null;
		};
		el.addEventListener('touchstart', onStart, { passive: true });
		el.addEventListener('touchmove', onMove, { passive: false });
		el.addEventListener('touchend', onEnd, { passive: true });
		el.addEventListener('touchcancel', onCancel, { passive: true });
		return () => {
			el.removeEventListener('touchstart', onStart);
			el.removeEventListener('touchmove', onMove);
			el.removeEventListener('touchend', onEnd);
			el.removeEventListener('touchcancel', onCancel);
			swiping.current = false;
			swipeAt.current = null;
		};
		// `stepTo` through a ref: it changes with every board, and re-binding
		// mid-gesture would drop the finger's state with the strip half moved.
	}, [data?.view, !!data, endGlide, navigate]);

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
	 * The days' own contents decide it: their blocks and their journeys, both of
	 * which already carry the draft in an open dialog, so setting a block to 4:40
	 * opens the board as it is typed. A drag opens it further through `openFloor`
	 * rather than through here, because this snaps to the hour and a gesture
	 * needs the minute.
	 *
	 * Every drawn day, not just the one being read. The panels of the strip share
	 * one grid origin, which is what makes their hour lines meet across a scroll;
	 * a window measured off the anchor alone would draw a neighbour's 4am block
	 * above the top of its own panel, where it is clipped and sitting at the
	 * wrong hour. The cost is that a neighbour's early start opens the day you
	 * are reading too, which is the right way round: an hour of empty grid is
	 * cheaper than a block in the wrong place.
	 */
	const winStart = useMemo(
		() =>
			windowStart(
				board.flatMap((entry) => [
					...entry.events.map((e) => holdsOpen(e, entry.day)),
					...entry.legs.map((l) => l.startMin)
				])
			),
		[board, holdsOpen]
	);

	/**
	 * The same first minute, for the days as saved: no draft from an open dialog.
	 *
	 * This is what the floor below follows. The draft-inclusive `winStart` is
	 * still what a dialog opens the window through as it is typed; keeping the
	 * two apart is what lets a saved early start that arrives while a dialog is
	 * open (a step behind a docked panel, a live reload) hold the clock still
	 * like any other, rather than open the window with nothing to offset it.
	 */
	const savedStart = useMemo(
		() =>
			windowStart(
				(data?.board ?? []).flatMap((entry) => [
					...entry.events.filter(showEvent).map((e) => holdsOpen(e, entry.day)),
					...entry.legs.filter(showLeg).map((l) => l.startMin)
				])
			),
		[data, showEvent, showLeg, holdsOpen]
	);

	/**
	 * The earliest the window has opened to on this visit to the day board.
	 *
	 * The window may open earlier as the reader moves through the trip, and it
	 * never closes again while they stay. `winStart` is measured off the three
	 * days the strip holds, and the strip recycles them on every step, so a
	 * board that followed it exactly moved its whole clock whenever a day with
	 * an early start came into or went out of the three: every hour line slid
	 * down an hour, or up one, under a reader who had only asked for tomorrow.
	 * Holding the earliest start seen is what lets a step leave the hours where
	 * they were. The cost is the same as the shared origin's, an hour of empty
	 * grid above a day that does not need it, and it is the same right trade.
	 *
	 * Fed only by the days as saved (`savedStart`), whether or not a dialog is
	 * open. A draft opens the window through `winStart` as it is typed and closes
	 * it again on a cancel, as it always has, and nothing is offset for it; once
	 * saved, the reload brings the time back as saved and it counts from then.
	 * Kept per trip and view, so another trip starts afresh.
	 *
	 * State set while rendering, React's way of deriving a value from the last
	 * one: it is a running minimum, and the guard only lets it move down.
	 */
	const floorKey = `${trip.id}|${data?.view ?? ''}`;
	const [floorAt, setFloorAt] = useState<{ key: string; min: number } | null>(null);
	let floor = floorAt?.key === floorKey ? floorAt.min : null;
	if (data && data.view !== 'agenda' && (floor === null || savedStart < floor)) {
		floor = savedStart;
		setFloorAt({ key: floorKey, min: savedStart });
	}
	/** The window at rest: the floor, opened further only by a draft. */
	const restStart = Math.min(winStart, floor ?? savedStart);

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
	 * continuous it never steps. `restStart` is the floor it returns to.
	 */
	const boardStart = Math.min(restStart, (drag ? drag.liveStart : openFloor) ?? restStart);

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
	const openedBy = restStart - boardStart;
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

	/**
	 * Keep the clock still when the floor opens the window under the reader.
	 *
	 * The floor drops when a day with an earlier start than any seen so far
	 * arrives: a step, a swipe, the date picker, a live reload of somebody
	 * else's early block, a change of who the board is read as. The grid then
	 * grows at the top and every hour on it would slide down by what was opened,
	 * so the box is scrolled down by exactly that in the same layout pass, before
	 * paint, and nothing on screen moves. The new hours are there above, for a
	 * reader who scrolls up to them. The same correction the drag's glue makes,
	 * for the same reason; here nobody is holding anything.
	 *
	 * The board's own transitions are switched off for that one frame
	 * (`.rebase`). Every block and hour line eases its `top`, and a glide down
	 * by the opening under a scroll that has already jumped by it is the very
	 * slide this exists to remove. The class is added and the style read back
	 * before the scroll is written, which also cancels any transition an earlier
	 * layout read in this commit had already started.
	 *
	 * Not for the reader's own writes. A block they drag to 4:30 or type in at
	 * 4:40 opens the window, and that opening is the board answering them, so it
	 * keeps the behaviour it has always had: the drop's `openFloor` and the
	 * draft's `winStart` open it, the saved time holds it open once it is back,
	 * and the hours ease into place rather than vanishing above the box. Marked
	 * by `ownWrite` around the reload that follows a write, and cleared by the
	 * next payload.
	 */
	const lastOrigin = useRef<{
		start: number;
		floor: number;
		data: ScheduleData;
	} | null>(null);
	useLayoutEffect(() => {
		if (!data) return;
		const was = lastOrigin.current;
		const floorNow = floor ?? savedStart;
		lastOrigin.current = { start: boardStart, floor: floorNow, data };
		const mine = ownWrite.current;
		if (was && was.data !== data) ownWrite.current = false;
		const el = scrollRef.current;
		if (!el || !was || data.view === 'agenda' || was.data.view === 'agenda') return;
		if (dragRef.current || mine || floorNow >= was.floor) return;
		const opened = (was.start - boardStart) * PX_PER_MIN;
		if (opened <= 0) return;
		el.classList.add('rebase');
		void el.scrollHeight;
		el.scrollTop += opened;
		requestAnimationFrame(() => el.classList.remove('rebase'));
	});

	/** Which city a day is spent in, for ordering the place picker. */
	const cityOfDay = useCallback(
		(day: string) => board.find((b) => b.day === day)?.city?.id ?? null,
		[board]
	);

	/**
	 * Every event on the board, for looking one up by id from a dialog.
	 *
	 * Stays are in it too, the previous night's included. A day's first journey
	 * leaves the room it was slept in, and that stay is not a block of this day,
	 * so a map built from the day's blocks alone cannot name where the morning
	 * starts and the journey reads as a bare mode word.
	 */
	const eventById = useMemo(() => {
		const out = new Map<string, EventRow>();
		for (const entry of board) {
			for (const e of entry.events) out.set(e.id, e);
			for (const s of entry.stays) out.set(s.id, s);
			for (const s of entry.incoming) out.set(s.id, s);
		}
		return out;
	}, [board]);

	/**
	 * Where a block added without pointing at a time should start.
	 *
	 * The end of the day being added to, or 09:00 for a day with nothing on it.
	 * The server refines it the moment the block is saved, adding the journey to
	 * wherever the block turns out to be, which is a number the dialog cannot
	 * know until a place has been picked. Read on the day, so a block carried
	 * in from last night counts by where it ends this morning.
	 */
	const suggestedStart = useMemo(
		() =>
			adding
				? suggestStart(board.find((e) => e.day === adding.day)?.events ?? [], adding.day, zoneOf)
				: 0,
		[adding, board, zoneOf]
	);

	/* Opening an event: the pencil on a block, or a stay band, asks for the
	   editor. Pointing at a block no longer opens it; a click focuses the map
	   instead, so `openBlock` is reached through the pencil alone. A frozen
	   board has no pencil, so there the block itself opens it: the lock takes
	   away the writing, not the reading.

	   What is opened is the row as it stood at that moment, held in state, not
	   an id the dialog re-reads out of every payload. The board reloads live
	   whenever anybody writes, and a dialog fed the reloaded row was always
	   holding the newest version: its save then passed the server's lost-update
	   check by construction and wrote this form's stale copy of every field over
	   whatever the other person had just saved. Held still, the version is the
	   one the form was filled in against, and a save after somebody else's is
	   refused with the conflict message, which is the whole point of sending
	   it. Held still is also what keeps the dialog on screen when somebody else
	   moves the block out of the three days the board has loaded: a dialog
	   looked up by id vanished mid-sentence, taking the unsaved edit with it. */
	const dataRef = useRef(data);
	dataRef.current = data;
	const savedRow = (id: string): EventRow | null => {
		for (const entry of dataRef.current?.board ?? []) {
			for (const e of entry.events) if (e.id === id) return e;
			for (const s of entry.stays) if (s.id === id) return s;
		}
		return null;
	};
	const openBlock = useCallback((id: string) => {
		const row = savedRow(id);
		if (!row) return;
		setOpenLegId('');
		setOpened(row);
		// `savedRow` only reads the ref, so it has nothing to depend on.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	/* Opening a journey's arrival, keeping the leg's id so the dialog opens on
	   the journey that was meant. Reached from the agenda list, whose rows open
	   the way they always have: the click-focuses-the-map change is the day
	   board's, and the agenda has no pencil to move editing onto. */
	const openLeg = useCallback((leg: LegRow) => {
		const row = savedRow(leg.toEventId);
		if (!row) return;
		setOpenLegId(leg.id);
		setOpened(row);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	/** Add something to the day being read, with no time chosen yet.
	 *
	 * The day under the reader rather than the day in the url, because while the
	 * strip is mid-gesture those differ and the button belongs to the day on
	 * screen. */
	const addDay = reading?.day ?? data?.day;
	const addHere = useCallback(() => {
		if (addDay && !locked) setAdding({ day: addDay, start: null });
	}, [addDay, locked]);
	const closeEvent = () => {
		setOpened(null);
		setOpenLegId('');
	};

	/* The journeys a dialog edits, replanned live: an edit to who is going makes
	   groups split and merge as it is typed, and this is the same list the board
	   is drawing behind the panel.

	   Read off `planned` rather than off `board`, for the add and the edit alike.
	   A block being added is on the board under the draft id, so it has journeys
	   before it exists; adding one while reading as one person would otherwise
	   hide the other groups converging on it, and the same block reopened as
	   everyone would show them. A dialog about who is coming has to list
	   everyone who is, and the edit dialog used to be the one that did not. */
	const legsTo = (entries: BoardDay[], eventId: string) =>
		entries.flatMap((entry) => entry.legs.filter((l) => l.toEventId === eventId));
	// The cards' baseline is the plan before their own edits; what the board is
	// drawing with them applied is handed over beside it, for the warning.
	const openLegs = useMemo(
		() => (openEventId ? legsTo(unedited, openEventId) : []),
		[openEventId, unedited]
	);
	const openLive = useMemo(
		() => (openEventId ? legsTo(planned, openEventId) : []),
		[openEventId, planned]
	);
	const draftLegs = useMemo(() => (adding ? legsTo(unedited, DRAFT_ID) : []), [adding, unedited]);
	const draftLive = useMemo(() => (adding ? legsTo(planned, DRAFT_ID) : []), [adding, planned]);

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
		const readingDay = reading?.day ?? preview.day;
		const el = scrollRef.current;
		// The copy on the day being read: a span is drawn on every day it
		// covers, and the first one in the document may be a neighbour's.
		const lane = (
			document.querySelector(`.sched .daypanel[data-day="${readingDay}"] .block.editingnow`) ??
			document.querySelector('.sched .block.editingnow')
		)?.closest('.lane');
		if (!el || !lane) return;
		const laneTop = lane.getBoundingClientRect().top;
		// The part of the draft on the day the block was found in, which for a
		// span is not its own start and end minutes.
		const onDay = lane.closest<HTMLElement>('.daypanel')?.dataset.day ?? preview.day;
		const seg = segmentOn(preview, onDay, zoneOf) ?? {
			start: preview.start_min,
			end: preview.end_min
		};
		const top = laneTop + topPx(seg.start, boardStart);
		const bottom = laneTop + topPx(seg.end, boardStart);
		const box = el.getBoundingClientRect();
		const margin = 56;
		const over = bottom - (box.bottom - margin);
		const under = top - (box.top + margin);
		// Never past the block's own top: a long event cannot be shown whole, and
		// the end of one is worth less than knowing where it begins.
		const by = under < 0 ? under : over > 0 ? Math.min(over, under) : 0;
		if (by) el.scrollBy({ top: by, behavior: 'smooth' });
	}, [preview, roomToDock, boardStart, zoneOf, reading?.day]);

	const peopleLabel = useCallback(
		(ids: string[]) => {
			// Naming nobody and naming everybody are the same fact, and the stored
			// form is the empty list: see `PeoplePicker`.
			if (ids.length === 0 || ids.length === members.length) return copy.common.everyone;
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
		   field. The two are told apart by colour: a scheduled place wears its
		   block's own colour, and an unscheduled one is grey, so the map says both
		   what is in the plan and what each planned thing is. The day's own stops
		   also carry their number and the line through them. */
		const dayPins = (mapped?.events ?? []).filter((e) => e.lat != null && e.lng != null);
		const stayPins = (mapped?.stays ?? []).filter((s) => s.lat != null && s.lng != null);
		const scheduledPoiIds = new Set(
			(mapped?.events ?? []).map((e) => e.poi_id).filter((id): id is string => id !== null)
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
			const day = mapped?.day ?? '';
			const at = (e: EventRow) => segOf(e, day);
			const evs = [...dayPins].sort((a, b) => at(a).start - at(b).start);
			if (evs.length < 2) return true;
			for (let i = 1; i < evs.length; i++) {
				if (at(evs[i]).start < at(evs[i - 1]).end) return false;
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
				color: UNPLANNED,
				items: restPins.map((p) => ({
					title: p.name,
					lat: p.lat,
					lng: p.lng,
					color: UNPLANNED,
					/* Which city it is in, which neither the colour nor the track name
					   says, and how much appetite there is for it: a saved place is
					   read to decide whether to schedule it, and the vote is what that
					   decision turns on. */
					subtitle: cityName.get(p.city_id),
					detail: p.votes ? [p.votes === 1 ? '1 vote' : `${p.votes} votes`] : undefined,
					/* The card's "+ Add": these are exactly the places the day has not
					   got, so deciding to have one and saying so are the same act. A
					   frozen board offers no add anywhere else, so it offers none
					   here either: a button that opens a dialog with nothing to save
					   is an add that fails at the last step. */
					addId: locked ? undefined : p.id
				})),
				line: false,
				numbered: false,
				// Every saved place in the trip, across every city, so fitting the
				// camera to these framed the whole itinerary, which on a two-city
				// trip is most of a hemisphere. The camera is the day's.
				fit: false
			});
		}
		if (dayPins.length && data) {
			/* How you get here, which is the question a map is being asked. The legs
			   are the ones already on the board, so they answer it for whoever is
			   being read rather than for the group in the abstract. */
			const arrivals = new Map<string, LegRow[]>();
			for (const l of mapped?.legs ?? []) {
				const at = arrivals.get(l.toEventId);
				if (at) at.push(l);
				else arrivals.set(l.toEventId, [l]);
			}
			const stops = [...dayPins].sort(
				(a, b) => segOf(a, mapped!.day).start - segOf(b, mapped!.day).start
			);
			/* Where the route starts: the room the day's first journey leaves.
			   That is the stay the journey into stop 1 sets off from, or failing
			   one, last night's stay for whoever is being read. Only where there
			   is exactly one such place with a pin on the map: a group that slept
			   in two hotels has no one start, and a line from a point with no pin
			   would be a route out of nowhere. */
			const pinned = new Set(stayPins.map((s) => `${s.lat},${s.lng}`));
			const room = (s: EventRow | undefined): s is EventRow =>
				!!s && s.type === 'stay' && pinned.has(`${s.lat},${s.lng}`);
			const leftFrom = (arrivals.get(stops[0].id) ?? [])
				.map((l) => eventById.get(l.fromEventId))
				.filter(room);
			const rooms = leftFrom.length
				? leftFrom
				: (mapped?.incoming ?? []).filter((s) => showEvent(s) && room(s));
			const starts = new Map(rooms.map((s) => [`${s.lat},${s.lng}`, s]));
			const start = starts.size === 1 ? [...starts.values()][0] : null;
			tracks.push({
				name: dayLabel(mapped?.day ?? data.day),
				color: '#2f6d5e',
				items: stops.map((e) => {
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
						color: EVENT_COLORS[e.type],
						subtitle: `${typeLabel(e.type)} · ${spanRange(e, zoneOf)}`,
						detail: [peopleLabel(e.people), ...shown],
						warn: legs.some((l) => l.tight) ? copy.viewAs.travelWarning : undefined
					};
				}),
				numbered: ordered,
				line: ordered,
				lineFrom:
					ordered && start ? { lat: start.lat as number, lng: start.lng as number } : undefined
			});
		}
		/* The night's lodging, shown on the map like any other place now that a
		   stay carries the coordinates of the room it books. It is its own track
		   with no number and its own colour and card: a stay is a range of nights
		   rather than a stop, so numbering it among the stops would be a claim
		   that is not true. The day's route does start there, though, because
		   that is where the day's travel really starts: the line to stop 1 is
		   drawn from the room (`lineFrom` above), not from this track. */
		if (stayPins.length && data) {
			tracks.push({
				name: typeLabel('stay'),
				color: EVENT_COLORS.stay,
				items: stayPins.map((s) => ({
					title: s.title,
					lat: s.lat,
					lng: s.lng,
					color: EVENT_COLORS.stay,
					subtitle: typeLabel(s.type),
					detail: [peopleLabel(s.people)]
				})),
				line: false,
				numbered: false
			});
		}
		return tracks;
	}, [mapped, data, readAs, eventById, peopleLabel, locked, segOf, zoneOf, showEvent]);

	/* Clicking a block on the board aims the map at it, so the reader can see
	   what is around the place they just selected. A click focuses; it does not
	   open the editor, which is the pencil's job. The focused point is the
	   clicked event's own, looked up the way the open one is so a stay band
	   focuses too. An event with no coordinates (free time, or a place not chosen
	   yet) focuses nothing, which the map reads as "show the day". */
	const focusEvent = useMemo(() => {
		if (!focusId) return null;
		for (const entry of data?.board ?? []) {
			for (const e of entry.events) if (e.id === focusId) return e;
			for (const s of entry.stays) if (s.id === focusId) return s;
		}
		return null;
	}, [focusId, data]);
	const mapFocus = useMemo<MapCenter>(() => {
		if (!focusEvent || focusEvent.lat == null || focusEvent.lng == null) return null;
		return { lat: focusEvent.lat, lng: focusEvent.lng, name: focusEvent.title };
	}, [focusEvent]);
	const [mapFocusKey, setMapFocusKey] = useState(0);
	/* Aim the map at a block. The key bumps on every call rather than on a change
	   of id, so clicking the same block twice re-aims instead of doing nothing. */
	const focusOnMap = useCallback((id: string) => {
		setFocusId(id);
		setMapFocusKey((k) => k + 1);
	}, []);
	/* Drop the selection and hand the camera back to the whole day. The key
	   bumps here too: the map only re-aims when it changes, so clearing the id
	   alone left the camera zoomed on a block that was no longer selected, or
	   no longer on the day at all. */
	const clearFocus = useCallback(() => {
		setFocusId('');
		setMapFocusKey((k) => k + 1);
	}, []);
	/* A grey pin is a place nobody has scheduled, so the only thing to do to it
	   is schedule it. The card's "+ Add" opens the ordinary add dialog with the
	   place already picked, on the day the board is showing: the map is read
	   against that day, so it is the day the reader means. The type follows the
	   Discover bucket, since a restaurant asked for as an activity would have to
	   be corrected in the dialog every time. */
	const savedById = useMemo(
		() => new Map((data?.saved ?? []).map((p) => [p.id, p])),
		[data?.saved]
	);
	const addFromMap = useCallback(
		(poiId: string) => {
			const p = savedById.get(poiId);
			// `addDay`, the same day the Add button uses: the day under the reader
			// in either view. This read `shownDay`, which only the day board's
			// strip ever sets, so in the agenda the button did nothing on a fresh
			// load and added to whatever day the strip was last on after a switch.
			if (!p || !addDay || locked) return;
			setAdding({
				day: addDay,
				start: null,
				type: p.kind === 'food' ? 'food' : 'activity',
				poi: { id: p.id, name: p.name }
			});
		},
		[savedById, addDay, locked]
	);
	/* The camera returns to the whole day when the selection is dropped: on a day
	   change, because the focused block is not on the new day, and on Escape while
	   no dialog is up, since an open dialog owns Escape for its own close. Keyed on
	   the day the map draws, so in the agenda a focus is let go on the tap, with
	   the camera free to fly to the new day, rather than when the fetch lands. */
	const shownDayKey = mapped?.day ?? data?.day;
	const hadFocus = useRef(false);
	hadFocus.current = !!focusId;
	useEffect(() => {
		// Only when something was focused: a bumped key on every day change would
		// refit a camera the reader had panned for no reason.
		if (hadFocus.current) clearFocus();
	}, [shownDayKey, clearFocus]);
	const dialogUp = !!openEventId || !!adding;
	// Read through a ref by one listener that is always there, rather than
	// added when a block is focused: a listener added by that render's effect
	// could miss an Escape pressed in the same moment as the click.
	const escapable = useRef(false);
	escapable.current = !!focusId && !dialogUp;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && escapable.current) clearFocus();
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [clearFocus]);

	const mapPanel = useMemo(
		() => (
			<aside className="mapwrap card">
				{data?.mapsKey && !mapsOut ? (
					<GoogleMap
						tracks={mapTracks}
						apiKey={data.mapsKey}
						center={mappedCity}
						focus={mapFocus}
						focusKey={mapFocusKey}
						onAdd={locked ? undefined : addFromMap}
						onUnavailable={() => setMapsOut(true)}
					/>
				) : (
					<TripMap
						tracks={mapTracks}
						center={mappedCity}
						focus={mapFocus}
						focusKey={mapFocusKey}
						onAdd={locked ? undefined : addFromMap}
					/>
				)}
			</aside>
		),
		// `mapsOut` belongs here and is easy to lose: the panel is held by identity
		// so a drag does not re-render it, which is the whole point of the memo,
		// and the refusal that raises the flag lands seconds after first paint.
		// Without the dep the swap to Leaflet waits for the next change to
		// `mapTracks`, which most board edits produce, so the bug would not be a
		// map that never falls back but one that falls back only sometimes.
		[data?.mapsKey, mapsOut, mapTracks, mappedCity, mapFocus, mapFocusKey, addFromMap, locked]
	);

	// --- Drag and resize ----------------------------------------------------

	/* Where a block is drawn on a day: its segment there, moved by whatever
	   gesture is holding it. Only a block that is all on one day is ever held,
	   so a span is always simply its segment. */
	function startFor(ev: EventRow, seg: Segment): number {
		if (!seg.startsHere || !seg.endsHere) return seg.start;
		if (drag && drag.id === ev.id) return drag.liveStart;
		if (pending && pending.id === ev.id && pending.start !== undefined) return pending.start;
		return seg.start;
	}
	function endFor(ev: EventRow, seg: Segment): number {
		if (!seg.startsHere || !seg.endsHere) return seg.end;
		if (resize && resize.id === ev.id) return resize.liveEnd;
		if (pending && pending.id === ev.id && pending.end !== undefined) return pending.end;
		return startFor(ev, seg) + (seg.end - seg.start);
	}

	/**
	 * A touch that has gone down on a block but has not yet become a drag.
	 *
	 * See `LONG_PRESS_MS`. Held in a ref, since a timer and a pointer move both
	 * have to see it in the tick that changes it.
	 */
	const hold = useRef<{ timer: number; x: number; y: number } | null>(null);
	const dropHold = useCallback(() => {
		if (!hold.current) return;
		window.clearTimeout(hold.current.timer);
		hold.current = null;
	}, []);
	useEffect(() => dropHold, [dropHold]);

	/**
	 * Start a gesture now for a mouse or a pen, or after a still long press for a
	 * finger. `start` is handed the element to capture the pointer on.
	 *
	 * The long press only works because the board lets the browser pan on touch
	 * (`touch-action` in `schedule.css`) and then, once a block is lifted, stops
	 * the pan itself: see the `touchmove` guard below.
	 */
	const pressThen = useCallback(
		(e: React.PointerEvent, start: () => void) => {
			const el = e.currentTarget as HTMLElement;
			const id = e.pointerId;
			const begin = () => {
				try {
					el.setPointerCapture(id);
				} catch {
					// The pointer has already gone; the gesture never started.
					return;
				}
				start();
			};
			dropHold();
			if (e.pointerType !== 'touch') return begin();
			hold.current = {
				x: e.clientX,
				y: e.clientY,
				timer: window.setTimeout(() => {
					hold.current = null;
					navigator.vibrate?.(10);
					begin();
				}, LONG_PRESS_MS)
			};
		},
		[dropHold]
	);

	/** A resting finger that moved is a scroll, not a press: let the page have it. */
	const holdMoved = useCallback(
		(e: React.PointerEvent) => {
			const h = hold.current;
			if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > HOLD_SLOP_PX) dropHold();
		},
		[dropHold]
	);

	/* While a block is lifted by a finger, the finger moves the block and not the
	   page. `touch-action` is decided when the touch lands, and on a coarse
	   pointer it allows panning so that a swipe scrolls; the only way to take
	   the pan back once the long press has lifted a block is to cancel the touch
	   moves. Registered only for the length of a gesture, because a non-passive
	   touch listener makes every scroll on the page wait for script. */
	const gestureOn = drag !== null || resize !== null;
	useEffect(() => {
		if (!gestureOn) return;
		const stop = (e: TouchEvent) => {
			if (e.cancelable) e.preventDefault();
		};
		document.addEventListener('touchmove', stop, { passive: false });
		return () => document.removeEventListener('touchmove', stop);
	}, [gestureOn]);

	/**
	 * The gesture was taken away before it was let go: a pointer cancelled by
	 * the system, or a capture lost. Whatever the block was doing under the
	 * pointer is dropped and nothing is written, because nobody let go of it
	 * anywhere. It used to stay drawn wherever the pointer was last seen, with
	 * the edge loop still running, until the next pointer event on the page.
	 */
	const cancelGesture = useCallback(() => {
		dropHold();
		if (dragRef.current) putDrag(null);
		if (resizeRef.current) putResize(null);
	}, [dropHold, putDrag, putResize]);

	const onPointerDown = useCallback(
		(e: React.PointerEvent, ev: EventRow, day: string) => {
			// Before the lock is checked, not after it. A frozen board still opens a
			// block on click, and that click reads this flag: left over from the
			// last drag before the lock went on, it made every click on the board
			// look like the end of a drag, and nothing would open.
			didDrag.current = false;
			if (locked) return;
			// A span, or a journey whose ends are on two clocks, is not picked up:
			// its click opens it instead, and the server refuses to move one by
			// its drawing. See `Block`.
			if (!onOneClock(ev, zoneOf)) return;
			// Let the resize grip through.
			if ((e.target as HTMLElement).closest('.bresize')) return;
			const { clientX: x, clientY: y } = e;
			const seg = segOf(ev, day);
			pressThen(e, () =>
				putDrag({
					id: ev.id,
					day,
					pointerStartY: y,
					pointerStartX: x,
					pointerY: y,
					pointerX: x,
					origStart: seg.start,
					mins: seg.end - seg.start,
					creep: 0,
					liveStart: seg.start,
					scrollLeft0: scrollRef.current?.scrollLeft ?? 0,
					dx: 0
				})
			);
		},
		[putDrag, locked, pressThen, segOf, zoneOf]
	);

	const onPointerMove = useCallback(
		(e: React.PointerEvent) => {
			holdMoved(e);
			const d = dragRef.current;
			if (!d) return;
			const y = e.clientY;
			// Either way counts: a block carried sideways to tomorrow is dragged
			// without its time ever changing.
			if (Math.hypot(e.clientX - d.pointerStartX, y - d.pointerStartY) > DRAG_SLOP_PX) {
				didDrag.current = true;
			}
			// The ref is the truth and is right immediately; the frame draws it.
			dragRef.current = {
				...d,
				pointerY: y,
				pointerX: e.clientX,
				liveStart: liveStartFor(d, d.creep, y)
			};
			touch();
		},
		[touch, holdMoved]
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
	 *
	 * The sides do the same thing for dates. Holding the block against the left
	 * or right of the box runs the strip through the days it has loaded, and the
	 * block stays put while they pass, so it is let go on whichever day has
	 * arrived under it. The reach is the loaded window, a day either side: a
	 * longer move is the Date field's job, since carrying a block across a
	 * fortnight by leaning on the edge of the screen is nobody's idea of a
	 * shortcut.
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
			const el = scrollRef.current;
			const box = el?.getBoundingClientRect();
			// Only once the pointer has really moved. A block pressed near a side
			// of a phone's board is inside the edge band before it has gone
			// anywhere, and a still press used to start the strip travelling to the
			// next day, which the release then wrote as a move.
			if (d && el && box && didDrag.current) {
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

				const pastLeft = box.left + EDGE_PX - d.pointerX;
				const pastRight = d.pointerX - (box.right - EDGE_PX);
				const days = (past: number) =>
					(Math.min(past, EDGE_PX) / EDGE_PX) * EDGE_DAY_RATE * stride(el) * dt;
				const sideways = pastLeft > 0 ? -days(pastLeft) : pastRight > 0 ? days(pastRight) : 0;
				if (sideways) el.scrollLeft += sideways;

				// The strip may also have moved under a still hand, so what it has
				// done is read back off the box rather than accumulated here.
				const dx = el.scrollLeft - d.scrollLeft0;
				if (by || dx !== d.dx) {
					const creep = by ? d.creep + by : d.creep;
					dragRef.current = {
						...d,
						creep,
						dx,
						liveStart: liveStartFor(d, creep, d.pointerY)
					};
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
		dropHold();
		const d = dragRef.current;
		if (!d) return;
		const snapped = Math.round(d.liveStart / 5) * 5;
		const { id, origStart, day } = d;
		// Whichever day the strip has brought under the block.
		const el = scrollRef.current;
		const w = el ? stride(el) : 0;
		const toDay = (w ? board[Math.round(el!.scrollLeft / w)]?.day : null) ?? day;
		putDrag(null);
		// A press that never moved is a click, and a click writes nothing: see
		// `DRAG_SLOP_PX`. Checked before the snap is compared, because the snap is
		// exactly what made a still press on 9:07 read as a move to 9:05.
		if (!didDrag.current) return;
		if (snapped === origStart && toDay === day) return;
		setPending({ id, start: snapped });
		// Hold the window where the gesture left it until the day comes back.
		setOpenFloor(snapped);
		// A drop on another date is a decision, so it goes in the history the way
		// the arrows do, and it is the url that walks the strip to the new day:
		// the board re-seats on whatever day it names.
		if (toDay !== day && data) navigate(navUrl(toDay, data.view));
		// The day rides along because a move carries one, and sending the day the
		// block was let go over is the whole of dragging across dates.
		await act(() => eventOp(id, { op: 'move', startMin: snapped, day: toDay }));
	}, [act, eventOp, putDrag, board, data, navigate, dropHold]);

	const onResizeDown = useCallback(
		(e: React.PointerEvent, ev: EventRow) => {
			didDrag.current = false;
			if (locked) return;
			e.stopPropagation();
			const y = e.clientY;
			// The same long press as the block itself: an 8px grip along every
			// block's bottom edge is somewhere a swipe lands all the time.
			pressThen(e, () =>
				putResize({
					id: ev.id,
					pointerStartY: y,
					startMin: ev.start_min,
					origEnd: ev.end_min,
					liveEnd: ev.end_min
				})
			);
		},
		[putResize, locked, pressThen]
	);

	const onResizeMove = useCallback(
		(e: React.PointerEvent) => {
			holdMoved(e);
			const r = resizeRef.current;
			if (!r) return;
			const y = e.clientY;
			if (Math.abs(y - r.pointerStartY) > DRAG_SLOP_PX) didDrag.current = true;
			resizeRef.current = {
				...r,
				// Bounded at both ends, like a drag: no shorter than the server will
				// store, and no later than the midnight the board ends at. The top
				// bound was missing, so a grip pulled past the bottom of the day drew
				// the block off the end of the grid and posted a time the server
				// then refused.
				liveEnd: Math.min(
					DAY_END,
					Math.max(
						r.startMin + MIN_EVENT_MINS,
						Math.round((r.origEnd + (y - r.pointerStartY) / PX_PER_MIN) / 5) * 5
					)
				)
			};
			touch();
		},
		[touch, holdMoved]
	);

	const onResizeUp = useCallback(async () => {
		dropHold();
		const r = resizeRef.current;
		if (!r) return;
		const snapped = Math.round(r.liveEnd / 5) * 5;
		const { id, origEnd } = r;
		putResize(null);
		// A tap on the grip is not a resize, for the same reason a click on the
		// block is not a move: the snap alone would change an end at 10:07.
		if (!didDrag.current) return;
		if (snapped === origEnd) return;
		setPending({ id, end: snapped });
		await act(() => eventOp(id, { op: 'resize', endMin: snapped }));
	}, [act, eventOp, putResize, dropHold]);

	/**
	 * The board's entrance when the view changes under it.
	 *
	 * A day step no longer comes through here. The board is a strip now, and a
	 * step is a real horizontal movement of it: the panels travel, the arrows
	 * start the same travel a hand would, and a scripted 64px slide of the card
	 * on top of that is a second motion disagreeing with the first about how far
	 * the board went and in which direction. The slide was standing in for a
	 * movement the board could not make, and the board can make it now.
	 *
	 * A view change still slides, because Day and Agenda really do replace what
	 * the card is drawing rather than move it, and there is no gesture between
	 * them for the strip to borrow.
	 */
	const boardRef = useRef<HTMLDivElement>(null);
	useSlideIn(
		boardRef,
		data && data.view,
		data ? VIEW_OPTIONS.findIndex((o) => o.v === data.view) : 0
	);

	/**
	 * The agenda's day step.
	 *
	 * The day board steps by travelling its strip; the agenda is one list with
	 * nothing beside it to travel to, so its rows were simply replaced, with no
	 * sign which way the reader went. A short slide from the side of travel with
	 * a fade says it, at a fraction of the board card's slide: this is a page of
	 * a list turning, not the board changing. Keyed on the day being listed and
	 * ranked by date, so a later day comes in from the right. Nothing vertical
	 * moves: the list keeps its scroll, exactly as the day board keeps its hour.
	 */
	const agendaRef = useRef<HTMLDivElement>(null);
	const listedDay = data?.view === 'agenda' ? (reading?.day ?? data.day) : null;
	useSlideIn(
		agendaRef,
		listedDay,
		listedDay ? Date.parse(`${listedDay}T00:00:00Z`) / 86_400_000 : 0,
		AGENDA_SLIDE
	);

	/**
	 * The lodging band only grows during a visit, the clock's floor for the band.
	 *
	 * The band sits above the board and names the stays of the day being read,
	 * so a step onto a day with fewer of them made it shorter and pulled the
	 * whole board up under the reader: 42px at 390px, a row of stay chips. The
	 * tallest band seen so far is held as its `min-height`, measured off the band
	 * as rendered, so a shorter day leaves room rather than taking it back. Per
	 * trip and view, like the window's floor, and per width, because the chips
	 * wrap differently on a rotated phone and a height kept from another width
	 * is a guess. Not taken before the web font is in: the fallback is wider and
	 * wraps the band onto a row it does not have once the font arrives, and
	 * holding that row would keep empty space for the whole visit.
	 */
	const bandRef = useRef<HTMLDivElement>(null);
	const bandFloor = useRef({ key: '', h: 0 });
	const holdBand = useCallback(() => {
		const el = bandRef.current;
		if (!el || (document.fonts && document.fonts.status !== 'loaded')) return;
		const key = `${trip.id}|${data?.view ?? ''}|${el.clientWidth}`;
		if (bandFloor.current.key !== key) {
			bandFloor.current = { key, h: 0 };
			el.style.removeProperty('min-height');
		}
		const h = el.getBoundingClientRect().height;
		if (h > bandFloor.current.h) bandFloor.current.h = h;
		el.style.minHeight = `${bandFloor.current.h}px`;
	}, [trip.id, data?.view]);
	useLayoutEffect(holdBand);
	useEffect(() => {
		let live = true;
		void document.fonts?.ready.then(() => {
			if (live) holdBand();
		});
		return () => {
			live = false;
		};
	}, [holdBand]);

	/* Three states before there is a page, as on every other trip page: still
	   loading, failed, or here. This drew nothing at all while the first day
	   loaded, and a failure was a banner with no way to ask again short of
	   reloading the whole app. */
	if (!data) return error ? <LoadError message={error} onRetry={reload} /> : <Loading />;

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
	 * covers. Clicking it aims the map at the building, the same as a block, and
	 * the pencil beside the name opens the dialog: that is the one place its
	 * dates, its place and who is in it are edited, and editing it on any day it
	 * covers edits the whole stay. There can be several, because half a group
	 * can be in one building and half in another, which is exactly what the old
	 * vote-derived band could not say.
	 *
	 * The band runs through the morning of checkout, because that morning is
	 * still spent in the room: it is where the first journey of the day starts
	 * from, and a day that drew nothing there read as a day with nowhere to
	 * sleep.
	 */
	function stayBands(entry: BoardDay) {
		return (
			<div className="stayband" ref={bandRef}>
				{entry.stays.map((s) => (
					<div key={s.id} className={preview?.id === s.id ? 'staychip editingnow' : 'staychip'}>
						<button
							type="button"
							className="stayface"
							aria-label={`${s.title}. ${locked ? cs.block.openLabel : cs.block.showOnMap}`}
							onClick={() => (locked ? openBlock(s.id) : focusOnMap(s.id))}
						>
							<span className="stayname">{s.title}</span>
							<span className="staywho">{peopleLabel(s.people)}</span>
						</button>
						{!locked && (
							<button
								type="button"
								className="stayedit"
								aria-label={copy.common.editLabel(s.title)}
								onClick={() => openBlock(s.id)}
							>
								<PencilIcon />
							</button>
						)}
					</div>
				))}
				{!locked && (
					<button
						type="button"
						className="stayadd"
						onClick={() => setAdding({ day: entry.day, start: null, type: 'stay' })}
					>
						{cs.addStay}
					</button>
				)}
			</div>
		);
	}

	function blockNode(
		ev: EventRow,
		day: string,
		lanePx: number,
		place: Layout,
		legTargets: Set<string>,
		trims: Map<string, number>
	) {
		const p = place.placed.get(ev.id);
		if (!p) return null;
		const seg = segOf(ev, day);
		const from = startFor(ev, seg);
		const to = endFor(ev, seg);
		const spanLabel = segmentTime(ev, seg, zoneOf);
		/* A journey that changes clocks is labelled as the ticket reads, its
		   departure on its own clock and its arrival on the arrival clock, named.
		   It is never under a hand, so the stored times are the times. */
		const zone = arrivalZone(ev, zoneOf);
		const fullTime = zone ? spanRange(ev, zoneOf) : clockRange(from, to);
		const ariaTime = spanLabel
			? `${spanLabel}, ${spanRange(ev, zoneOf)}`
			: `${clock(ev.start_min)} to ${zone ? endClock(ev, zoneOf) : clock(ev.end_min)}`;

		return (
			<Block
				key={ev.id}
				ev={ev}
				day={day}
				lanePx={lanePx}
				left={p.left}
				width={p.width}
				from={from}
				to={to}
				boardStart={boardStart}
				dragging={drag?.id === ev.id}
				dx={drag?.id === ev.id ? drag.dx : 0}
				resizing={resize?.id === ev.id}
				editing={preview?.id === ev.id}
				memberCount={members.length}
				shortName={shortName}
				didDrag={didDrag}
				onDown={onPointerDown}
				onMove={onPointerMove}
				onUp={onPointerUp}
				onCancel={cancelGesture}
				onOpen={openBlock}
				onFocus={focusOnMap}
				onGripDown={onResizeDown}
				onGripMove={onResizeMove}
				onGripUp={onResizeUp}
				hasLegAbove={legTargets.has(ev.id)}
				trim={trims.get(ev.id) ?? 0}
				locked={locked}
				cutTop={!seg.startsHere}
				cutBottom={!seg.endsHere}
				spanLabel={spanLabel}
				fullTime={fullTime}
				ariaTime={ariaTime}
				fixed={!onOneClock(ev, zoneOf)}
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
				key={laneKey(leg)}
				leg={leg}
				lanePx={lanePx}
				left={box.left}
				width={box.width}
				boardStart={boardStart}
				name={legName(leg, box.width * lanePx)}
				title={legTitle(leg)}
				editing={openLegId === leg.id}
				arrivalType={legArrivalType(leg)}
				onFocus={focusOnMap}
			/>
		);
	}

	/* The type of the event a journey arrives at, which the leg borrows as its
	   colour so the two read as one. Null when that event is not on the board
	   (view-as can hide it) or is free time, which no journey ever arrives at:
	   in either case there is nothing below the leg to match. */
	function legArrivalType(leg: LegRow): EventType | null {
		const to = eventById.get(leg.toEventId);
		return to && to.type !== 'freetime' ? to.type : null;
	}

	function legTitle(leg: LegRow): string {
		const from = eventById.get(leg.fromEventId)?.title ?? '?';
		const to = eventById.get(leg.toEventId)?.title ?? '?';
		// The warning is a sentence, so it is punctuated as one rather than hung
		// off a comma, and it is the same sentence the mark beside it carries.
		const tail = leg.tight
			? `. ${copy.viewAs.travelWarning}`
			: leg.manual
				? `, ${cs.journey.pinned}`
				: '';
		return `${from} to ${to}: ${modeLabel(leg.resolvedMode)}, ${leg.resolvedMins}m${tail}\n${peopleLabel(leg.people)}`;
	}

	function dayBoard(entry: BoardDay, opts: { lanePx: number; measure?: boolean }) {
		/* An empty day draws the calendar, not a graphic.
		 *
		 * It used to show the same drawn bug every other empty list in the app
		 * shows, which was wrong here for two reasons. A day with nothing on it
		 * is not an empty collection, it is a free day, and the hours are the
		 * answer to "when could this go": the grid is where you double-click to
		 * put something at four o'clock, and the graphic had nothing to click.
		 * The other reason arrived with the strip. Panels sit side by side, so a
		 * graphic a couple of hundred pixels tall next to a full day of hours
		 * made the board's height jump as it was scrolled, and an empty day read
		 * as having been scrolled off the end of the trip rather than as a day
		 * with a free morning.
		 *
		 * The agenda keeps its graphic, because a list of nothing really is
		 * nothing: there are no hours there to offer instead. */
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
		const segs = new Map(entry.events.map((e) => [e.id, segOf(e, entry.day)] as const));
		const segAt = (ev: EventRow) => segs.get(ev.id) ?? segOf(ev, entry.day);
		const byId = new Map(entry.events.map((e) => [e.id, e]));
		const legs = entry.legs.map((l) => {
			const to = byId.get(l.toEventId);
			if (!to) return l;
			const seg = segAt(to);
			return shiftLeg(l, startFor(to, seg) - seg.start);
		});

		const { layout: place, bars } = layoutBoard(
			entry.events.map((ev) => ({
				id: ev.id,
				// The stored times, not the dragged ones: re-laying out the columns
				// under the pointer would move every other block on the day while one
				// is being nudged. Read as this day's segment, so a span carried in
				// from yesterday takes a column from midnight and not from the hour
				// it began at on another day.
				start: segAt(ev).start,
				end: segAt(ev).end,
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

		/* Which events have a journey arriving on top of them, so their top-left
		   corner squares off to meet the leg's border. Read off the drawn bars,
		   which is exactly the set of legs the board is about to paint. */
		const legTargets = new Set(bars.map((b) => b.leg.toEventId));

		/* What each block gives up at the bottom so a journey leaving it stays
		   visible.
		 *
		 * Two events booked back to back leave no gap, so the journey between
		 * them has nowhere to be drawn: its floored box reaches back over the
		 * block it left, which paints on top of it, and the journey disappears
		 * entirely. A day that says two places are adjacent in space because
		 * they are adjacent on the clock is the one reading the board must not
		 * come away with, and it is exactly the day where the travel matters.
		 *
		 * So the block yields the pixels instead of the journey losing them. It
		 * is only ever the few the floor needs, the block keeps its real times in
		 * its label, and nothing moves on a day whose events have room between
		 * them. Measured against the drawn boxes rather than the clock, because
		 * the floor is a pixel rule, and only where the two overlap sideways: a
		 * journey in another column is not in front of this block at all. */
		const trims = new Map<string, number>();
		for (const bar of bars) {
			const bottom = topPx(bar.leg.endMin, boardStart);
			const top =
				bottom - Math.max(heightPx(bar.leg.startMin, bar.leg.endMin, boardStart), MIN_LEG_H);
			for (const ev of entry.events) {
				const p = place.placed.get(ev.id);
				if (!p || p.left >= bar.left + bar.width || bar.left >= p.left + p.width) continue;
				const seg = segAt(ev);
				// A block that carries on into tomorrow keeps its whole bottom edge:
				// that edge is midnight, and lifting it would read as an ending.
				if (!seg.endsHere) continue;
				const over =
					Math.min(topPx(endFor(ev, seg), boardStart), bottom) -
					Math.max(topPx(startFor(ev, seg), boardStart), top);
				if (over > 0) trims.set(ev.id, Math.max(trims.get(ev.id) ?? 0, over));
			}
		}

		return (
			<div
				className={`daygrid${drag ? ' still' : ''}${drag && openedBy > 0 ? ' opening' : ''}`}
				style={{ height: `${(DAY_END - boardStart) * PX_PER_MIN + GRID_TAIL_PX}px` }}
			>
				<Axis boardStart={boardStart} labels={false} />

				<div
					className="lane"
					ref={opts.measure ? laneRef : undefined}
					onDoubleClick={(e) => {
						// A double click on empty track is "put something here". On a
						// block it is not: blocks have their own dialogs, and opening a
						// second one over the top would be a trap.
						if (locked || (e.target as HTMLElement).closest('.block')) return;
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
							? blockNode(it.ev, entry.day, opts.lanePx, place, legTargets, trims)
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

	/* A span is listed on every day it covers. Where it begins it reads as the
	   whole range, so the one row says when it ends; on the days after, it
	   reads as the part of it on that day, and has no start of its own to put
	   in the time column.

	   The day under the reader, as the stepper names it, rather than the url's:
	   the two differ only between an arrow and its payload, and a list still on
	   yesterday under a title already on today is the mismatch this avoids. */
	const listed = reading ?? anchor;
	const agenda = [
		...(listed?.events ?? []).map((ev) => {
			const seg = segOf(ev, listed!.day);
			const part = seg.startsHere ? null : segmentTime(ev, seg, zoneOf);
			return {
				key: ev.id,
				start: seg.start,
				/* The start as it is on this day's clock. A part carried in from
				   yesterday has none, and nor does a journey west drawn on its
				   arrival clock, whose departure is on another; the meta line
				   carries the whole of either. */
				when: seg.startsHere && seg.start === ev.start_min ? clock(seg.start) : '',
				title: ev.title,
				/* The start is already in the time column when it is there, so a
				   one-day block says only when it ends; a span or a part of one
				   keeps its whole range, which no column holds. */
				meta: `${typeLabel(ev.type)} · ${
					part ??
					(seg.startsHere && seg.endsHere && seg.start === ev.start_min
						? cs.span.until(endClock(ev, zoneOf))
						: spanRange(ev, zoneOf))
				}`,
				tight: false,
				open: () => openBlock(ev.id)
			};
		}),
		...(listed?.legs ?? []).map((leg) => ({
			key: laneKey(leg),
			start: leg.startMin,
			when: clock(leg.startMin),
			title: agendaLegName(leg),
			// The mode is in the name unless somebody named the journey.
			meta: leg.title
				? `${modeLabel(leg.resolvedMode)} · ${cs.journey.estimate(leg.resolvedMins)}`
				: cs.journey.estimate(leg.resolvedMins),
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
								<span className="agendawhen">{row.when}</span>
								<span className="agendawhat">
									<span className="agendatitle">{row.title}</span>
									{/* Said in words under the name, not left to a triangle's
									    tooltip: a tooltip is a hover, and the phone this list
									    is most read on has none. */}
									{row.tight && (
										<span className="agendawarn">
											<WarningIcon />
											{copy.viewAs.travelWarning}
										</span>
									)}
								</span>
								<span className="agendameta">{row.meta}</span>
							</button>
						</li>
					))}
				</ul>
			</div>
		);
	}

	return (
		<div className={locked ? 'sched locked' : 'sched'} ref={rootRef}>
			<Toolbar
				view={view}
				day={data.day}
				memberCount={members.length}
				readAs={readAs}
				viewAsOptions={viewAsOptions}
				onViewAs={setViewAs}
				onAdd={addHere}
				locked={locked}
			/>

			<div className="split">
				<div className="boardcol">
					<div className="board card" ref={boardRef}>
						<BoardHead
							label={dayLabel(reading?.day ?? data.day)}
							view={view}
							day={reading?.day ?? data.day}
							first={data.firstDay}
							last={data.lastDay}
							prev={dayStep(-1)}
							next={dayStep(1)}
							onStep={stepTo}
						/>
						{reading && stayBands(reading)}
						{anchor ? (
							/* The board's viewport, whichever board is in it. The stepper and
							   the lodging band are outside it on purpose: they name the day,
							   so they stay while the day scrolls. The agenda used to be left
							   out of it, on the reasoning that a list that short did not need
							   a box; a full day of a busy trip is forty rows, and the agenda
							   then scrolled the title and the stepper off the top exactly as
							   the hours used to. It is the same box because it is the same
							   complaint, and `max-height` costs a short day nothing: no
							   overflow, no scrollbar.

							   It scrolls both ways now. Sideways it is a strip of whole days
							   that snaps to one at a time, which is what lets a block be
							   dragged onto another date and what makes the day step a
							   movement rather than a redraw. */
							<div
								className={
									view === 'agenda' ? 'boardscroll list' : `boardscroll${drag ? ' held' : ''}`
								}
								ref={scrollRef}
								style={viewH ? { maxHeight: `${viewH}px` } : undefined}
							>
								{view === 'agenda' ? (
									<div ref={agendaRef}>{agendaBoard()}</div>
								) : (
									<>
										{/* The time column. One for the whole strip, standing
										    still at the left of the box while the days slide
										    past it, and scrolling with them up and down because
										    it is in the same scroller: the hours are the one
										    thing on the board that is the same on every day,
										    and a gutter that travelled with each panel moved
										    the clock sideways on every step. Its height and its
										    rules are the panels' own, from the same origin, so
										    a label sits on its rule at every scroll.

										    A child of the box itself, not of the strip. A sticky
										    element can only travel inside its parent, and the
										    strip is one box wide: inside it, the column was
										    carried off with the strip past the first day. */}
										<div
											className={`timecol${drag ? ' still' : ''}`}
											style={{
												height: `${(DAY_END - boardStart) * PX_PER_MIN + GRID_TAIL_PX}px`
											}}
										>
											<Axis boardStart={boardStart} labels />
										</div>
										<div className="daytrack">
											{board.map((entry) => (
												<div
													className="daypanel"
													key={entry.day}
													data-day={entry.day}
													/* The days either side are drawn but not read. They are
												   off screen, so a reader who can see the board is
												   looking at one day; a reader who cannot was being
												   handed three days of blocks as one unbroken list,
												   with yesterday's events announced as today's. `inert`
												   is what says that: it takes the panel out of the
												   accessibility tree and out of the tab order together,
												   where `aria-hidden` alone would have left focusable
												   buttons inside a hidden subtree.

												   Lifted for the length of a drag. A block being carried
												   across dates travels with its own panel, and that
												   panel stops being the one being read the moment the
												   strip passes the halfway point: made inert under the
												   hand holding it, the gesture would die mid-air. */
													inert={!drag && entry.day !== (reading?.day ?? data.day)}
												>
													{dayBoard(entry, {
														lanePx: laneW || 560,
														// One panel is measured, and they are all the same
														// width: a second observer on a strip that
														// re-indexes would report the same number twice and
														// re-render the board for it.
														measure: entry.day === data.day
													})}
												</div>
											))}
										</div>
									</>
								)}
							</div>
						) : null}
					</div>
				</div>

				{mapPanel}
			</div>

			{adding && (
				<EventDialog
					base={base}
					event={null}
					day={adding.day}
					startMin={adding.start}
					suggestedStart={suggestedStart}
					initialType={adding.type}
					initialPoi={adding.poi}
					legs={draftLegs}
					liveLegs={draftLive}
					eventOf={(id) => eventById.get(id) ?? null}
					peopleLabel={peopleLabel}
					memberOptions={memberOptions}
					crews={data.crews}
					saved={data.saved}
					stays={data.stays}
					cities={data.cities}
					cityId={cityOfDay(adding.day)}
					cityOf={cityOfDay}
					firstDay={data.firstDay}
					lastDay={data.lastDay}
					provider={data.provider}
					// A lock that arrives while a block is being described turns the
					// dialog into a view of what was typed, with nothing to save,
					// rather than letting it fail at the Add button.
					locked={locked}
					dock={dockSide}
					peek={roomToDock}
					onPreview={setPreview}
					onJourneyPreview={previewLegs}
					onClose={() => setAdding(null)}
					onDone={() => {
						setAdding(null);
						reloadMine();
					}}
				/>
			)}

			{opened && (
				<EventDialog
					key={opened.id}
					base={base}
					event={opened}
					day={opened.day}
					legs={openLegs}
					liveLegs={openLive}
					focusLegId={openLegId}
					eventOf={(id) => eventById.get(id) ?? null}
					peopleLabel={peopleLabel}
					memberOptions={memberOptions}
					crews={data.crews}
					saved={data.saved}
					stays={data.stays}
					cities={data.cities}
					cityId={opened.city_id ?? cityOfDay(opened.day)}
					firstDay={data.firstDay}
					lastDay={data.lastDay}
					provider={data.provider}
					locked={locked}
					dock={dockSide}
					peek={roomToDock}
					onPreview={setPreview}
					onJourneyPreview={previewLegs}
					onClose={closeEvent}
					onDone={() => {
						closeEvent();
						reloadMine();
					}}
				/>
			)}
		</div>
	);
}
