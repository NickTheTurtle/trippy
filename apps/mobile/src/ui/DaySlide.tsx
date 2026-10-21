import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
	useAnimatedStyle,
	useReducedMotion,
	useSharedValue,
	withSequence,
	withTiming
} from 'react-native-reanimated';

const SLIDE_PX = 24;
const SLIDE_MS = 200;

/**
 * Ease-out cubic, held to [0, 1]. A step's render can take longer than a frame,
 * and the first frame after it can then report a time before the animation's
 * start; unclamped, the ease reads that as negative progress and throws the
 * day the wrong way with a negative opacity for a frame (seen in the web
 * preview as a 100px jump).
 */
function easeOut(t: number): number {
	'worklet';
	const p = Math.min(1, Math.max(0, t));
	return 1 - (1 - p) ** 3;
}

/**
 * What a day step looks like: the new day's content comes in from the side the
 * reader stepped towards, 24px over 200ms, and fades up from part-way.
 *
 * Sideways only. A step changes the date, so the movement is along the dates;
 * nothing slides vertically, because vertical is the clock and the clock does
 * not change on a step. Short, so a run of taps is never waiting on the last
 * one's animation. Nothing at all under Reduce Motion: the day is simply
 * replaced. ISO dates compare as strings, which gives the direction.
 *
 * The first `day` is not animated, so a screen or a view that mounts on a day
 * draws it at rest.
 */
export function DaySlide({
	day,
	style,
	children
}: {
	day: string;
	style?: StyleProp<ViewStyle>;
	children: ReactNode;
}) {
	const reduceMotion = useReducedMotion();
	const x = useSharedValue(0);
	const opacity = useSharedValue(1);
	const last = useRef(day);

	useLayoutEffect(() => {
		const was = last.current;
		last.current = day;
		if (was === day || reduceMotion) return;
		const from = (day > was ? 1 : -1) * SLIDE_PX;
		const timing = { duration: SLIDE_MS, easing: easeOut };
		// Jump to the start, then ease in, as one sequence: two separate writes
		// can reach the UI thread in one frame and start the ease from 0.
		x.value = withSequence(withTiming(from, { duration: 0 }), withTiming(0, timing));
		opacity.value = withSequence(withTiming(0.35, { duration: 0 }), withTiming(1, timing));
	}, [day, opacity, reduceMotion, x]);

	const animated = useAnimatedStyle(() => ({
		opacity: opacity.value,
		transform: [{ translateX: x.value }]
	}));

	return <Animated.View style={[style, animated]}>{children}</Animated.View>;
}
