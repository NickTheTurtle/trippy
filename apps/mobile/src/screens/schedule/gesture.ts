import { DAY_END, MIN_EVENT_MINS, PX_PER_MIN } from './shared';

export function snapMoveStart(origStart: number, pointerDeltaY: number, duration: number): number {
	const raw = origStart + pointerDeltaY / PX_PER_MIN;
	return Math.max(0, Math.min(DAY_END - duration, Math.round(raw / 5) * 5));
}

export function snapResizeEnd(origEnd: number, pointerDeltaY: number, startMin: number): number {
	const raw = origEnd + pointerDeltaY / PX_PER_MIN;
	return Math.max(startMin + MIN_EVENT_MINS, Math.min(DAY_END, Math.round(raw / 5) * 5));
}
