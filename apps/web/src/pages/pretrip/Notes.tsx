import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
	MAX_NOTES_BODY,
	editedAgo,
	mergeNotes,
	rebaseEdit,
	type TripNotes
} from '@trippy/core/notes';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../hooks/useApi';
import { useLiveSection } from '../../hooks/useTripEvents';
import LoadError from '../../components/ui/LoadError';
import Loading from '../../components/ui/Loading';
import { copy } from '../../copy';

const cn = copy.preparation.notes;

/** Quiet time after the last keystroke before a save goes out. */
const IDLE_MS = 800;
/**
 * A collaborator's text is not dropped into the box while this one is being
 * typed in, even with nothing unsaved: the caret would jump under the fingers.
 */
const TYPING_MS = 1000;
/** Back-to-back 409s merged and resent before giving up until the next edit. */
const MAX_CONFLICTS = 3;
/** How often "Edited by ... 2 min ago" is brought up to date. */
const TICK_MS = 60_000;

/** A save's answer. `merged` is set when the server folded a stale save into newer text. */
type Saved = TripNotes & { merged?: boolean };

/** The save on the wire. */
type InFlight = {
	/** The text it carries. */
	body: string;
	/** The version it was sent on. */
	version: number;
	/** The base text it was sent from: `priorBase` for a save sent on top of it. */
	base: string;
	/** Cancels it. Null for a keepalive save, which is left to land. */
	abort: (() => void) | null;
	/** Set when `sendNow` cancelled it and sent its text itself. */
	superseded: boolean;
};

/**
 * Unsaved text, by notepad path: what is in the box and the server copy it was
 * typed over. Outside the component on purpose. A section switch unmounts the
 * notepad, and if the save it sends on the way out fails (offline, or out of
 * retries) the text would otherwise exist nowhere. Written on every edit and
 * dropped once a save of exactly that text succeeds; a notepad that mounts and
 * finds an entry merges it into what the server has now and saves it.
 */
const drafts = new Map<string, { base: TripNotes; local: string }>();

/**
 * The save still out for each notepad, by path. A notepad that mounts while
 * its previous self's last save is in flight waits for it and then loads, so
 * the draft above and the server copy it merges into are both settled.
 */
const outstanding = new Map<string, Promise<unknown>>();

/**
 * The trip's one shared notepad: a plain text box everyone edits, saved as you
 * go. See docs/DESIGN.md 5.0.4.
 *
 * Two copies of the text are kept. `base` is the server copy the box was
 * derived from (its body and its version); `local` is what is in the box. A
 * save sends `{ body: local, version: base.version, base: base.body }`, so a
 * save that turns out to be stale is merged by the server rather than refused;
 * a 409 is still handled, by merging here with the core's `mergeNotes`.
 *
 * Whenever the box's text is replaced from outside (a merge, a collaborator's
 * text), the new text and the new base move together, and the box's DOM value
 * is written before this function returns. A keystroke can then never be
 * applied to the text from before the replacement, store that as `local`, and
 * have the next save delete what the merge brought in.
 *
 * The save machinery reads refs rather than state, because it has to keep
 * going after the section unmounts: switching section, or leaving the page, is
 * exactly when the last few keystrokes go out.
 */
