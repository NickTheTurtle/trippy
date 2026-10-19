import { onOneClock, type Segment, type SpanRow, type ZoneOf } from '@trippy/core/span';
import { DAY_END, MIN_EVENT_MINS, PX_PER_MIN } from './shared';

/**
 * What a block on the board can be dragged by. Only a block on one clock on
 * one day (`onOneClock`, the rule the server's move and resize hold to) moves
 * or resizes. A part of a multi-day event is a slice of something longer, and
 * a journey that lands on another city's clock has an end that is a time on
 * the ticket rather than a length, so both open the sheet instead.
 */
export function boardGestures(
	row: SpanRow,
	seg: Segment,
	zoneOf?: ZoneOf
): { move: boolean; resize: boolean } {
	const free = seg.startsHere && seg.endsHere && onOneClock(row, zoneOf);
	return { move: free, resize: free };
}

export function snapMoveStart(origStart: number, pointerDeltaY: number, duration: number): number {
	'worklet';
	const raw = origStart + pointerDeltaY / PX_PER_MIN;
	return Math.max(0, Math.min(DAY_END - duration, Math.round(raw / 5) * 5));
}

export function snapResizeEnd(origEnd: number, pointerDeltaY: number, startMin: number): number {
	'worklet';
	const raw = origEnd + pointerDeltaY / PX_PER_MIN;
	return Math.max(startMin + MIN_EVENT_MINS, Math.min(DAY_END, Math.round(raw / 5) * 5));
}

export function passedGestureSlop(pointerDeltaY: number, slop = 3): boolean {
	'worklet';
	return Math.abs(pointerDeltaY) >= slop;
}

export function gripHeightForBlock(height: number): number {
	return Math.min(22, Math.max(8, height * 0.3));
}
