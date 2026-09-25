import { Platform } from 'react-native';
import { useCallback, useEffect, useRef } from 'react';

/**
 * Open one sheet from another without iOS dropping the second.
 *
 * iOS silently refuses to present a Modal while another is still dismissing,
 * so a menu row that closes the menu and opens a sheet in the same tick can do
 * nothing at all. `queue` closes the current sheet and parks the action;
 * `flush`, wired to the closing sheet's `onDismiss`, runs it once the native
 * dismissal has finished, a frame later so the next present never lands in the
 * same turn. A 700ms fallback covers an `onDismiss` that never arrives; it is
 * cleared whenever the action runs or a newer one is queued, so a quick second
 * pick cannot be run early by the first pick's timer. Elsewhere there is no such
 * limit and the action runs on the next frame.
 */
export function useSheetHandoff<Action extends string>(handlers: Record<Action, () => void>) {
	const handlersRef = useRef(handlers);
	const pendingRef = useRef<Action | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	handlersRef.current = handlers;

	const clearTimer = useCallback(() => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	const run = useCallback(() => {
		clearTimer();
		const action = pendingRef.current;
		if (!action) return;
		pendingRef.current = null;
		handlersRef.current[action]?.();
	}, [clearTimer]);

	const flush = useCallback(() => {
		clearTimer();
		requestAnimationFrame(() => setTimeout(run, 0));
	}, [clearTimer, run]);

	const queue = useCallback(
		(action: Action, close: () => void) => {
			clearTimer();
			pendingRef.current = action;
			close();
			if (Platform.OS === 'ios') {
				timerRef.current = setTimeout(run, 700);
				return;
			}
			requestAnimationFrame(() => setTimeout(run, 0));
		},
		[clearTimer, run]
	);

	useEffect(() => clearTimer, [clearTimer]);

	return { queue, flush };
}
