import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbort } from '../lib/api';
import { copy } from '@trippy/copy';

/**
 * The mobile twin of the web app's useMutation, with the same contract: `run`
 * never throws and answers whether the write happened, so a caller can dismiss
 * a sheet on success and leave it open with the message showing on failure.
 */
export type MutationOptions = {
	onSuccess?: () => void;
	fallback?: string;
};

export type Mutation<A extends unknown[]> = {
	run: (...args: A) => Promise<boolean>;
	busy: boolean;
	error: string;
	setError: (message: string) => void;
	reset: () => void;
};

export function useMutation<A extends unknown[] = []>(
	action: (...args: A) => Promise<unknown>,
	options: MutationOptions = {}
): Mutation<A> {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	const actionRef = useRef(action);
	actionRef.current = action;
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const run = useCallback(async (...args: A): Promise<boolean> => {
		setBusy(true);
		setError('');
		try {
			await actionRef.current(...args);
			optionsRef.current.onSuccess?.();
			return true;
		} catch (err) {
			if (isAbort(err)) return false;
			if (alive.current) {
				setError(
					err instanceof ApiError
						? err.message
						: (optionsRef.current.fallback ?? copy.api.saveFallback)
				);
			}
			return false;
		} finally {
			if (alive.current) setBusy(false);
		}
	}, []);

	const reset = useCallback(() => setError(''), []);

	return { run, busy, error, setError, reset };
}
