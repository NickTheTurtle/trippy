import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode
} from 'react';
import { copy } from '../../copy';

/**
 * The corner popups, and the only notification mechanism in the app.
 *
 * What lands here is a *result*: the app did the thing, or refused to. Those
 * used to be tinted blocks pushed into the page above the form that caused
 * them, which moved the page under the reader's hands and, on the pages that
 * scroll, reported the outcome somewhere off screen. What stays inline is the
 * refusal attached to one control: it is read next to the thing to correct. A
 * page whose own load failed sends the reason here and keeps a line of its own
 * saying so, which is what `LoadError` is for.
 *
 * Three things about the plumbing are not obvious.
 *
 * **It is a popover, not a high z-index.** Every dialog in the app is a native
 * `showModal()` dialog, which puts it in the top layer, above any z-index a
 * stylesheet can name. A result raised by a dialog's own save would therefore
 * be painted behind it. The viewport is a `popover`, which is the other way
 * into the top layer.
 *
 * **It is re-promoted.** The top layer is ordered by when each element entered
 * it, so a viewport promoted at startup still sits under a dialog opened later.
 * Each new toast closes and reopens the popover, which moves it back to the
 * front, and a dialog opening does the same for the toasts already up.
 *
 * **A toast raised over an open modal can be read but not pressed.**
 * `showModal()` makes the rest of the document inert, and inertness reaches
 * into the top layer, so the dismiss button is unclickable while the dialog is
 * up. That is the right end of the trade: focus belongs to the dialog. Nothing
 * strands there: every message has a clock, an error the dialog itself raised
 * is retracted by `DialogError` when the dialog closes, and one raised from
 * elsewhere is pressable again the moment the dialog is out of the way.
 *
 * Inertness also takes the corner out of the accessibility tree while a dialog
 * is open, which is why a dialog announces its own failures from inside itself.
 * See `DialogError`.
 */
export type ToastTone = 'success' | 'error';

type Toast = { id: number; tone: ToastTone; message: string };

/**
 * How long a success has. Long enough to be read after the eye travels to the
 * corner, short enough that a run of saves does not build a wall.
 */
const SUCCESS_MS = 4500;

/**
 * How long an error has. Longer than a success, and for the reasons a success
 * is short: an error is the only account of why something did not happen, it
 * often carries the server's own wording, and it frequently arrives from a
 * dialog, where it cannot be dismissed until the dialog closes. So it is given
 * time to be found and read rather than time to be glanced at.
 *
 * It does expire, though, which it used to not. Permanence read as correct
 * until you watched somebody use it: a refusal you have already understood and
 * acted on is still sitting in the corner, and the only way to be rid of it is
 * to aim at a small button, so the corner accumulated sentences about a state
 * the app had already left. The holds below are what make a timer safe here:
 * the clock stops while the pointer or the caret is on the stack, so a message
 * being read is never taken away mid-sentence, and the ones that describe a
 * condition that is still true (`useErrorToast`, `LoadError`) are re-raised by
 * their own effect rather than depending on the first copy surviving.
 */
const ERROR_MS = 12000;

/**
 * How many messages the corner holds at once. A cap rather than a scroll: a
 * corner is for the last few things that happened, and a column tall enough to
 * need scrolling is covering the page it is reporting on.
 */
const MAX = 4;

type ToastApi = {
	/**
	 * Ignores an empty message, so callers can pass state straight in. Returns
	 * the new toast's id, or null when there was nothing to say. The id is what
	 * a caller needs to take one back down: a form that is submitted twice
	 * should replace its own last refusal rather than stack a second copy of it
	 * under the first.
	 */
	success: (message: string) => number | null;
	error: (message: string) => number | null;
	/**
	 * Takes a message back. The same call the dismiss button makes, so a caller
	 * whose condition has passed can retract its own toast: an error that is no
	 * longer true is a lie about the current state, and an error is given long
	 * enough on screen to outlive the condition that raised it. Unknown and
	 * already-gone ids are a silent no-op, which is what lets a caller retract
	 * on unmount without first checking whether the clock or the reader got
	 * there first.
	 */
	dismiss: (id: number | null) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Mounted once, above the router. Pages call `useToast()`; nothing else in the
 * app should grow its own floating message.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const nextId = useRef(1);
	/* Bumped by every new toast, and only there: the viewport reads it to know
	   it has to climb back to the front of the top layer. */
	const [promotions, setPromotions] = useState(0);

	const dismiss = useCallback((id: number | null) => {
		if (id === null) return;
		setToasts((list) => list.filter((t) => t.id !== id));
	}, []);

	const push = useCallback((tone: ToastTone, message: string) => {
		if (!message) return null;
		const id = nextId.current++;
		// Oldest out first, for the rare burst that outruns the clocks.
		setToasts((list) => [...list, { id, tone, message }].slice(-MAX));
		setPromotions((n) => n + 1);
		return id;
	}, []);

	const api = useMemo<ToastApi>(
		() => ({
			success: (message) => push('success', message),
			error: (message) => push('error', message),
			dismiss
		}),
		[push, dismiss]
	);

	return (
		<ToastContext.Provider value={api}>
			{children}
			<ToastViewport toasts={toasts} promotions={promotions} onDismiss={dismiss} />
		</ToastContext.Provider>
	);
}

