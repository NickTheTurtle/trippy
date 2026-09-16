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
 * scroll, reported the outcome somewhere off screen. What stays inline is
 * everything that is about a place rather than a moment: a load that failed is
 * the page's content, and a refusal attached to one field or one dialog is read
 * next to the control it is about.
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
 * up. That is the right end of the trade: focus belongs to the dialog, and an
 * error waits, still there and now pressable, once the dialog closes.
 */
export type ToastTone = 'success' | 'error';

type Toast = { id: number; tone: ToastTone; message: string };

/**
 * How long a success has. Long enough to be read after the eye travels to the
 * corner, short enough that a run of saves does not build a wall.
 */
const SUCCESS_MS = 4500;

/**
 * Errors do not expire. A success repeats the thing the user just watched
 * happen, so losing it costs nothing; an error is the only account of why
 * something did not happen, it often carries the server's own wording, and it
 * frequently arrives from a dialog, where it cannot be dismissed until the
 * dialog closes. A timer there would delete the answer before the reader could
 * reach it. They go when they are dismissed, or when the stack pushes them out.
 */
const MAX = 4;

type ToastApi = {
	/** Ignores an empty message, so callers can pass state straight in. */
	success: (message: string) => void;
	error: (message: string) => void;
	dismiss: (id: number) => void;
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

	const dismiss = useCallback((id: number) => {
		setToasts((list) => list.filter((t) => t.id !== id));
	}, []);

	const push = useCallback((tone: ToastTone, message: string) => {
		if (!message) return;
		const id = nextId.current++;
		// Oldest out first. A cap rather than a scroll: a corner is for the last
		// few things that happened, and a column tall enough to need scrolling is
		// covering the page it is reporting on.
		setToasts((list) => [...list, { id, tone, message }].slice(-MAX));
		setPromotions((n) => n + 1);
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
		if (tone === 'error' || paused) return;
		const timer = window.setTimeout(() => onDismiss(id), SUCCESS_MS);
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