export default function Notes({ tripId }: { tripId: string }) {
	const path = `/trips/${tripId}/pretrip/notes`;
	const { data, error, reload } = useApi<TripNotes>(path);
	// Held back while a field has focus everywhere else; here the box *is* the
	// focused field, and what arrives is merged rather than overwritten.
	useLiveSection(['notes'], reload, { whileBusy: true });

	const [base, setBaseState] = useState<TripNotes | null>(null);
	const [text, setText] = useState('');
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [, setTick] = useState(0);

	const box = useRef<HTMLTextAreaElement>(null);
	const pathRef = useRef(path);
	pathRef.current = path;
	const baseRef = useRef<TripNotes | null>(null);
	const localRef = useRef('');
	/** The save on the wire. */
	const inFlight = useRef<InFlight | null>(null);
	const queued = useRef(false);
	const conflicts = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastInput = useRef(0);
	const composing = useRef(false);
	/** Bumped on every replacement of the box from outside. */
	const generation = useRef(0);
	/**
	 * The last replacement, until the next keystroke. That keystroke is run
	 * through `rebaseEdit`, which keeps it as is when it was made on the new
	 * text and merges it onto the new text when it was made on the old one.
	 * Belt and braces: the replacement is already in the DOM by then.
	 */
	const pending = useRef<{ previous: string; replaced: string } | null>(null);
	/** A newer copy from the server, waiting for the typing to pause. */
	const held = useRef<TripNotes | null>(null);
	const heldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	/** Mirrors `local` against `base` into `drafts`: kept while they differ. */
	const writeDraft = useCallback(() => {
		const b = baseRef.current;
		if (!b) return;
		if (localRef.current === b.body) drafts.delete(pathRef.current);
		else drafts.set(pathRef.current, { base: b, local: localRef.current });
	}, []);

	/**
	 * Moves `base` on without touching the box. Only for a save answered with
	 * exactly the text it sent: what is in the box now was typed on top of that
	 * text, so it is still derived from the new base.
	 */
	const advanceBase = useCallback(
		(n: TripNotes) => {
			baseRef.current = n;
			setBaseState(n);
			writeDraft();
		},
		[writeDraft]
	);

	/**
	 * Replaces the box's text and its base in one step, from outside the box.
	 *
	 * Rendered with `flushSync` and then checked against the DOM, so by the time
	 * this returns the textarea holds `next` and the next keystroke edits it.
	 * The selection is carried over: only the common prefix is compared, so an
	 * edit after the caret leaves it where it is and an edit before it moves it
	 * along by the difference in length. Must not be called from inside a
	 * React effect, where `flushSync` cannot flush; the DOM write below covers
	 * it if it ever is.
	 */
	const replaceBox = useCallback(
		(next: string, newBase: TripNotes) => {
			const el = box.current;
			const prev = localRef.current;
			let sel: [number, number] | null = null;
			if (el && document.activeElement === el && prev !== next) {
				let p = 0;
				while (p < prev.length && p < next.length && prev[p] === next[p]) p++;
				const shift = next.length - prev.length;
				const move = (i: number) => (i <= p ? i : Math.max(p, i + shift));
				sel = [move(el.selectionStart), move(el.selectionEnd)];
			}
			generation.current++;
			baseRef.current = newBase;
			localRef.current = next;
			writeDraft();
			if (el) {
				flushSync(() => {
					setBaseState(newBase);
					setText(next);
				});
				if (el.value !== next) el.value = next;
				if (sel) el.setSelectionRange(sel[0], sel[1]);
			} else {
				// Unmounted: nothing to type into, and nothing to flush.
				setBaseState(newBase);
				setText(next);
			}
			pending.current = prev === next ? null : { previous: prev, replaced: next };
		},
		[writeDraft]
	);

	/**
	 * Folds a successful save's answer in. `sent` is the text that save carried,
	 * and the box must still be derived from it (nothing replaced it since).
	 */
	const adopt = useCallback(
		(sent: string, n: Saved) => {
			const notes = toNotes(n);
			if (notes.body === sent) {
				advanceBase(notes);
				return;
			}
			// The server merged a stale save into newer text. Anything typed while
			// the save was out is kept by merging it in as well.
			replaceBox(mergeNotes(sent, localRef.current, notes.body), notes);
		},
		[advanceBase, replaceBox]
	);

	const save = useCallback(
		(keepalive = false) => {
			if (timer.current) clearTimeout(timer.current);
			timer.current = null;
			const sentOn = baseRef.current;
			if (!sentOn) return;
			// One save at a time; the latest text is sent when this one is back.
			if (inFlight.current) {
				queued.current = true;
				return;
			}
			queued.current = false;
			const body = localRef.current;
			if (body === sentOn.body) return;
			// The box's own `maxLength` stops typing past the ceiling, but a merge
			// can still carry two long edits over it. Said here rather than sent to
			// be refused.
			if (body.length > MAX_NOTES_BODY) {
				setProblem(cn.tooLong);
				return;
			}

			// An ordinary save can be cancelled by `sendNow`, which then carries its
			// text itself. A keepalive one is left to land on its own.
			const controller = keepalive ? null : new AbortController();
			const record: InFlight = {
				body,
				version: sentOn.version,
				base: sentOn.body,
				abort: controller ? () => controller.abort() : null,
				superseded: false
			};
			inFlight.current = record;
			setSaving(true);
			const savePath = pathRef.current;
			const request = api<Saved>(savePath, {
				method: 'PUT',
				body: { body, version: sentOn.version, base: sentOn.body },
				keepalive,
				signal: controller?.signal
			})
				.then((n) => {
					conflicts.current = 0;
					adopt(body, n);
					setProblem(null);
				})
				.catch((err: unknown) => {
					// Cancelled for the save `sendNow` sent in its place: nothing failed.
					if (record.superseded) return;
					const current = conflictCopy(err);
					if (current) {
						// Merged against what is in the box now, not what was sent: the
						// typing may have carried on while this was out.
						replaceBox(mergeNotes(sentOn.body, localRef.current, current.body), current);
						conflicts.current++;
						if (conflicts.current <= MAX_CONFLICTS) {
							queued.current = true;
							return;
						}
					}
					// The text stays in the box and in `drafts`; the next edit, or the
					// next time this notepad mounts, sends it again.
					conflicts.current = 0;
					setProblem(
						err instanceof ApiError && err.status !== 0 && err.status !== 409
							? err.message
							: cn.saveFallback
					);
				})
				.finally(() => {
					if (inFlight.current === record) inFlight.current = null;
					setSaving(false);
					if (outstanding.get(savePath) === request) outstanding.delete(savePath);
					// A superseded save's follow-up belongs to the save that replaced it.
					if (record.superseded) return;
					if (queued.current) save();
					else applyHeld();
				});
			outstanding.set(savePath, request);
		},
		// `applyHeld` is declared below; it is stable and reads only refs, so the
		// copy this closure sees is the same one every render would hand it.
		[adopt, replaceBox]
	);

	/**
	 * The tab is being hidden or closed: send the latest text now, even with a
	 * save already out, because the page may not get to send the queued one.
	 * It goes on the in-flight save's text and the version that save will make.
	 * That save may never land (dropped with the page, or refused), so this one
	 * also names the base it was sent from, `priorBase`: the server writes it as
	 * is over either text, and otherwise merges from `priorBase`, which keeps the
	 * in-flight save's lines even if the server never saw them.
	 *
	 * The in-flight save is cancelled first when it can be (an ordinary one; a
	 * keepalive one cannot be recalled), since this one carries everything it
	 * had. If it was already past the network and lands late, the server merges
	 * it into this one's text, and the core merge folds a line that one side
	 * only extended into a single copy.
	 */
	const sendNow = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		const out = inFlight.current;
		if (!out) {
			save(true);
			return;
		}
		const body = localRef.current;
		if (body === out.body || body.length > MAX_NOTES_BODY) return;
		if (out.abort) {
			out.superseded = true;
			inFlight.current = null;
			queued.current = false;
			out.abort();
		}
		const gen = generation.current;
		api<Saved>(pathRef.current, {
			method: 'PUT',
			body: { body, version: out.version + 1, base: out.body, priorBase: out.base },
			keepalive: true
		})
			.then((n) => {
				// The page lived. If the box is still derived from what this sent,
				// take the answer; otherwise let an ordinary save reconcile.
				if (!inFlight.current && generation.current === gen) adopt(body, n);
				else {
					queued.current = true;
					if (!inFlight.current) save();
				}
			})
			.catch(() => {
				// Still in the box and in `drafts`. With the in-flight save cancelled
				// nothing else would send it, so the ordinary path does.
				if (inFlight.current) queued.current = true;
				else save();
			});
	}, [adopt, save]);

	/**
	 * Takes the server's newer copy, if it is safe to. With nothing unsaved it
	 * waits for the typing to pause, then replaces the box. With unsaved text the
	 * copy is dropped and a save is made (unless one is already due): it goes on
	 * the old version with `base`, and the server merges the two.
	 */
	const applyHeld = useCallback(() => {
		if (heldTimer.current) clearTimeout(heldTimer.current);
		heldTimer.current = null;
		const remote = held.current;
		const mine = baseRef.current;
		if (!remote || !mine) return;
		if (remote.version <= mine.version) {
			held.current = null;
			return;
		}
		if (localRef.current !== mine.body) {
			held.current = null;
			if (!timer.current && !inFlight.current) save();
			return;
		}
		if (inFlight.current || composing.current || Date.now() - lastInput.current < TYPING_MS) {
			heldTimer.current = setTimeout(applyHeld, TYPING_MS);
			return;
		}
		held.current = null;
		replaceBox(remote.body, remote);
	}, [replaceBox, save]);

	// Every load: the first one, and each refetch a `notes` event asks for.
	useEffect(() => {
		if (!data) return;
		if (!baseRef.current) {
			const prior = outstanding.get(path);
			if (prior) {
				// Settled either way, it is the server's copy after it that counts.
				void prior.finally(reload);
				return;
			}
			// Text that never made it to the server (a save that failed as the
			// section was left) is merged into what the server has now.
			const draft = drafts.get(path);
			const local =
				draft && draft.local !== draft.base.body
					? mergeNotes(draft.base.body, draft.local, data.body)
					: data.body;
			baseRef.current = data;
			setBaseState(data);
			localRef.current = local;
			setText(local);
			writeDraft();
			if (local !== data.body) save();
			return;
		}
		held.current = data;
		// Out of the effect, so a replacement can be flushed to the DOM at once.
		if (heldTimer.current) clearTimeout(heldTimer.current);
		heldTimer.current = setTimeout(applyHeld, 0);
	}, [data, path, reload, writeDraft, save, applyHeld]);

	// Leaving is when the last keystrokes are most at risk: a hidden or closing
	// tab, and this section going away (another section, another tab of the
	// trip). Those saves may outlive the page, so they go as keepalive.
	useEffect(() => {
		const visibility = () => {
			if (document.visibilityState === 'hidden') sendNow();
		};
		window.addEventListener('pagehide', sendNow);
		document.addEventListener('visibilitychange', visibility);
		return () => {
			window.removeEventListener('pagehide', sendNow);
			document.removeEventListener('visibilitychange', visibility);
			if (heldTimer.current) clearTimeout(heldTimer.current);
			heldTimer.current = null;
			save(true);
		};
	}, [save, sendNow]);

	useEffect(() => {
		const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
		return () => clearInterval(id);
	}, []);

	useLayoutEffect(() => {
		if (box.current && !GROWS_BY_ITSELF) grow(box.current);
	}, [text]);

	if (!base) return error ? <LoadError message={error} onRetry={reload} /> : <Loading />;

	const status = saving
		? cn.saving
		: problem
			? problem
			: base.updatedBy && base.updatedAt !== null
				? cn.editedBy(base.updatedBy.name, editedAgo(base.updatedAt, Date.now()))
				: null;

	return (
		<div className="min-w-0">
			{/* A refetch that fails under text already on screen is only a result. */}
			{error && <LoadError message={error} panel={false} />}
			<textarea
				ref={box}
				className="input notepad"
				aria-label={cn.label}
				placeholder={cn.placeholder}
				maxLength={MAX_NOTES_BODY}
				value={text}
				spellCheck
				onChange={(e) => {
					let value = e.target.value;
					const p = pending.current;
					pending.current = null;
					if (p) value = rebaseEdit(p.previous, p.replaced, value);
					lastInput.current = Date.now();
					localRef.current = value;
					setText(value);
					writeDraft();
					if (timer.current) clearTimeout(timer.current);
					timer.current = setTimeout(() => save(), IDLE_MS);
				}}
				onBlur={() => save()}
				onCompositionStart={() => {
					composing.current = true;
				}}
				onCompositionEnd={() => {
					composing.current = false;
				}}
			/>
			{/* The line stays in the layout when it is empty, so the first save
			    does not nudge anything below it. A failure is announced; the
			    routine "Saving..." and "Edited by" are not, or a screen reader
			    would speak on every pause in the typing. */}
			<p className="notepad-status">
				{problem && !saving ? (
					<span role="alert" className="text-danger-ink">
						{status}
					</span>
				) : (
					status
				)}
			</p>
		</div>
	);
}

/** The notes alone, without the `merged` flag a save's answer may carry. */
function toNotes(n: Saved): TripNotes {
	return { body: n.body, version: n.version, updatedAt: n.updatedAt, updatedBy: n.updatedBy };
}

/** The server's current copy, when `err` is a version refusal that carries it. */
function conflictCopy(err: unknown): TripNotes | null {
	if (!(err instanceof ApiError) || err.status !== 409) return null;
	const notes = (err.payload as { notes?: unknown } | null)?.notes as TripNotes | undefined;
	return notes && typeof notes.body === 'string' && typeof notes.version === 'number'
		? notes
		: null;
}

/**
 * `field-sizing: content` grows the box with its text in the stylesheet alone.
 * Where it is not supported the height is set by hand after each change.
 */
const GROWS_BY_ITSELF =
	typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
		? CSS.supports('field-sizing', 'content')
		: false;

function grow(el: HTMLTextAreaElement): void {
	// Collapsing the box to measure it shortens the page for a moment, and the
	// browser clamps the scroll position to fit; put it back.
	const y = window.scrollY;
	el.style.height = 'auto';
	el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
	if (window.scrollY !== y) window.scrollTo(window.scrollX, y);
}
