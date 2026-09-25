import { Platform } from 'react-native';
import { useCallback, useRef } from 'react';

export function useSheetHandoff<Action extends string>(handlers: Record<Action, () => void>) {
	const handlersRef = useRef(handlers);
	const pendingRef = useRef<Action | null>(null);
	handlersRef.current = handlers;

	const flush = useCallback(() => {
		const action = pendingRef.current;
		if (!action) return;
		pendingRef.current = null;
		handlersRef.current[action]?.();
	}, []);

	const queue = useCallback(
		(action: Action, close: () => void) => {
			pendingRef.current = action;
			close();
			if (Platform.OS === 'ios') {
				setTimeout(flush, 700);
				return;
			}
			requestAnimationFrame(() => setTimeout(flush, 0));
		},
		[flush]
	);

	return { queue, flush };
}
