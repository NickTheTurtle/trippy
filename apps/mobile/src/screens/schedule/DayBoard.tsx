import { useEffect, useMemo, useRef, useState } from 'react';
import type { ElementRef } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { copy } from '@trippy/copy';
import { layoutBoard, legLaneId } from '@trippy/core/travel';
import type { EventType } from '@trippy/core/types';
import { api, ApiError } from '../../lib/api';
import { color, radius, space, type } from '../../theme';
import { useToast } from '../../ui/Toast';
import {
	DAY_END,
	PX_PER_MIN,
	clock,
	clockRange,
	heightPx,
	hourLabel,
	hoursFrom,
	modeLabel,
	topPx,
	typeLabel,
	windowStart
} from './shared';
import { snapMoveStart, snapResizeEnd } from './gesture';
import type { BoardDay, EventRow, LegRow } from './types';

type Gesture =
	| { kind: 'move'; id: string; startY: number; origStart: number; liveStart: number; mins: number }
	| {
			kind: 'resize';
			id: string;
			startY: number;
			startMin: number;
			origEnd: number;
			liveEnd: number;
	  };

const GUTTER = 58;
const LANE_MIN = 104;
const GAP = 6;
const LONG_PRESS_MS = 400;
const HOLD_SLOP = 8;
const MIN_LEG_H = 15;

