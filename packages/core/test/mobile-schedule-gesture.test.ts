import { describe, expect, it } from 'vitest';
import { PX_PER_MIN } from '../../../apps/mobile/src/screens/schedule/shared';
import {
	gripHeightForBlock,
	passedGestureSlop,
	snapMoveStart,
	snapResizeEnd
} from '../../../apps/mobile/src/screens/schedule/gesture';

describe('mobile schedule gesture math', () => {
	it('moves in snapped five minute increments', () => {
		expect(snapMoveStart(660, 60 * PX_PER_MIN, 60)).toBe(720);
	});

	it('does not commit a still long press', () => {
		expect(passedGestureSlop(0)).toBe(false);
		expect(passedGestureSlop(2.5)).toBe(false);
		expect(passedGestureSlop(3)).toBe(true);
	});

	it('clamps resize to midnight', () => {
		expect(snapResizeEnd(780, 900 * PX_PER_MIN, 720)).toBe(1440);
	});

	it('keeps short block grip from covering the whole block', () => {
		expect(gripHeightForBlock(17)).toBe(8);
		expect(gripHeightForBlock(34)).toBeCloseTo(10.2);
		expect(gripHeightForBlock(100)).toBe(22);
	});
});