export function useToast(): ToastApi {
	const api = useContext(ToastContext);
	if (!api) throw new Error('useToast outside ToastProvider');
	return api;
}

/**
 * Keeps an error in the corner for exactly as long as it is true.
 *
 * The one pattern every caller with a *held* error string wants: a dialog
 * footer, a confirmation, a page whose load failed. Raised when the string
 * appears, retracted when it goes. An error is on screen long enough to outlive
 * most of the conditions that raise one, so without the retraction a user who
 * fails, fixes the field and succeeds is left with the failure still sitting in
 * the corner describing a state the app is no longer in. `useMutation.run`
 * clears `error` at the start of every attempt and a closing dialog unmounts
 * its footer, so both resolutions arrive here as the same cleanup.
 *
 * Keyed on the message, which is what makes it announce once. A re-render with
 * the same string does not re-run the effect, so an unrelated keystroke in the
 * form does not restate the failure; and React's development mode double mount
 * nets out at a single row, because the first mount's cleanup retracts its own
 * toast before the second raises one. There is no guard key to clear, which is
 * the failure mode a ref would have: a guard that outlives the mount has to be
 * cleared by hand on every retraction or the next genuine failure with the same
 * wording goes unannounced.
 *
 * A second attempt that fails the same way is not restated by a re-render. The
 * string is unchanged and the effect does not re-run, so a second copy cannot
 * appear under the first and read as a second, separate problem. A dialog or
 * form still announces it, because `useMutation.run` clears `error` at the top
 * of every attempt: the string goes empty and comes back, which is two runs of
 * the effect and a fresh sentence even when the first has expired. `useApi` does
 * not clear on retry, so a page whose reload fails identically says so on the
 * page rather than in the corner, which is what `LoadError`'s panel is for. One
 * that fails differently announces and retracts the stale reason in one pass.
 *
 * Empty means nothing is wrong, so callers can pass state straight in.
 */
export function useErrorToast(message: string) {
	const toast = useToast();
	useEffect(() => {
		if (!message) return;
		const id = toast.error(message);
		return () => toast.dismiss(id);
	}, [message, toast]);
}

/**
 * A dialog's failed save: the corner toast, plus the announcement.
 *
 * Both halves together in one node so a dialog cannot wire one without the
 * other, because the second half is not optional and is not obvious.
 * `showModal()` makes the rest of the document inert, and inertness does not
 * only stop clicks: it takes the inert subtree out of the accessibility tree
 * altogether. Measured, with the same sentence raised twice, once with no
 * dialog open and once from a dialog's failing save: with no dialog the text is
 * two live nodes in the tree, and with a dialog open it is not in the tree at
 * all. So a corner toast on its own would be seen by a sighted user and never
 * reach a screen reader, which is worse than the footer line it replaces.
 *
 * The fix has to sit inside the dialog, because the dialog is the only part of
 * the document that is not inert. It carries no styling and no layout: it is
 * the same sentence, said once, to the readers the corner cannot reach.
 */
export function DialogError({ message }: { message: string }) {
	useErrorToast(message);
	// Inserted only when there is something to say, which is how the footer line
	// this replaces behaved and what makes `role="alert"` fire reliably.
	if (!message) return null;
	return (
		<p role="alert" className="sr-only">
			{message}
		</p>
	);
}

/**
 * One error slot for one form.
 *
 * A form that can be submitted again needs the corner to hold its *latest*
 * answer and nothing else. Without this, a refusal stayed up (errors do not
 * expire, by design), so a second attempt stacked an identical message under
 * the first, and a third attempt that finally succeeded left the old refusal
 * sitting there while the app navigated away from it: a stale message that
 * reads exactly like a fresh failure.
 *
 * So: clear the slot when a submit starts, fill it when one fails.
 */
