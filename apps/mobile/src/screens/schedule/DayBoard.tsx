import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ElementRef } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import {
	Gesture,
	GestureDetector,
	ScrollView as GestureScrollView
} from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { copy } from '@trippy/copy';
import { segmentOn, type Segment, type ZoneOf } from '@trippy/core/span';
import { layoutBoard, legLaneId } from '@trippy/core/travel';
import type { EventType } from '@trippy/core/types';
import { api, ApiError } from '../../lib/api';
import { color, radius, space, type } from '../../theme';
import { useToast } from '../../ui/Toast';
import { setInteractionBusy } from '../../ui/busy';
import { AppSymbol } from '../../ui/Symbol';
import { DaySlide } from '../../ui/DaySlide';
import {
	DAY_END,
	DEFAULT_START,
	MIN_EVENT_MINS,
	PX_PER_MIN,
	clock,
	heightPx,
	hourLabel,
	hoursFrom,
	modeLabel,
	segmentTime,
	topPx,
	windowStart
} from './shared';
import {
	boardGestures,
	gripHeightForBlock,
	passedGestureSlop,
	snapMoveStart,
	snapResizeEnd
} from './gesture';
import type { BoardDay, EventRow, LegRow } from './types';
import { PAD_LEFT, PAD_RIGHT, SMALL_LINE, TITLE_LINE, blockFit, type BlockFit } from './blockFit';

const GUTTER = 58;
const LANE_MIN = 104;
const GAP = 6;
const MIN_LEG_H = 15;
const GESTURE_MS = 400;
const WRITE_SLOP = 3;

const EVENT_COLORS: Record<EventType, string> = {
	activity: '#2f7a4f',
	food: '#c15a25',
	stay: '#7b4fa6',
	travel: '#2f6d9e',
	freetime: '#6b5bd2'
};

/**
 * The block's fill: its type colour at 10% over white, the web's
 * `color-mix(in srgb, var(--c) 10%, white)`. Every block had been the same
 * mint whatever its type, so a day read as one wash with coloured edges rather
 * than the web's scannable colour per type.
 */
function tint(hex: string, amount = 0.1): string {
	const n = parseInt(hex.slice(1), 16);
	const mix = (c: number) => Math.round(c * amount + 255 * (1 - amount));
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix);
	return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
const EVENT_FILLS = Object.fromEntries(
	Object.entries(EVENT_COLORS).map(([key, value]) => [key, tint(value)])
) as Record<EventType, string>;

type ActiveLabel = { id: string; kind: 'move' | 'resize'; minute: number } | null;