const EVENT_COLORS: Record<EventType, string> = {
	activity: '#2f7a4f',
	food: '#c15a25',
	stay: '#7b4fa6',
	travel: '#2f6d9e',
	freetime: '#8a8578'
};

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
	const [laneW, setLaneW] = useState(Math.max(width - GUTTER - space.lg * 2, LANE_MIN));
	const [gesture, setGesture] = useState<Gesture | null>(null);
	const [pending, setPending] = useState<{ id: string; start?: number; end?: number } | null>(null);
	const [scrollEnabled, setScrollEnabled] = useState(true);
	const scrollRef = useRef<ElementRef<typeof ScrollView> | null>(null);
	const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
	const down = useRef<{ id: string; y: number; x: number; resize: boolean } | null>(null);

	useEffect(() => {
		setPending(null);
	}, [entry]);

	useEffect(() => {
		onGestureChange(gesture !== null);
		setScrollEnabled(gesture === null);
	}, [gesture, onGestureChange]);

	const startFor = (event: EventRow) =>
		gesture?.kind === 'move' && gesture.id === event.id
			? gesture.liveStart
			: pending?.id === event.id && pending.start != null
				? pending.start
				: event.start_min;
	const endFor = (event: EventRow) =>
		gesture?.kind === 'resize' && gesture.id === event.id
			? gesture.liveEnd
			: pending?.id === event.id && pending.end != null
				? pending.end
				: event.end_min;

	const boardStart = useMemo(() => {
		const mins = [
			...entry.events.flatMap((event) => [startFor(event), endFor(event)]),
			...entry.legs.flatMap((leg) => [leg.startMin, leg.endMin])
		];
		return windowStart(mins.length ? mins : [9 * 60]);
	}, [entry, gesture, pending]);

	const eventsForLayout = entry.events.map((event) => ({
		id: event.id,
		start: event.start_min,
		end: event.end_min,
		people: event.people.length ? event.people : memberIds
	}));
	const shiftedLegs = entry.legs.map((leg) => {
		const to = entry.events.find((event) => event.id === leg.toEventId);
		return to ? shiftLeg(leg, startFor(to) - to.start_min) : leg;
	});
	const { layout, bars } = layoutBoard(eventsForLayout, shiftedLegs);
	const maxCols = Math.max(1, ...[...layout.placed.values()].map((placed) => placed.cols));
	const boardW = Math.max(width - space.lg * 2, GUTTER + maxCols * LANE_MIN);
	const computedLaneW = boardW - GUTTER;
	const contentH = (DAY_END - boardStart) * PX_PER_MIN + 24;

	useEffect(() => {
		setLaneW(computedLaneW);
	}, [computedLaneW]);

	useEffect(() => {
		const first = Math.min(...entry.events.map((event) => startFor(event)), 9 * 60);
		const timer = setTimeout(
			() =>
				scrollRef.current?.scrollTo({
					y: Math.max(0, topPx(first, boardStart) - 80),
					animated: false
				}),
			0
		);
		return () => clearTimeout(timer);
		// Run only when the served day changes, not on every drag frame.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [entry.day]);

	const legTargets = new Set(bars.map((bar) => bar.leg.toEventId));
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
				Math.min(topPx(endFor(event), boardStart), bottom) -
				Math.max(topPx(startFor(event), boardStart), top);
			if (over > 0) trims.set(event.id, Math.max(trims.get(event.id) ?? 0, over));
		}
	}

	const writeMove = async (event: EventRow, startMin: number) => {
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
	};

	const writeResize = async (event: EventRow, endMin: number) => {
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
	};

	const clearHold = () => {
		if (hold.current) clearTimeout(hold.current);
		hold.current = null;
	};

	const startHold = (event: EventRow, y: number, x: number, resize: boolean) => {
		if (locked) return;
		if (!resize && down.current?.id === event.id && down.current.resize) return;
		down.current = { id: event.id, y, x, resize };
		clearHold();
		hold.current = setTimeout(() => {
			hold.current = null;
			setGesture(
				resize
					? {
							kind: 'resize',
							id: event.id,
							startY: y,
							startMin: event.start_min,
							origEnd: event.end_min,
							liveEnd: event.end_min
						}
					: {
							kind: 'move',
							id: event.id,
							startY: y,
							origStart: event.start_min,
							liveStart: event.start_min,
							mins: event.end_min - event.start_min
						}
			);
		}, LONG_PRESS_MS);
	};

	const moveHold = (y: number, x: number) => {
		if (hold.current && down.current) {
			if (Math.hypot(y - down.current.y, x - down.current.x) > HOLD_SLOP) {
				clearHold();
				down.current = null;
			}
		}
		if (!gesture) return;
		if (gesture.kind === 'move') {
			const liveStart = snapMoveStart(gesture.origStart, y - gesture.startY, gesture.mins);
			setGesture({ ...gesture, liveStart });
		} else {
			const liveEnd = snapResizeEnd(gesture.origEnd, y - gesture.startY, gesture.startMin);
			setGesture({ ...gesture, liveEnd });
		}
	};

	const endHold = () => {
		clearHold();
		const start = down.current;
		down.current = null;
		const current = gesture;
		setGesture(null);
		if (!current) {
			if (start) onOpen(start.id);
			return;
		}
		const event = entry.events.find((row) => row.id === current.id);
		if (!event) return;
		if (current.kind === 'move') void writeMove(event, current.liveStart);
		else void writeResize(event, current.liveEnd);
	};

	const cancelHold = () => {
		clearHold();
		down.current = null;
		setGesture(null);
	};

	return (
		<ScrollView
			ref={scrollRef}
			scrollEnabled={scrollEnabled}
			nestedScrollEnabled
			horizontal={false}
			style={{ maxHeight: 620 }}
			contentContainerStyle={{ paddingBottom: space.md }}
		>
			<ScrollView
				horizontal
				nestedScrollEnabled
				showsHorizontalScrollIndicator={boardW > width - space.lg * 2}
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
						return (
							<EventBlock
								key={event.id}
								event={event}
								left={GUTTER + placed.left * laneW}
								width={Math.max(44, placed.width * laneW - GAP)}
								top={topPx(startFor(event), boardStart)}
								height={Math.max(
									18,
									heightPx(startFor(event), endFor(event), boardStart) - (trims.get(event.id) ?? 0)
								)}
								peopleLabel={peopleLabel}
								locked={locked}
								legTarget={legTargets.has(event.id)}
								active={gesture?.id === event.id}
								onPressIn={(y, x, resize) => startHold(event, y, x, resize)}
								onMove={moveHold}
								onEnd={endHold}
								onCancel={cancelHold}
								onOpen={() => onOpen(event.id)}
							/>
						);
					})}
					{gesture ? (
						<View
							style={{
								position: 'absolute',
								left: GUTTER,
								right: 0,
								top:
									gesture.kind === 'move'
										? topPx(gesture.liveStart, boardStart) - 22
										: topPx(gesture.liveEnd, boardStart) + 4
							}}
						>
							<Text style={{ ...type.small, color: color.accentInk, fontWeight: '700' }}>
								{gesture.kind === 'move' ? clock(gesture.liveStart) : clock(gesture.liveEnd)}
							</Text>
						</View>
					) : null}
				</View>
			</ScrollView>
		</ScrollView>
	);
}

function shiftLeg(leg: LegRow, by: number): LegRow {
	return by ? { ...leg, startMin: leg.startMin + by, endMin: leg.endMin + by } : leg;
}

