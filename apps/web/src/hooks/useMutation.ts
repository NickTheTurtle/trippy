import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../lib/api';
import { copy } from '../copy';

/**
 * The one write-side state machine.
 *
 * Every page had rewritten the same five lines around each mutation (a `busy`
 * flag, an error string, try / catch / finally, then a `reload`), about ten
 * copies across the app, and they had drifted: some reported the server's
 * message, some replaced it with a generic sentence, and a few swallowed the
 * failure entirely, which mattered the moment the API started answering 400 and
 * 403 instead of `{ok:true}` for a refused write.
 *
 * `run` never throws. It answers whether the write happened, so a caller can
 * close a dialog on success and leave it open (with the message showing) on
 * failure without writing a second try / catch.
 */
export type MutationOptions = {
	/** Ran after the action resolves. Usually the section's `reload`. */
	onSuccess?: () => void;
	/** Shown when the failure is not an `ApiError` (a bug, not a refusal). */
	fallback?: string;
	/**
	 * Ran with the message the failure resolved to, for a caller that reports it
	 * somewhere other than beside its own form: a toast, mostly. The message is
	 * still put in `error`, so a dialog can go on showing it in its footer while
	 * this fires.
	 */
	onError?: (message: string) => void;
};

export type Mutation<A extends unknown[]> = {
	/** Runs the action. Resolves true when it succeeded. */
	run: (...args: A) => Promise<boolean>;
	/** `onSubmit` handler for a form whose mutation takes no arguments. */
	submit: (e: FormEvent) => void;
	busy: boolean;
	/** The server's own message when it refused, otherwise `fallback`. */
	error: string;
	setError: (message: string) => void;
	/** Clears the error without running anything. */
	reset: () => void;
};

export function useMutation<A extends unknown[] = []>(
	action: (...args: A) => Promise<unknown>,
	options: MutationOptions = {}
): Mutation<A> {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	// Callers build the action and the options inline on every render, so they
	// are read through refs: `run` then keeps a stable identity and can be put
	// in an effect's dependency list without re-firing it every render.
	const actionRef = useRef(action);
	actionRef.current = action;
	const optionsRef = useRef(options);
	optionsRef.current = options;

	// A dialog that closes while its own save is in flight would otherwise set
	// state on an unmounted component.
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
			// An abort is the caller cancelling, not something to report.
			if (err instanceof DOMException && err.name === 'AbortError') return false;
			// A 404 on a write means somebody else deleted the row while this
			// dialog was open. The write genuinely failed, so the dialog stays
			// open with the reason on it, but the section is resynced as well:
			// otherwise the list keeps drawing a row that no longer exists and
			// every further action on it fails the same silent way.
			if (err instanceof ApiError && err.status === 404) optionsRef.current.onSuccess?.();
			const message =
				err instanceof ApiError
					? err.message
					: (optionsRef.current.fallback ?? copy.api.saveFallback);
			// Reported even when this component is going away: a dialog that closed
			// mid-flight is exactly the case where nothing else will say so.
			optionsRef.current.onError?.(message);
			if (alive.current) setError(message);
			return false;
		} finally {
			if (alive.current) setBusy(false);
		}
	}, []);

	const submit = useCallback(
		(e: FormEvent) => {
			e.preventDefault();
			// Only meaningful for a no-argument mutation, which is what a form
			// submit is: the values come from the closure, not from the event.
			void run(...([] as unknown as A));
		},
		[run]
	);

	const reset = useCallback(() => setError(''), []);

	return { run, submit, busy, error, setError, reset };
}
