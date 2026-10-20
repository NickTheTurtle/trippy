import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, TextInput } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { copy } from '@trippy/copy';
import {
	editedAgo,
	mergeNotes,
	MAX_NOTES_BODY,
	rebaseEdit,
	type TripNotes
} from '@trippy/core/notes';
import { api, ApiError, isAbort } from '../../lib/api';
import { useLiveSection } from '../../hooks/useTripEvents';
import { Button, FormError, InsetSection, Loading } from '../../ui';
import { color, rowInset, space, type } from '../../theme';

/** Quiet time after the last keystroke before a save goes out. */
const SAVE_AFTER_MS = 800;
/**
 * Somebody else's text is not put into the box until the typing here has
 * paused this long, as on the web: replacing it under the fingers is what
 * makes a keystroke land on the old text.
 */
const TYPING_MS = 1000;
/** Back-to-back refusals merged and resent before giving up until the next edit, as on the web. */
const MAX_CONFLICTS = 3;
const MIN_HEIGHT = 240;
const t = copy.preparation.notes;

/** A save's answer: the notes, and whether the server merged a stale save into them. */
type Saved = TripNotes & { merged?: boolean };

/**
 * Unsaved text, by trip, kept outside the component. A switch to Tasks, a
 * trip tab change or leaving the trip unmounts the notepad, and its last save
 * may have failed or still be refused; the text has to outlive it. Written on
 * every edit, cleared once the text is the server's.
 */
const drafts = new Map<string, { base: TripNotes; local: string }>();

/**
 * Saves still out for each trip. A notepad mounting again waits for them, so
 * it reads the server after them and the draft they leave behind.
 */
const outstanding = new Map<string, Set<Promise<unknown>>>();

function track(tripId: string, p: Promise<unknown>) {
	const set = outstanding.get(tripId) ?? new Set();
	outstanding.set(tripId, set);
	set.add(p);
	const done = () => {
		set.delete(p);
		if (!set.size) outstanding.delete(tripId);
	};
	p.then(done, done);
}

function settled(tripId: string): Promise<unknown> {
	return Promise.allSettled([...(outstanding.get(tripId) ?? [])]);
}

/**
 * The trip's one shared notepad, which everyone edits. The web's model, with
 * the native text box's own hazard handled.
 *
 * `base` is the server copy the text in the box is derived from, and `local`
 * is that text. Every save sends `{ body: local, version, base: base.body }`,
 * so a save that lost the race is merged by the server (`merged: true`); an
 * older server's 409 is merged here instead, up to three times in a row.
 *
 * The two only move together. Whenever the box's text is replaced from code
 * (a merge, a live update), the replacement is held as pending until the next
 * keystroke: the native box drops a value set from JavaScript if the user has
 * typed since, so that keystroke can arrive based on the old text, and it is
 * rebased onto the new one (`rebaseEdit`) before it is kept. Without that, the
 * next save would send pre-merge text against the post-merge base and delete
 * the other person's lines.
 */
