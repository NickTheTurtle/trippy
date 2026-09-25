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
import { layoutBoard, legLaneId } from '@trippy/core/travel';
import type { EventType } from '@trippy/core/types';
import { api, ApiError } from '../../lib/api';
import { color, radius, space, type } from '../../theme';
import { useToast } from '../../ui/Toast';
import { setInteractionBusy } from '../../ui/busy';
import { AppSymbol } from '../../ui/Symbol';
import {
	DAY_END,
	DEFAULT_START,
	MIN_EVENT_MINS,
	PX_PER_MIN,
	clock,
	clockRange,
	heightPx,
	hourLabel,
	hoursFrom,
	modeLabel,
	topPx,
	windowStart
} from './shared';
import { gripHeightForBlock, passedGestureSlop, snapMoveStart, snapResizeEnd } from './gesture';
import type { BoardDay, EventRow, LegRow } from './types';

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
	freetime: '#8a8578'
};

type ActiveLabel = { id: string; kind: 'move' | 'resize'; minute: number } | null;

export function DayBoard({
	base,
	entry,
	memberIds,
	peopleLabel,
	eventById,
	locked,
	onOpen,
	onGestureChange,
	onReload
}: {
	base: string;
	entry: BoardDay;
	memberIds: string[];
	peopleLabel: (ids: string[]) => string;
	eventById: Map<string, EventRow>;
	locked: boolean;
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

	const baseStartFor = (event: EventRow) =>
		pending?.id === event.id && pending.start != null ? pending.start : event.start_min;
	const baseEndFor = (event: EventRow) =>
		pending?.id === event.id && pending.end != null ? pending.end : event.end_min;

	const boardStart = useMemo(() => {
		const mins = [
			...entry.events.flatMap((event) => [baseStartFor(event), baseEndFor(event)]),
			...entry.legs.flatMap((leg) => [leg.startMin, leg.endMin])
		];
		return windowStart(mins.length ? mins : [DEFAULT_START]);
	}, [entry, pending]);

	const { layout, bars } = useMemo(() => {
		const eventsForLayout = entry.events.map((event) => ({
			id: event.id,
			start: event.start_min,
			end: event.end_min,
			people: event.people.length ? event.people : memberIds
		}));
		const shiftedLegs = entry.legs.map((leg) => {
			const to = entry.events.find((event) => event.id === leg.toEventId);
			return to ? shiftLeg(leg, baseStartFor(to) - to.start_min) : leg;
		});
		return layoutBoard(eventsForLayout, shiftedLegs);
	}, [entry, memberIds, pending]);

	const maxCols = Math.max(1, ...[...layout.placed.values()].map((placed) => placed.cols));
	const boardW = Math.max(boardOuterW, GUTTER + maxCols * LANE_MIN);
	const laneW = boardW - GUTTER;
	const contentH = (DAY_END - boardStart) * PX_PER_MIN + 24;

	useEffect(() => {
		const starts = [
			...entry.events.map((event) => baseStartFor(event)),
			...entry.legs.map((leg) => leg.startMin)
		];
		const first = starts.length ? Math.min(...starts) : DEFAULT_START;
		const timer = setTimeout(
			() =>
				scrollRef.current?.scrollTo({
					y: Math.max(0, topPx(first, boardStart) - 80),
					animated: false
				}),
			0
		);
		return () => clearTimeout(timer);
		// Only seat when the served day changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [entry.day]);

	const trims = new Map<string, number>();
	for (const bar of bars) {
		const bottom = topPx(bar.leg.endMin, boardStart);
		const top =
			bottom - Math.max(heightPx(bar.leg.startMin, bar.leg.endMin, boardStart), MIN_LEG_H);
		for (const event of entry.events) {
			const placed = layout.placed.get(event.id);
			if (!placed || placed.left >= bar.left + bar.width || bar.left >= placed.left + placed.width)
				continue;
			const over =
				Math.min(topPx(baseEndFor(event), boardStart), bottom) -
				Math.max(topPx(baseStartFor(event), boardStart), top);
			if (over > 0) trims.set(event.id, Math.max(trims.get(event.id) ?? 0, over));
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
				style={{ maxHeight: 620 }}
				contentContainerStyle={{ paddingBottom: space.md }}
			>
				<GestureScrollView
					horizontal
					scrollEnabled={!gestureActive}
					nestedScrollEnabled
					showsHorizontalScrollIndicator={boardW > boardOuterW}
				>
					<View style={{ width: boardW, height: contentH }}>
						{hoursFrom(boardStart).map((hour) => {
							const top = topPx(hour * 60, boardStart);
							return (
								<View key={hour} style={{ position: 'absolute', left: 0, right: 0, top }}>
									<Text style={{ ...type.faint, position: 'absolute', width: GUTTER - 8 }}>
										{hourLabel(hour)}
									</Text>
									<View
										style={{
											position: 'absolute',
											left: GUTTER,
											right: 0,
											top: 8,
											borderTopWidth: 1,
											borderTopColor: color.line
										}}
									/>
								</View>
							);
						})}
						{bars.map((bar) => (
							<LegBar
								key={legLaneId(bar.leg)}
								leg={bar.leg}
								from={eventById.get(bar.leg.fromEventId)}
								left={GUTTER + bar.left * laneW}
								width={Math.max(32, bar.width * laneW - GAP)}
								boardStart={boardStart}
								peopleLabel={peopleLabel}
							/>
						))}
						{entry.events.map((event) => {
							const placed = layout.placed.get(event.id);
							if (!placed) return null;
							const drawnStart = baseStartFor(event);
							const drawnEnd = baseEndFor(event);
							const trimmedHeight =
								heightPx(drawnStart, drawnEnd, boardStart) - (trims.get(event.id) ?? 0);
							return (
								<EventBlock
									key={event.id}
									event={event}
									left={GUTTER + placed.left * laneW}
									width={Math.max(44, placed.width * laneW - GAP)}
									top={topPx(drawnStart, boardStart)}
									height={Math.max(MIN_LEG_H, trimmedHeight)}
									drawnStart={drawnStart}
									drawnEnd={drawnEnd}
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
								left={GUTTER}
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
								left={GUTTER}
								top={topPx(pending.start, boardStart) - 22}
								minute={pending.start}
							/>
						) : null}
						{pending?.end != null ? (
							<TimeBadge
								left={GUTTER}
								top={topPx(pending.end, boardStart) + 4}
								minute={pending.end}
							/>
						) : null}
					</View>
				</GestureScrollView>
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
	drawnEnd
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
					const next = snapMoveStart(
						event.start_min,
						gesture.translationY,
						event.end_min - event.start_min
					);
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
			event.end_min,
			event.id,
			event.start_min,
			lastMoveMinute,
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

	const blockGesture = useMemo(
		() => (locked ? tapGesture : Gesture.Exclusive(moveGesture, tapGesture)),
		[locked, moveGesture, tapGesture]
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

	const accessibilityLabel = `${event.title}, ${clockRange(event.start_min, event.end_min)}. ${locked ? copy.schedule.block.openLabel : copy.schedule.block.mobileOpenLabel}`;

	return (
		<View style={{ position: 'absolute', left, top, width, height }}>
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
							borderRadius: radius.md,
							backgroundColor: color.accentSoft,
							paddingLeft: 10,
							paddingRight: 7,
							paddingVertical: 4,
							overflow: 'hidden'
						},
						blockStyle
					]}
				>
					<Text
						numberOfLines={2}
						style={{ color: color.ink, fontWeight: '700', fontSize: 12, lineHeight: 15 }}
					>
						{event.title}
					</Text>
					<Text style={{ color: color.inkSoft, fontSize: 10, lineHeight: 12 }}>
						{clockRange(event.start_min, event.end_min)}
					</Text>
					<Text numberOfLines={1} style={{ color: color.inkSoft, fontSize: 10, lineHeight: 12 }}>
						{peopleLabel(event.people)}
					</Text>
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
			{locked ? null : (
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
								opacity: 0.4
							}}
						/>
					</Animated.View>
				</GestureDetector>
			)}
		</View>
	);
});
EventBlock.displayName = 'EventBlock';

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
	peopleLabel
}: {
	leg: LegRow;
	from?: EventRow;
	left: number;
	width: number;
	boardStart: number;
	peopleLabel: (ids: string[]) => string;
}) {
	const h = Math.max(MIN_LEG_H, heightPx(leg.startMin, leg.endMin, boardStart));
	const top = topPx(leg.endMin, boardStart) - h;
	const mode = modeLabel(leg.resolvedMode);
	const name = leg.title ?? (from && width > 150 ? `${mode} from ${from.title}` : mode);
	return (
		<View
			style={{
				position: 'absolute',
				left,
				top,
				width,
				height: h,
				minHeight: MIN_LEG_H,
				paddingHorizontal: width < 64 ? 2 : 5,
				justifyContent: 'center',
				overflow: 'hidden'
			}}
		>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
				<AppSymbol
					name={symbolForMode(leg.resolvedMode)}
					fallback="navigate-outline"
					size={10}
					color={leg.tight ? color.warn : color.inkFaint}
				/>
				<Text
					numberOfLines={1}
					style={{ fontSize: 10, lineHeight: 12, color: color.inkSoft, fontWeight: '700', flex: 1 }}
				>
					{name} · {leg.resolvedMins}m
				</Text>
				{leg.tight ? (
					<AppSymbol
						name="exclamationmark.triangle.fill"
						fallback="warning-outline"
						size={10}
						color={color.warn}
					/>
				) : null}
			</View>
			{h > 36 ? (
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