export type ErrorSlot = { show: (message: string) => void; clear: () => void };

export function useErrorSlot(): ErrorSlot {
	const toast = useToast();
	const id = useRef<number | null>(null);
	return useMemo(
		() => ({
			show: (message: string) => {
				toast.dismiss(id.current);
				id.current = toast.error(message);
			},
			clear: () => {
				toast.dismiss(id.current);
				id.current = null;
			}
		}),
		[toast]
	);
}

function ToastViewport({
	toasts,
	promotions,
	onDismiss
}: {
	toasts: Toast[];
	promotions: number;
	onDismiss: (id: number) => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [paused, setPaused] = useState(false);

	/**
	 * Into the top layer, or back to the front of it. Opened once and left open
	 * rather than opened when the first toast arrives: a message inserted into a
	 * container that is itself `display: none` until that same moment is the
	 * classic way to have it announced by nobody. Empty, it paints nothing and
	 * takes no clicks.
	 */
	const promote = useCallback(() => {
		const el = ref.current;
		if (!el || typeof el.showPopover !== 'function') return;
		try {
			if (el.matches(':popover-open')) el.hidePopover();
			el.showPopover();
		} catch {
			// A browser without popover support draws the viewport in the page
			// instead. It is then under an open dialog, which is worse than this
			// code being here and better than crashing the app.
		}
	}, []);

	// Every new toast climbs back above whatever entered the top layer since.
	useLayoutEffect(promote, [promote, promotions]);

	// And so does a toast that was already up when a dialog opened. The top layer
	// is ordered by entry, so `showModal()` puts the dialog in front of a
	// viewport promoted earlier, and the error the user is being asked to read
	// disappears behind the thing they opened. Watched here rather than announced
	// by each dialog: a dialog that forgets to say so is a message nobody sees.
	useEffect(() => {
		const seen = new MutationObserver((records) => {
			for (const r of records) {
				if (r.target instanceof HTMLDialogElement && r.target.hasAttribute('open')) {
					promote();
					return;
				}
			}
		});
		seen.observe(document.body, { subtree: true, attributeFilter: ['open'] });
		return () => seen.disconnect();
	}, [promote]);

	/* The pointer or the caret being on the stack holds every clock. Re-read
	   after each removal rather than trusted from the last event: dismissing a
	   toast destroys the element that had focus, and an element removed while
	   focused never fires a blur, so a stack left in the paused state would keep
	   the messages under it on screen for good. */
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		setPaused(el.matches(':hover') || el.contains(document.activeElement));
	}, [toasts.length]);

	return (
		<div
			ref={ref}
			// Manual: this is not anchored to a trigger and must not close itself
			// when something elsewhere is clicked.
			popover="manual"
			className="toasts"
			onMouseEnter={() => setPaused(true)}
			onMouseLeave={() => setPaused(false)}
			onFocus={() => setPaused(true)}
			onBlur={() => setPaused(false)}
		>
			<ol className="toastlist">
				{toasts.map((t) => (
					<ToastRow key={t.id} toast={t} paused={paused} onDismiss={onDismiss} />
				))}
			</ol>
		</div>
	);
}

function ToastRow({
	toast,
	paused,
	onDismiss
}: {
	toast: Toast;
	paused: boolean;
	onDismiss: (id: number) => void;
}) {
	const { id, tone, message } = toast;

	// Pausing is a fresh interval rather than a remembered remainder on purpose:
	// the pointer is over the stack because something is being read, and the
	// simpler rule (the clock restarts when you leave) never expires a message
	// mid-sentence.
	useEffect(() => {
		if (paused) return;
		const timer = window.setTimeout(() => onDismiss(id), tone === 'error' ? ERROR_MS : SUCCESS_MS);
		return () => window.clearTimeout(timer);
	}, [id, tone, paused, onDismiss]);

	return (
		<li className={`toast ${tone === 'error' ? 'bad' : 'ok'}`}>
			{/* Errors interrupt, successes wait their turn, which is the same rule
			    the inline messages followed. */}
			<span role={tone === 'error' ? 'alert' : 'status'}>{message}</span>
			<button
				type="button"
				className="tclose"
				aria-label={copy.ui.modal.closeLabel}
				onClick={() => onDismiss(id)}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path
						d="M4 4l8 8M12 4l-8 8"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
					/>
				</svg>
			</button>
		</li>
	);
}
