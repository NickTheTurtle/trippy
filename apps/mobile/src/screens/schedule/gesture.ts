import { DAY_END, MIN_EVENT_MINS, PX_PER_MIN } from './shared';

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