function EventBlock({
	event,
	left,
	width,
	top,
	height,
	peopleLabel,
	locked,
	legTarget,
	active,
	onPressIn,
	onMove,
	onEnd,
	onCancel,
	onOpen
}: {
	event: EventRow;
	left: number;
	width: number;
	top: number;
	height: number;
	peopleLabel: (ids: string[]) => string;
	locked: boolean;
	legTarget: boolean;
	active: boolean;
	onPressIn: (y: number, x: number, resize: boolean) => void;
	onMove: (y: number, x: number) => void;
	onEnd: () => void;
	onCancel: () => void;
	onOpen: () => void;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			onPress={onOpen}
			onTouchStart={(eventTouch) =>
				onPressIn(
					eventTouch.nativeEvent.pageY,
					eventTouch.nativeEvent.pageX,
					eventTouch.nativeEvent.locationY > height - 14
				)
			}
			onTouchMove={(eventTouch) =>
				onMove(eventTouch.nativeEvent.pageY, eventTouch.nativeEvent.pageX)
			}
			onTouchEnd={onEnd}
			onTouchCancel={onCancel}
			onPointerDown={(eventPointer) =>
				onPressIn(
					eventPointer.nativeEvent.pageY,
					eventPointer.nativeEvent.pageX,
					((eventPointer.nativeEvent as { locationY?: number }).locationY ?? 0) > height - 14
				)
			}
			onPointerMove={(eventPointer) =>
				onMove(eventPointer.nativeEvent.pageY, eventPointer.nativeEvent.pageX)
			}
			onPointerUp={onEnd}
			onPointerCancel={onCancel}
			style={({ pressed }) => ({
				position: 'absolute',
				left,
				top,
				width,
				height,
				minHeight: 24,
				borderRadius: radius.md,
				borderTopLeftRadius: legTarget ? 3 : radius.md,
				backgroundColor: EVENT_COLORS[event.type],
				paddingHorizontal: 7,
				paddingVertical: 4,
				opacity: active ? 0.72 : pressed ? 0.86 : 1,
				overflow: 'hidden'
			})}
		>
			<Text
				numberOfLines={2}
				style={{ color: '#fff', fontWeight: '700', fontSize: 12, lineHeight: 15 }}
			>
				{event.title}
			</Text>
			<Text style={{ color: '#fff', fontSize: 10, lineHeight: 12 }}>
				{clockRange(event.start_min, event.end_min)}
			</Text>
			<Text numberOfLines={1} style={{ color: '#fff', fontSize: 10, lineHeight: 12 }}>
				{peopleLabel(event.people)}
			</Text>
			{locked ? null : (
				<Pressable
					accessibilityRole="adjustable"
					accessibilityLabel={copy.schedule.block.resizeLabel}
					onTouchStart={(eventTouch) =>
						onPressIn(eventTouch.nativeEvent.pageY, eventTouch.nativeEvent.pageX, true)
					}
					onTouchMove={(eventTouch) =>
						onMove(eventTouch.nativeEvent.pageY, eventTouch.nativeEvent.pageX)
					}
					onTouchEnd={onEnd}
					onTouchCancel={onCancel}
					onPointerDown={(eventPointer) =>
						onPressIn(eventPointer.nativeEvent.pageY, eventPointer.nativeEvent.pageX, true)
					}
					onPointerMove={(eventPointer) =>
						onMove(eventPointer.nativeEvent.pageY, eventPointer.nativeEvent.pageX)
					}
					onPointerUp={onEnd}
					onPointerCancel={onCancel}
					style={{
						position: 'absolute',
						left: 0,
						right: 0,
						bottom: 0,
						height: 10,
						backgroundColor: 'rgba(255,255,255,0.28)'
					}}
				/>
			)}
		</Pressable>
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
				borderRadius: radius.sm,
				backgroundColor: color.accentSoft,
				borderWidth: 1,
				borderColor: leg.tight ? color.warn : color.accent,
				paddingHorizontal: width < 64 ? 2 : 5,
				justifyContent: 'center',
				overflow: 'hidden'
			}}
		>
			<Text
				numberOfLines={1}
				style={{ fontSize: 10, lineHeight: 12, color: color.accentInk, fontWeight: '700' }}
			>
				{name} · {leg.resolvedMins}m
			</Text>
			{h > 36 ? (
				<Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 12, color: color.inkSoft }}>
					{leg.tight ? copy.viewAs.travelWarning : peopleLabel(leg.people)}
				</Text>
			) : null}
		</View>
	);
}