export function Notes({ tripId, refreshKey = 0 }: { tripId: string; refreshKey?: number }) {
	const path = `/trips/${tripId}/pretrip/notes`;
	const [base, setBaseState] = useState<TripNotes | null>(null);
	const [local, setLocalState] = useState('');
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const [loadError, setLoadError] = useState('');
	const [, setTick] = useState(0);
	const [webHeight, setWebHeight] = useState(MIN_HEIGHT);

	const baseRef = useRef<TripNotes | null>(null);
	const localRef = useRef('');
	/** A replacement the box may not have taken yet: what it showed, and what was set. */
	const pending = useRef<{ previous: string; replaced: string } | null>(null);
	/** Bumped on every replacement, so a save's answer knows the text moved under it. */
	const epoch = useRef(0);
	/** The newest server copy seen, waiting for a pause to be taken in. */
	const held = useRef<TripNotes | null>(null);
	const heldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastInput = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const chain = useRef<Promise<void> | null>(null);
	const again = useRef(false);
	/** The save the chain has out, so a background save can be sent after it. */
	/**
	 * The save the chain has out: its body, version and the base it was sent
	 * from, so a background save can be sent after it, and its abort.
	 */
	const flight = useRef<{
		body: string;
		version: number;
		base: string;
		ac: AbortController;
	} | null>(null);
	const busy = useRef(0);
	/** A background save failed; save again when the app is back. */
	const retry = useRef(false);
	/**
	 * False once unmounted. The save chain still finishes after that, but a
	 * held copy is no longer taken in: a new notepad may own the trip's draft.
	 */
	const alive = useRef(true);

	const syncDraft = useCallback(() => {
		const b = baseRef.current;
		if (!b) return;
		if (localRef.current === b.body) drafts.delete(tripId);
		else drafts.set(tripId, { base: b, local: localRef.current });
	}, [tripId]);

	const setBase = useCallback(
		(next: TripNotes) => {
			baseRef.current = next;
			setBaseState(next);
			syncDraft();
		},
		[syncDraft]
	);

	/** Puts text from code into the box, with the base it derives from. */
	const replaceText = useCallback(
		(next: string, nextBase: TripNotes) => {
			if (next !== localRef.current) {
				// A second replacement before any keystroke keeps the first one's
				// `previous`: the box shows either that or a text derived from it.
				pending.current = {
					previous: pending.current?.previous ?? localRef.current,
					replaced: next
				};
				epoch.current += 1;
			}
			localRef.current = next;
			setLocalState(next);
			setBase(nextBase);
		},
		[setBase]
	);

	const markBusy = useCallback((delta: number) => {
		busy.current += delta;
		setSaving(busy.current > 0);
	}, []);

	/**
	 * Takes the newest server copy into the box when that loses nothing: the
	 * text here is all saved, no save is out, and the typing has paused.
	 * Unsaved text keeps the copy waiting; its own save merges on the server.
	 */
	const applyHeld = useCallback(() => {
		if (heldTimer.current) clearTimeout(heldTimer.current);
		heldTimer.current = null;
		const remote = held.current;
		const mine = baseRef.current;
		if (!alive.current || !remote || !mine || remote.version <= mine.version) return;
		if (localRef.current !== mine.body || busy.current > 0) return;
		const quiet = Date.now() - lastInput.current;
		if (quiet < TYPING_MS) {
			heldTimer.current = setTimeout(applyHeld, TYPING_MS - quiet);
			return;
		}
		held.current = null;
		replaceText(remote.body, remote);
	}, [replaceText]);

	const hold = useCallback(
		(remote: TripNotes) => {
			if (held.current && held.current.version >= remote.version) return;
			held.current = remote;
			applyHeld();
		},
		[applyHeld]
	);

	/**
	 * A save's answer. `sent` was the text in the box when it went, at
	 * `sentEpoch`. A copy older than the base is dropped (a newer one already
	 * includes it). If the box's text was replaced since, it no longer derives
	 * from `sent`, so the copy only waits as a remote one.
	 */
	const accept = useCallback(
		(saved: Saved, sent: string, sentEpoch: number) => {
			const { merged, ...notes } = saved;
			const mine = baseRef.current;
			if (!mine || notes.version <= mine.version) return;
			if (epoch.current !== sentEpoch) {
				hold(notes);
				return;
			}
			if (merged) {
				const now = localRef.current;
				replaceText(now === sent ? notes.body : mergeNotes(sent, now, notes.body), notes);
			} else {
				// The server stored `sent`, and the box is `sent` plus any typing since.
				setBase(notes);
			}
		},
		[hold, replaceText, setBase]
	);

	type Outcome = 'ok' | 'conflict' | 'failed' | 'superseded';
	const attempt = useCallback(async (): Promise<Outcome> => {
		const from = baseRef.current;
		if (!from || localRef.current === from.body) return 'ok';
		const sent = localRef.current;
		const sentEpoch = epoch.current;
		const ac = new AbortController();
		flight.current = { body: sent, version: from.version, base: from.body, ac };
		try {
			const saved = await api<Saved>(path, {
				method: 'PUT',
				body: { body: sent, version: from.version, base: from.body },
				signal: ac.signal
			});
			accept(saved, sent, sentEpoch);
			setError('');
			return 'ok';
		} catch (err) {
			// Cancelled by the background save, which carries this text and more.
			if (isAbort(err)) return 'superseded';
			const current = conflictNotes(err);
			if (current) {
				// An older server refused rather than merged. Merge here, if the box
				// still derives from what was sent; otherwise the retry, sent on the
				// newer base, is merged by the server.
				if (
					baseRef.current === from &&
					epoch.current === sentEpoch &&
					current.version > from.version
				) {
					replaceText(mergeNotes(from.body, localRef.current, current.body), current);
				}
				return 'conflict';
			}
			setError(err instanceof ApiError && err.status === 400 ? t.tooLong : t.saveFallback);
			return 'failed';
		} finally {
			flight.current = null;
		}
	}, [path, accept, replaceText]);

	/** Saves now, or after the save that is out. The text stays in `drafts` until it lands. */
	const save = useCallback((): Promise<void> => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		if (chain.current) {
			again.current = true;
			return chain.current;
		}
		const b = baseRef.current;
		if (!b || localRef.current === b.body) {
			applyHeld();
			return Promise.resolve();
		}
		const run = (async () => {
			markBusy(1);
			let conflicts = 0;
			try {
				for (;;) {
					again.current = false;
					const outcome = await attempt();
					if (outcome === 'conflict') {
						if (++conflicts <= MAX_CONFLICTS) continue;
						setError(t.saveFallback);
						break;
					}
					if (outcome === 'failed' || outcome === 'superseded') break;
					conflicts = 0;
					const nb = baseRef.current;
					if (!again.current || !nb || localRef.current === nb.body) break;
				}
			} finally {
				chain.current = null;
				markBusy(-1);
			}
			applyHeld();
		})();
		chain.current = run;
		track(tripId, run);
		return run;
	}, [tripId, attempt, applyHeld, markBusy]);

	const saveRef = useRef(save);
	saveRef.current = save;
	const flush = useCallback(() => void saveRef.current(), []);

	/**
	 * The app is leaving the foreground, and may not run again: save now, even
	 * with a save out. It is sent as though that one has landed (its body as
	 * `base`, its version plus one), which is what happens almost always, and
	 * then it is a plain write of the text typed since. Sent on the same base
	 * and version instead, it reached the server as a stale second edit of the
	 * same line, and the merge kept both copies of the line.
	 *
	 * `priorBase` is the base the save that is out was itself sent from. If that
	 * save never lands, or somebody else took the version, the stored text is
	 * neither, and the server merges from `priorBase` rather than writing over
	 * what is there, so the out save's lines and theirs both survive. Only this
	 * speculative save sends it.
	 *
	 * The save that is out is cancelled first. This one carries all of its text,
	 * and if it were let through to land after this one, the server would merge
	 * it as a stale edit of the line this one already finished, and keep both.
	 */
	const saveNow = useCallback(() => {
		const out = flight.current;
		if (!out) {
			flush();
			return;
		}
		const sent = localRef.current;
		if (sent === out.body) return;
		out.ac.abort();
		const sentEpoch = epoch.current;
		markBusy(1);
		const p = api<Saved>(path, {
			method: 'PUT',
			body: { body: sent, version: out.version + 1, base: out.body, priorBase: out.base }
		})
			.then((saved) => accept(saved, sent, sentEpoch))
			// The cancelled save will not try again, so this failure has to be seen,
			// and the text is saved again when the app comes back.
			.catch((err) => {
				if (!alive.current) return;
				setError(err instanceof ApiError && err.status === 400 ? t.tooLong : t.saveFallback);
				retry.current = true;
			})
			.finally(() => markBusy(-1));
		track(tripId, p);
	}, [path, tripId, accept, flush, markBusy]);

	const load = useCallback(
		async (signal?: AbortSignal) => {
			try {
				await settled(tripId);
				const server = await api<TripNotes>(path, { signal });
				setLoadError('');
				if (baseRef.current) {
					hold(server);
					return;
				}
				// First load. Text left unsaved by an earlier notepad (a failed save,
				// a switch away mid-refusal) is merged into the server's copy and saved.
				const draft = drafts.get(tripId);
				if (draft && draft.local !== draft.base.body) {
					const text =
						draft.base.version === server.version
							? draft.local
							: mergeNotes(draft.base.body, draft.local, server.body);
					localRef.current = text;
					setLocalState(text);
					setBase(server);
					flush();
					return;
				}
				localRef.current = server.body;
				setLocalState(server.body);
				setBase(server);
			} catch (err) {
				if (isAbort(err)) return;
				// Once the notepad is showing, a failed refetch keeps what it has.
				if (!baseRef.current) {
					setLoadError(err instanceof ApiError ? err.message : copy.api.loadFailed);
				}
			}
		},
		[tripId, path, hold, setBase, flush]
	);

	useEffect(() => {
		const ac = new AbortController();
		void load(ac.signal);
		return () => ac.abort();
	}, [load]);

	// Pull to refresh on the Preparation page refetches the notepad too.
	const firstRefresh = useRef(refreshKey);
	useEffect(() => {
		if (refreshKey !== firstRefresh.current) void load();
	}, [refreshKey, load]);

	useLiveSection(
		['notes'],
		useCallback(() => void load(), [load])
	);

	// Leaving the section (the notepad unmounts) or the tab (it blurs; native
	// tabs keep it mounted) saves what has been typed.
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			if (heldTimer.current) clearTimeout(heldTimer.current);
			flush();
		};
	}, [flush]);
	useFocusEffect(useCallback(() => flush, [flush]));
	useEffect(() => {
		const sub = AppState.addEventListener('change', (next) => {
			if (next !== 'active') {
				saveNow();
			} else if (retry.current) {
				retry.current = false;
				flush();
			}
		});
		return () => sub.remove();
	}, [saveNow, flush]);

	// "2 min ago" moves on by itself.
	useEffect(() => {
		const id = setInterval(() => setTick((n) => n + 1), 60_000);
		return () => clearInterval(id);
	}, []);

	if (!base) {
		if (!loadError) return <Loading />;
		return (
			<>
				<FormError message={loadError} />
				<Button label={copy.api.retry} onPress={() => void load()} />
			</>
		);
	}

	// The status describes the text in the box, so it is the base's editor, as
	// on the web. Read at render: the tick above only forces the render.
	const status = saving
		? t.saving
		: base.updatedAt !== null && base.updatedBy
			? t.editedBy(base.updatedBy.name, editedAgo(base.updatedAt, Date.now()))
			: undefined;

	return (
		<InsetSection footer={status} error={error || undefined}>
			<TextInput
				accessibilityLabel={t.label}
				placeholder={t.placeholder}
				placeholderTextColor={color.inkFaint}
				value={local}
				maxLength={MAX_NOTES_BODY}
				multiline
				// The box grows with its text and the screen scrolls, as a note does
				// in Notes, rather than a box scrolling inside the page.
				scrollEnabled={false}
				onChangeText={(incoming) => {
					lastInput.current = Date.now();
					let text = incoming;
					const p = pending.current;
					if (p) {
						// The first keystroke after a replacement: rebase it onto the
						// replaced text, whichever of the two the box was showing.
						text = rebaseEdit(p.previous, p.replaced, incoming);
						pending.current = text === incoming ? null : { previous: incoming, replaced: text };
					}
					localRef.current = text;
					setLocalState(text);
					syncDraft();
					if (timer.current) clearTimeout(timer.current);
					timer.current = setTimeout(flush, SAVE_AFTER_MS);
				}}
				onBlur={flush}
				// iOS grows a multiline box by itself; the web preview's textarea
				// does not, so there it is sized from the height it reports. The web
				// also loses the browser's focus ring: a note has no box round it.
				onContentSizeChange={
					Platform.OS === 'web'
						? (e) => setWebHeight(Math.max(MIN_HEIGHT, Math.ceil(e.nativeEvent.contentSize.height)))
						: undefined
				}
				style={[
					s.pad,
					Platform.OS === 'web' && { height: webHeight, outlineStyle: 'solid', outlineWidth: 0 }
				]}
			/>
		</InsetSection>
	);
}

/** The server's current notes, when a save was refused as stale. */
function conflictNotes(err: unknown): TripNotes | null {
	if (!(err instanceof ApiError) || err.status !== 409) return null;
	const notes = (err.payload as { notes?: TripNotes } | null)?.notes;
	return notes && typeof notes.body === 'string' && typeof notes.version === 'number'
		? notes
		: null;
}

const s = StyleSheet.create({
	// Body type on the card itself, no box of its own, the way a note is a page.
	pad: {
		...type.body,
		minHeight: MIN_HEIGHT,
		textAlignVertical: 'top',
		paddingHorizontal: rowInset,
		paddingTop: space.md,
		paddingBottom: space.lg,
		backgroundColor: color.surface
	}
});