export function DayBoard({
	base,
	entry,
	saved,
	ownWrite,
	memberIds,
	peopleLabel,
	eventById,
	zoneOf,
	locked,
	floor,
	onFloor,
	onOpen,
	onGestureChange,
	onReload
}: {
	base: string;
	entry: BoardDay;
	/**
	 * The same day as saved: `entry` without the open sheet's draft. Only this
	 * feeds `floor`; see the window below.
	 */
	saved: BoardDay;
	/**
	 * The saved data is the payload that follows the reader's own save from the
	 * sheet: the floor may drop, but the scroll is not offset.
	 */
	ownWrite: boolean;
	memberIds: string[];
	peopleLabel: (ids: string[]) => string;
	eventById: Map<string, EventRow>;
	zoneOf: ZoneOf;
	locked: boolean;
	/**
	 * The earliest the board has opened on this trip, held by the screen so it
	 * outlives a trip to the agenda and back. null before the board has drawn.
	 */
	floor: number | null;
	onFloor: (min: number) => void;
	onOpen: (id: string) => void;
	onGestureChange: (active: boolean) => void;
	onReload: () => void;
}) {
	const toast = useToast();
	const { width } = useWindowDimensions();
	const [boardOuterW, setBoardOuterW] = useState(Math.max(width - space.lg * 2, 1));
	const [activeLabel, setActiveLabel] = useState<ActiveLabel>(null);
	const [pending, setPending] = useState<{ id: string; start?: number; end?: number } | null>(null);
	const [gestureActive, setGestureActive] = useState(false);
	const releaseBusy = useRef<(() => void) | null>(null);
	const scrollRef = useRef<ElementRef<typeof GestureScrollView> | null>(null);
	// Where the board is scrolled to, kept from its scroll events so the window
	// opening earlier can push it down by exactly what was added above.
	const scrollY = useRef(0);

	useEffect(() => {
		setPending(null);
	}, [entry]);

	useEffect(() => {
		onGestureChange(gestureActive);
		if (gestureActive && !releaseBusy.current) releaseBusy.current = setInteractionBusy(true);
		if (!gestureActive) {
			releaseBusy.current?.();
			releaseBusy.current = null;
		}
		return () => {
			releaseBusy.current?.();
			releaseBusy.current = null;
		};
	}, [gestureActive, onGestureChange]);

	useEffect(
		() => () => {
			releaseBusy.current?.();
			releaseBusy.current = null;
			onGestureChange(false);
		},
		[onGestureChange]
	);

	/*
	 * Where each event sits on this day, from the shared span rules: an event
	 * that runs past midnight is drawn to the bottom of its first day, through
	 * any day between, and from the top of its last. Nothing below reads
	 * `start_min` or `end_min` for placement, so a block, the window, the lanes
	 * and the journey bars all agree with the web board and the planner.
	 */
	const segments = useMemo(() => {
		const out = new Map<string, Segment>();
		for (const event of entry.events) {
			const seg = segmentOn(event, entry.day, zoneOf);
			if (seg) out.set(event.id, seg);
		}
		return out;
	}, [entry, zoneOf]);
	const drawn = useMemo(
		() => entry.events.filter((event) => segments.has(event.id)),
		[entry.events, segments]
	);
	const segStart = (event: EventRow) => segments.get(event.id)?.start ?? event.start_min;
	const segEnd = (event: EventRow) => segments.get(event.id)?.end ?? event.end_min;

	const baseStartFor = (event: EventRow) =>
		pending?.id === event.id && pending.start != null ? pending.start : segStart(event);
	const baseEndFor = (event: EventRow) =>
		pending?.id === event.id && pending.end != null ? pending.end : segEnd(event);

	/*
	 * The hour the board opens at.
	 *
	 * Each day used to open at its own earliest hour (6 AM at the latest), so a
	 * step from a 9 AM day to one with a 5 AM run moved every hour line on the
	 * board, and the step back moved them again. The board now draws from a
	 * floor: the earliest any saved day has opened at on this visit (`floor`,
	 * held by the screen), lowered by this day's saved start (`savedStart`) and
	 * never raised. Only saved data feeds it: a step, a live reload, a change of
	 * who the board is read for.
	 *
	 * The reader's own unsaved times, the sheet's draft in `entry` and a drop
	 * still waiting on its write (`pending`), can open the window further for as
	 * long as they stand (`dayStart`), as they always could, but they do not move
	 * the floor: a 4:40 picked in the sheet and cancelled used to leave the board
	 * open from 4 AM for the rest of the visit.
	 */
	const savedStart = useMemo(() => {
		const mins: number[] = [];
		for (const event of saved.events) {
			const seg = segmentOn(event, saved.day, zoneOf);
			if (seg) mins.push(seg.start, seg.end);
		}
		for (const leg of saved.legs) mins.push(leg.startMin, leg.endMin);
		return windowStart(mins.length ? mins : [DEFAULT_START]);
	}, [saved, zoneOf]);
	const savedFloor = floor == null ? savedStart : Math.min(floor, savedStart);
	useEffect(() => {
		if (floor == null || savedStart < floor) onFloor(savedStart);
	}, [floor, onFloor, savedStart]);
	const dayStart = useMemo(() => {
		const mins = [
			...drawn.flatMap((event) => [baseStartFor(event), baseEndFor(event)]),
			...entry.legs.flatMap((leg) => [leg.startMin, leg.endMin])
		];
		return windowStart(mins.length ? mins : [DEFAULT_START]);
	}, [drawn, entry, pending, segments]);
	const boardStart = Math.min(savedFloor, dayStart);

	const { layout, bars } = useMemo(() => {
		const eventsForLayout = drawn.map((event) => ({
			id: event.id,
			start: segStart(event),
			end: segEnd(event),
			people: event.people.length ? event.people : memberIds
		}));
		const shiftedLegs = entry.legs.map((leg) => {
			const to = drawn.find((event) => event.id === leg.toEventId);
			return to ? shiftLeg(leg, baseStartFor(to) - segStart(to)) : leg;
		});
		return layoutBoard(eventsForLayout, shiftedLegs);
	}, [drawn, entry, memberIds, pending, segments]);

	const maxCols = Math.max(1, ...[...layout.placed.values()].map((placed) => placed.cols));
	// The lanes' visible width, beside the fixed hour gutter, and the width they
	// are drawn at, which scrolls sideways when a day needs more lanes than fit.
	const laneOuterW = Math.max(1, boardOuterW - GUTTER);
	const laneW = Math.max(laneOuterW, maxCols * LANE_MIN);
	const contentH = (DAY_END - boardStart) * PX_PER_MIN + 24;

	/*
	 * Seat the board on its first block, once, when it first appears: the
	 * screen opening, or a switch from the agenda to the day. A day step, the
	 * date picker and a live reload leave the scroll where the reader put it.
	 * The seat used to run on every day change, which with the window moving as
	 * well made the hours jump up and down on every step.
	 */
	useEffect(() => {
		const starts = [
			...drawn.map((event) => baseStartFor(event)),
			...entry.legs.map((leg) => leg.startMin)
		];
		const first = starts.length ? Math.min(...starts) : DEFAULT_START;
		const timer = setTimeout(() => {
			const y = Math.max(0, topPx(first, boardStart) - 80);
			scrollY.current = y;
			scrollRef.current?.scrollTo({ y, animated: false });
		}, 0);
		return () => clearTimeout(timer);
		// First arrival only; see above.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/*
	 * When the floor drops, everything below the new hours is drawn lower by
	 * the time added, so the scroll moves down by the same amount in the same
	 * commit, before paint: what was at the top of the board stays there. Only
	 * a drop of the floor does this, and not one that comes from the reader's
	 * own write. The window opening for the reader's own draft or drop is not
	 * offset (as on the web board), and when the floor drops to where a draft
	 * or drop had already opened it, nothing moves, so nothing is offset. A
	 * save from the sheet is held on the board until its payload lands
	 * (`useScheduleDay`), and that payload is `ownWrite`, so the block the
	 * reader just placed stays where they placed it.
	 */
	const shown = useRef<{ floor: number; start: number } | null>(null);
	useLayoutEffect(() => {
		const was = shown.current;
		shown.current = { floor: savedFloor, start: boardStart };
		if (!was || ownWrite || savedFloor >= was.floor || boardStart >= was.start) return;
		const y = scrollY.current + (was.start - boardStart) * PX_PER_MIN;
		scrollY.current = y;
		scrollRef.current?.scrollTo({ y, animated: false });
		// `ownWrite` is read as it stands when the floor moves, not a trigger.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [boardStart, savedFloor]);

	const trims = new Map<string, number>();
	for (const bar of bars) {
		const bottom = topPx(bar.leg.endMin, boardStart);
		const top =
			bottom - Math.max(heightPx(bar.leg.startMin, bar.leg.endMin, boardStart), MIN_LEG_H);
		for (const event of drawn) {
			const placed = layout.placed.get(event.id);
			if (!placed || placed.left >= bar.left + bar.width || bar.left >= placed.left + placed.width)
				continue;
			const over =
				Math.min(topPx(baseEndFor(event), boardStart), bottom) -
				Math.max(topPx(baseStartFor(event), boardStart), top);
			if (over > 0) trims.set(event.id, Math.max(trims.get(event.id) ?? 0, over));
		}
	}

	/*
	 * How much of each journey bar's top a block still covers. A block trimmed
	 * below its least height is held at `MIN_LEG_H` so its title stays whole,
	 * and blocks draw over bars, so the bar under it loses that much of its top.
	 * The bar then draws only what fits whole in the rest (`LegBar`) rather
	 * than a line with its top half under the block.
	 */
	const covers = new Map<string, number>();
	for (const bar of bars) {
		const bottom = topPx(bar.leg.endMin, boardStart);
		const top =
			bottom - Math.max(heightPx(bar.leg.startMin, bar.leg.endMin, boardStart), MIN_LEG_H);
		for (const event of drawn) {
			const placed = layout.placed.get(event.id);
			if (!placed || placed.left >= bar.left + bar.width || bar.left >= placed.left + placed.width)
				continue;
			const from = topPx(baseStartFor(event), boardStart);
			const to =
				from +
				Math.max(
					MIN_LEG_H,
					heightPx(baseStartFor(event), baseEndFor(event), boardStart) - (trims.get(event.id) ?? 0)
				);
			if (from > top + 0.5 || to <= top) continue;
			const id = legLaneId(bar.leg);
			covers.set(id, Math.max(covers.get(id) ?? 0, Math.min(to, bottom) - top));
		}
	}

	const beginGesture = useCallback(() => setGestureActive(true), []);
	const endGesture = useCallback(() => {
		setGestureActive(false);
		setActiveLabel(null);
	}, []);
	const reportMinute = useCallback((label: ActiveLabel) => setActiveLabel(label), []);

	const writeMove = useCallback(
		async (event: EventRow, startMin: number) => {
			if (startMin === event.start_min) return;
			setPending({ id: event.id, start: startMin });
			try {
				await api(`${base}/events/${event.id}/op`, {
					method: 'POST',
					body: { op: 'move', startMin, day: entry.day }
				});
				onReload();
			} catch (err) {
				setPending(null);
				toast.error(err instanceof ApiError ? err.message : copy.api.saveFallback);
			}
		},
		[base, entry.day, onReload, toast]
	);

	const writeResize = useCallback(
		async (event: EventRow, endMin: number) => {
			if (endMin === event.end_min) return;
			setPending({ id: event.id, end: endMin });
			try {
				await api(`${base}/events/${event.id}/op`, {
					method: 'POST',
					body: { op: 'resize', endMin }
				});
				onReload();
			} catch (err) {
				setPending(null);
				toast.error(err instanceof ApiError ? err.message : copy.api.saveFallback);
			}
		},
		[base, onReload, toast]
	);
	const openBlock = useCallback((id: string) => onOpen(id), [onOpen]);
	const commitMove = useCallback(
		(id: string, minute: number) => {
			const event = entry.events.find((row) => row.id === id);
			if (event) void writeMove(event, minute);
		},
		[entry.events, writeMove]
	);
	const commitResize = useCallback(
		(id: string, minute: number) => {
			const event = entry.events.find((row) => row.id === id);
			if (event) void writeResize(event, minute);
		},
		[entry.events, writeResize]
	);

	return (
		<View onLayout={(event) => setBoardOuterW(Math.max(1, event.nativeEvent.layout.width))}>
			<GestureScrollView
				ref={scrollRef}
				scrollEnabled={!gestureActive}
				nestedScrollEnabled
				onScroll={(event) => {
					scrollY.current = event.nativeEvent.contentOffset.y;
				}}
				scrollEventThrottle={16}
				style={{ maxHeight: 620 }}
				contentContainerStyle={{ paddingBottom: space.md }}
			>
				{/*
				 * The time axis is fixed: the hour labels sit in their own gutter
				 * and the hour lines span the visible lanes, both outside the
				 * sideways scroller and outside the day's slide. Only the day's
				 * blocks and journeys scroll sideways and slide on a step, as in
				 * Calendar. The gutter used to scroll with the lanes, so a reader
				 * who had scrolled a wide day sideways lost the hours off the left,
				 * and a step to a narrower day jumped them back by a lane or two.
				 */}
				<View style={{ flexDirection: 'row', height: contentH }}>
					<View style={{ width: GUTTER, height: contentH }}>
						{hoursFrom(boardStart).map((hour) => (
							<Text
								key={hour}
								style={{
									...type.faint,
									position: 'absolute',
									left: 0,
									top: topPx(hour * 60, boardStart),
									width: GUTTER - 8
								}}
							>
								{hourLabel(hour)}
							</Text>
						))}
					</View>
					<View style={{ flex: 1, height: contentH }}>
						{hoursFrom(boardStart).map((hour) => (
							<View
								key={hour}
								style={{
									position: 'absolute',
									left: 0,
									right: 0,
									top: topPx(hour * 60, boardStart) + 8,
									borderTopWidth: 1,
									borderTopColor: color.line
								}}
							/>
						))}
						<GestureScrollView
							horizontal
							scrollEnabled={!gestureActive}
							nestedScrollEnabled
							showsHorizontalScrollIndicator={laneW > laneOuterW}
							style={{ height: contentH }}
						>
							{/* Clipped, so the slide's offset never widens what scrolls. */}
							<View style={{ width: laneW, height: contentH, overflow: 'hidden' }}>
								<DaySlide
									day={entry.day}
									style={{
										position: 'absolute',
										left: 0,
										top: 0,
										width: laneW,
										height: contentH,
										pointerEvents: 'box-none'
									}}
								>
									{bars.map((bar) => (
										<LegBar
											key={legLaneId(bar.leg)}
											leg={bar.leg}
											from={eventById.get(bar.leg.fromEventId)}
											left={bar.left * laneW}
											width={Math.max(32, bar.width * laneW - GAP)}
											boardStart={boardStart}
											covered={covers.get(legLaneId(bar.leg)) ?? 0}
											peopleLabel={peopleLabel}
										/>
									))}
									{drawn.map((event) => {
										const placed = layout.placed.get(event.id);
										const seg = segments.get(event.id);
										if (!placed || !seg) return null;
										const drawnStart = baseStartFor(event);
										const drawnEnd = baseEndFor(event);
										const trimmedHeight =
											heightPx(drawnStart, drawnEnd, boardStart) - (trims.get(event.id) ?? 0);
										const can = boardGestures(event, seg, zoneOf);
										const when = segmentTime(event, seg, zoneOf);
										return (
											<EventBlock
												key={event.id}
												event={event}
												left={placed.left * laneW}
												width={Math.max(44, placed.width * laneW - GAP)}
												top={topPx(drawnStart, boardStart)}
												height={Math.max(MIN_LEG_H, trimmedHeight)}
												drawnStart={drawnStart}
												drawnEnd={drawnEnd}
												length={Math.max(MIN_EVENT_MINS, seg.end - seg.start)}
												startsHere={seg.startsHere}
												endsHere={seg.endsHere}
												timeWords={when.words}
												timeZone={when.zone}
												canMove={can.move}
												canResize={can.resize}
												peopleLabel={peopleLabel}
												locked={locked}
												onOpen={openBlock}
												onBeginGesture={beginGesture}
												onEndGesture={endGesture}
												onReportMinute={reportMinute}
												onCommitMove={commitMove}
												onCommitResize={commitResize}
											/>
										);
									})}
									{activeLabel ? (
										<TimeBadge
											left={0}
											top={
												activeLabel.kind === 'move'
													? topPx(activeLabel.minute, boardStart) - 22
													: topPx(activeLabel.minute, boardStart) + 4
											}
											minute={activeLabel.minute}
										/>
									) : null}
									{pending?.start != null ? (
										<TimeBadge
											left={0}
											top={topPx(pending.start, boardStart) - 22}
											minute={pending.start}
										/>
									) : null}
									{pending?.end != null ? (
										<TimeBadge
											left={0}
											top={topPx(pending.end, boardStart) + 4}
											minute={pending.end}
										/>
									) : null}
								</DaySlide>
							</View>
						</GestureScrollView>
					</View>
				</View>
			</GestureScrollView>
		</View>
	);
}

function shiftLeg(leg: LegRow, by: number): LegRow {
	return by ? { ...leg, startMin: leg.startMin + by, endMin: leg.endMin + by } : leg;
}

const EventBlock = memo(function EventBlock({
	event,
	left,
	width,
	top,
	height,
	peopleLabel,
	locked,
	onOpen,
	onBeginGesture,
	onEndGesture,
	onReportMinute,
	onCommitMove,
	onCommitResize,
	drawnStart,
	drawnEnd,
	length,
	startsHere,
	endsHere,
	timeWords,
	timeZone,
	canMove,
	canResize
}: {
	event: EventRow;
	left: number;
	width: number;
	top: number;
	height: number;
	peopleLabel: (ids: string[]) => string;
	locked: boolean;
	onOpen: (id: string) => void;
	onBeginGesture: () => void;
	onEndGesture: () => void;
	onReportMinute: (label: ActiveLabel) => void;
	onCommitMove: (id: string, minute: number) => void;
	onCommitResize: (id: string, minute: number) => void;
	drawnStart: number;
	drawnEnd: number;
	/** The block's drawn length, which a move keeps. */
	length: number;
	/** The event begins on this day; false squares the top corners off. */
	startsHere: boolean;
	/** The event ends on this day; false squares the bottom corners off. */
	endsHere: boolean;
	/** "9:00 - 11:00 AM", or "From 10:00 PM", "All day", "Until 3:00 PM" on a multi-day event. */
	timeWords: string;
	/** The arrival zone beside the end time, when a journey lands on another clock. */
	timeZone: string | null;
	canMove: boolean;
	canResize: boolean;
}) {
	const translateY = useSharedValue(0);
	const extraH = useSharedValue(0);
	const moved = useSharedValue(false);
	const panStarted = useSharedValue(false);
	const lastMoveMinute = useSharedValue(event.start_min);
	const lastEndMinute = useSharedValue(event.end_min);

	useLayoutEffect(() => {
		translateY.value = 0;
		extraH.value = 0;
		lastMoveMinute.value = drawnStart;
		lastEndMinute.value = drawnEnd;
		moved.value = false;
		panStarted.value = false;
	}, [drawnStart, drawnEnd, extraH, lastEndMinute, lastMoveMinute, moved, panStarted, translateY]);
	const gripHeight = gripHeightForBlock(height);

	const tapGesture = useMemo(
		() =>
			Gesture.Tap()
				.maxDuration(GESTURE_MS - 10)
				.onEnd((_event, success) => {
					if (success) runOnJS(onOpen)(event.id);
				}),
		[event.id, onOpen]
	);

	const moveGesture = useMemo(
		() =>
			Gesture.Pan()
				.enabled(!locked)
				.activateAfterLongPress(GESTURE_MS)
				.onBegin(() => {
					panStarted.value = false;
					moved.value = false;
					lastMoveMinute.value = event.start_min;
					translateY.value = 0;
				})
				.onStart(() => {
					panStarted.value = true;
					runOnJS(onBeginGesture)();
				})
				.onUpdate((gesture) => {
					if (!moved.value && !passedGestureSlop(gesture.translationY, WRITE_SLOP)) return;
					moved.value = true;
					const next = snapMoveStart(event.start_min, gesture.translationY, length);
					translateY.value = (next - event.start_min) * PX_PER_MIN;
					if (next !== lastMoveMinute.value) {
						lastMoveMinute.value = next;
						runOnJS(onReportMinute)({ id: event.id, kind: 'move', minute: next });
					}
				})
				.onEnd((_event, success) => {
					const next = lastMoveMinute.value;
					if (success && moved.value && next !== event.start_min) {
						runOnJS(onCommitMove)(event.id, next);
					}
				})
				.onFinalize((_event, success) => {
					if (!success) translateY.value = 0;
					if (panStarted.value) runOnJS(onEndGesture)();
					panStarted.value = false;
				}),
		[
			event.id,
			event.start_min,
			lastMoveMinute,
			length,
			locked,
			moved,
			onBeginGesture,
			onCommitMove,
			onEndGesture,
			onReportMinute,
			panStarted,
			translateY
		]
	);

	const movable = !locked && canMove;
	const resizable = !locked && canResize;
	const blockGesture = useMemo(
		() => (movable ? Gesture.Exclusive(moveGesture, tapGesture) : tapGesture),
		[movable, moveGesture, tapGesture]
	);

	const resizePan = useMemo(
		() =>
			Gesture.Pan()
				.enabled(!locked)
				.activateAfterLongPress(GESTURE_MS)
				.onBegin(() => {
					panStarted.value = false;
					moved.value = false;
					lastEndMinute.value = event.end_min;
					extraH.value = 0;
				})
				.onStart(() => {
					panStarted.value = true;
					runOnJS(onBeginGesture)();
				})
				.onUpdate((gesture) => {
					if (!moved.value && !passedGestureSlop(gesture.translationY, WRITE_SLOP)) return;
					moved.value = true;
					const next = snapResizeEnd(event.end_min, gesture.translationY, event.start_min);
					extraH.value = (next - event.end_min) * PX_PER_MIN;
					if (next !== lastEndMinute.value) {
						lastEndMinute.value = next;
						runOnJS(onReportMinute)({ id: event.id, kind: 'resize', minute: next });
					}
				})
				.onEnd((_event, success) => {
					const next = lastEndMinute.value;
					if (success && moved.value && next !== event.end_min) {
						runOnJS(onCommitResize)(event.id, next);
					}
				})
				.onFinalize((_event, success) => {
					if (!success) extraH.value = 0;
					if (panStarted.value) runOnJS(onEndGesture)();
					panStarted.value = false;
				}),
		[
			event.end_min,
			event.id,
			event.start_min,
			extraH,
			lastEndMinute,
			locked,
			moved,
			onBeginGesture,
			onCommitResize,
			onEndGesture,
			onReportMinute,
			panStarted
		]
	);

	const gripTap = useMemo(
		() =>
			Gesture.Tap()
				.maxDuration(GESTURE_MS - 10)
				.onEnd((_event, success) => {
					if (success) runOnJS(onOpen)(event.id);
				}),
		[event.id, onOpen]
	);

	const resizeGesture = useMemo(() => Gesture.Exclusive(resizePan, gripTap), [gripTap, resizePan]);

	const blockStyle = useAnimatedStyle(() => ({
		transform: [{ translateY: translateY.value }],
		height: Math.max(MIN_LEG_H, height + extraH.value)
	}));

	const timeText = timeZone ? `${timeWords} ${timeZone}` : timeWords;
	const fit = blockFit(height, width, event.title, timeText);
	const accessibilityLabel = `${event.title}, ${timeText}. ${movable ? copy.schedule.block.mobileOpenLabel : copy.schedule.block.openLabel}`;
	// Like Calendar, a part cut at midnight has square corners on the cut edge,
	// so a block reads as carrying on from the day before or into the next.
	const corners = {
		borderTopLeftRadius: startsHere ? radius.md : 0,
		borderTopRightRadius: startsHere ? radius.md : 0,
		borderBottomLeftRadius: endsHere ? radius.md : 0,
		borderBottomRightRadius: endsHere ? radius.md : 0
	};

	return (
		<View testID={`block:${event.id}`} style={{ position: 'absolute', left, top, width, height }}>
			<GestureDetector gesture={blockGesture}>
				<Animated.View
					accessible
					accessibilityRole="button"
					accessibilityLabel={accessibilityLabel}
					style={[
						{
							width,
							height,
							minHeight: MIN_LEG_H,
							...corners,
							backgroundColor: EVENT_FILLS[event.type],
							paddingLeft: PAD_LEFT,
							paddingRight: PAD_RIGHT,
							overflow: 'hidden'
						},
						blockStyle
					]}
				>
					<BlockText
						fit={fit}
						title={event.title}
						timeWords={timeWords}
						timeZone={timeZone}
						people={peopleLabel(event.people)}
					/>
					<View
						style={{
							position: 'absolute',
							left: 0,
							top: 0,
							bottom: 0,
							width: 3,
							backgroundColor: EVENT_COLORS[event.type]
						}}
					/>
				</Animated.View>
			</GestureDetector>
			{resizable ? (
				<GestureDetector gesture={resizeGesture}>
					<Animated.View
						accessible
						accessibilityRole="adjustable"
						accessibilityLabel={copy.schedule.block.resizeLabel}
						accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
						onAccessibilityAction={(action) => {
							const next =
								action.nativeEvent.actionName === 'increment'
									? Math.min(DAY_END, event.end_min + 5)
									: Math.max(event.start_min + MIN_EVENT_MINS, event.end_min - 5);
							onCommitResize(event.id, next);
						}}
						style={{
							position: 'absolute',
							left: 0,
							right: 0,
							bottom: 0,
							height: gripHeight,
							alignItems: 'center',
							justifyContent: 'flex-end',
							paddingBottom: 3
						}}
					>
						<View
							style={{
								width: 24,
								height: 3,
								borderRadius: 2,
								backgroundColor: EVENT_COLORS[event.type],
								// Not drawn across a one-line block's words; the grip still works.
								opacity: fit.kind === 'stack' ? 0.4 : 0
							}}
						/>
					</Animated.View>
				</GestureDetector>
			) : null}
		</View>
	);
});
EventBlock.displayName = 'EventBlock';

const titleStyle = {
	color: color.ink,
	fontWeight: '700',
	fontSize: 12,
	lineHeight: TITLE_LINE
} as const;
const smallStyle = { color: color.inkSoft, fontSize: 10, lineHeight: SMALL_LINE } as const;

/**
 * A block's words, in whole lines only (`blockFit`): stacked when there is
 * room, else one line of title and time, else the title alone.
 */
function BlockText({
	fit,
	title,
	timeWords,
	timeZone,
	people
}: {
	fit: BlockFit;
	title: string;
	timeWords: string;
	timeZone: string | null;
	people: string;
}) {
	const time = (
		<>
			{timeWords}
			{timeZone ? <Text style={{ color: color.inkFaint }}> {timeZone}</Text> : null}
		</>
	);
	if (fit.kind === 'line') {
		return (
			<View
				style={{
					flexDirection: 'row',
					alignItems: 'baseline',
					gap: 4,
					paddingTop: fit.padV,
					height: TITLE_LINE + fit.padV
				}}
			>
				<Text numberOfLines={1} style={{ ...titleStyle, flexShrink: 1 }}>
					{title}
				</Text>
				{fit.time ? (
					<Text numberOfLines={1} style={{ ...smallStyle, flexShrink: 0 }}>
						{time}
					</Text>
				) : null}
			</View>
		);
	}
	return (
		<View style={{ paddingTop: fit.padV }}>
			<Text numberOfLines={fit.titleLines} style={titleStyle}>
				{title}
			</Text>
			<Text numberOfLines={1} style={smallStyle}>
				{time}
			</Text>
			{fit.people ? (
				<Text numberOfLines={1} style={smallStyle}>
					{people}
				</Text>
			) : null}
		</View>
	);
}

function TimeBadge({ left, top, minute }: { left: number; top: number; minute: number }) {
	return (
		<View style={{ position: 'absolute', left, right: 0, top }}>
			<Text style={{ ...type.small, color: color.accentInk, fontWeight: '700' }}>
				{clock(minute)}
			</Text>
		</View>
	);
}

function LegBar({
	leg,
	from,
	left,
	width,
	boardStart,
	covered,
	peopleLabel
}: {
	leg: LegRow;
	from?: EventRow;
	left: number;
	width: number;
	boardStart: number;
	/** How much of the bar's top a block draws over; see covers. */
	covered: number;
	peopleLabel: (ids: string[]) => string;
}) {
	const h = Math.max(MIN_LEG_H, heightPx(leg.startMin, leg.endMin, boardStart));
	const top = topPx(leg.endMin, boardStart) - h;
	// What is left in view under a block: a whole line, the marks alone, or nothing.
	const shown = h - Math.min(h, covered);
	const words = shown >= 12;
	const marks = shown >= 10;
	const mode = modeLabel(leg.resolvedMode);
	const name = leg.title ?? (from && width > 150 ? `${mode} from ${from.title}` : mode);
	return (
		<View
			testID={`legbar:${leg.key}`}
			style={{
				position: 'absolute',
				left,
				top,
				width,
				height: h,
				minHeight: MIN_LEG_H,
				paddingHorizontal: width < 64 ? 2 : 5,
				paddingTop: h - shown,
				justifyContent: 'center',
				overflow: 'hidden'
			}}
		>
			{marks ? (
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
					<AppSymbol
						name={symbolForMode(leg.resolvedMode)}
						fallback="navigate-outline"
						size={10}
						color={leg.tight ? color.warn : color.inkFaint}
					/>
					{words ? (
						<Text
							numberOfLines={1}
							style={{
								fontSize: 10,
								lineHeight: 12,
								color: color.inkSoft,
								fontWeight: '700',
								flex: 1
							}}
						>
							{name} · {leg.resolvedMins}m
						</Text>
					) : (
						<View style={{ flex: 1 }} />
					)}
					{leg.tight ? (
						<AppSymbol
							name="exclamationmark.triangle.fill"
							fallback="warning-outline"
							size={10}
							color={color.warn}
						/>
					) : null}
				</View>
			) : null}
			{shown > 36 ? (
				<Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 12, color: color.inkSoft }}>
					{leg.tight ? copy.viewAs.travelWarning : peopleLabel(leg.people)}
				</Text>
			) : null}
		</View>
	);
}

function symbolForMode(mode: string): string {
	if (mode === 'walk') return 'figure.walk';
	if (mode === 'drive') return 'car.fill';
	if (mode === 'transit') return 'tram.fill';
	return 'location.fill';
}
