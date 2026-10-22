import { useEffect, useMemo, useRef, useState } from 'react';
import { guessLeg, minsByMode, rekeyLeg } from '@trippy/core/travel';
import { api } from '../../lib/api';
import Select, { type Option } from '../../components/ui/Select';
import { FieldShell } from '../../components/ui/Field';
import { WarningIcon } from '../../components/ui/icons';
import { copy } from '../../copy';
import { MODE_OPTIONS, modeLabel } from './shared';
import type { EventRow, LegDraft, LegDrafts, LegRow } from './types';

const cj = copy.schedule.journey;

/**
 * What a reader has said about a journey: only the fields they touched.
 *
 * It used to be a copy of all three, taken on the first keystroke in any of
 * them, so naming a journey and then moving the event in the same dialog
 * pinned the minutes the journey had before the move: the bar stayed at the
 * old length and the save wrote a duration nobody typed. Anything not touched
 * is read off the journey as it now stands, so it follows the edit. The same
 * shape as mobile's `JourneyEdit`.
 */
type LegEdit = { title?: string; mode?: string; mins?: string };

/** A journey's three fields as a card shows them and a save compares them. */
type LegFields = { title: string; mode: string; mins: string };

const legEdit = (l: LegRow): LegFields => ({
	title: l.title ?? '',
	mode: l.resolvedMode,
	mins: String(l.resolvedMins)
});

/**
 * The card as shown: each touched field as typed, the rest from the journey. A
 * mode picked without minutes shows that mode's estimate, so it too follows
 * the event if the event is then moved.
 */
const shownOf = (l: LegRow, e: LegEdit | undefined): LegFields => {
	if (!e) return legEdit(l);
	const mode = e.mode ?? l.resolvedMode;
	return {
		title: e.title ?? l.title ?? '',
		mode,
		mins: e.mins ?? (e.mode != null ? String(estimateFor(l, mode)) : String(l.resolvedMins))
	};
};

/** Whether the card says how the journey is made, as opposed to only naming it. */
const saysHow = (e: LegEdit | undefined) => e?.mode != null || e?.mins != null;

/** Typed minutes as a duration, or null for an emptied box or a zero on the way to ten. */
const parseMins = (text: string): number | null => {
	const n = text.trim() === '' ? NaN : Number(text);
	return Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
};

const sameEdit = (a: LegFields, b: LegFields) =>
	a.mode === b.mode && a.mins === b.mins && a.title.trim() === b.title.trim();

/**
 * What this journey is reckoned to take by a given mode.
 *
 * The provider answers for one mode, the one the day is planned on, so any
 * other mode is answered from the distance by the same rule the server falls
 * back on. Asking the provider for each mode as the picker is opened would buy
 * five routes to show one.
 */
const estimateFor = (l: LegRow, mode: string) =>
	mode === l.autoMode && l.autoMins != null ? l.autoMins : minsByMode(l.km, mode);

/** What the journey resolves to with nothing said about it. */
const automatic = (l: LegRow) => {
	const mode = l.autoMode ?? guessLeg(l.km).mode;
	return { mode, mins: estimateFor(l, mode) };
};

/**
 * Whether an edit is just what the day would have worked out anyway.
 *
 * Derived rather than tracked, so there is no flag to keep in step and no
 * label to explain: a journey left at its own mode and its own estimate is
 * stored as unpinned, and typing that estimate back is how it is unpinned.
 */
const isAutomatic = (l: LegRow, e: LegFields) => {
	const a = automatic(l);
	const mins = Number(e.mins);
	/* A routing answer can land between the pick and the save, so the straight
	   line guess the reader was shown counts as automatic too; otherwise a
	   journey nobody meant to pin would be pinned by the provider's timing. */
	return e.mode === a.mode && (mins === a.mins || mins === minsByMode(l.km, e.mode));
};

/**
 * The modes, each with what this journey would take by it.
 *
 * The estimate is a hint rather than part of the label, so it shows while the
 * reader is choosing and not afterwards: once a mode is picked its duration is
 * in the box beside the picker, and saying it twice on one line is noise.
 */
const modeOptionsFor = (l: LegRow): Option[] =>
	MODE_OPTIONS.map((o) => ({ ...o, hint: cj.estimate(estimateFor(l, o.value)) }));

/**
 * A card in "Getting here": one journey, or several that start in the same place.
 *
 * Journeys are derived from who is going, so two groups that set off from the
 * same spot for the same block are two rows saying the same thing, and anyone
 * changing one means both. They are shown as one card, and the card writes to
 * every journey under it. Splitting is for the day where it is not one answer
 * after all: half the party takes a taxi and the rest walk.
 *
 * A group is only offered as one card when its journeys start in the same
 * place. Everything else is genuinely a different journey, however alike the
 * numbers happen to look.
 */
type Journey = { key: string; legs: LegRow[]; merged: boolean };

/**
 * Where a journey sets off from, as an identity two journeys can share.
 *
 * The coordinates rather than the event, because two different blocks at the
 * same hotel are the same starting point to a traveller. Five decimal places is
 * about a metre. A journey whose origin is not on the board (the first one of
 * the morning leaves last night's stay) stands alone rather than being guessed
 * at.
 */
const originKey = (l: LegRow, from: EventRow | null) =>
	from && from.lat != null && from.lng != null
		? `${from.lat.toFixed(5)},${from.lng.toFixed(5)}`
		: `at:${l.fromEventId}`;

const toggle = (set: Set<string>, key: string, on: boolean) => {
	const next = new Set(set);
	if (on) next.add(key);
	else next.delete(key);
	return next;
};

/**
 * The journeys arriving at one block, as a section of its dialog and a save.
 *
 * A journey has no dialog of its own. It is not a thing anybody creates: the
 * server plans one for every pair of consecutive events a given set of people
 * attends, so it only exists as the approach to the event it arrives at, and
 * that is where it is edited. There can be several, one per group of people
 * converging on the same block, which is why this is a list and not a field.
 *
 * Shared by the add and the edit dialog, which ask the same question. Adding is
 * in fact when it matters most: choosing who is going is what makes journeys
 * exist, so a block added without this section arrives with a day's travel
 * planned that nobody was shown.
 */
export function useJourneys({
	legs,
	live,
	eventOf,
	peopleLabel,
	participants,
	focusLegId,
	onDraft
}: {
	/** The journeys that arrive at this block, replanned as the edit is typed. */
	legs: LegRow[];
	/**
	 * The same journeys as the board draws them, with what these cards say laid
	 * over the top. `legs` stays the cards' baseline, since a card compared with
	 * a row that already holds its own edit would read as untouched and never
	 * be saved; this is what the warning is read off, so it follows the board.
	 */
	live?: LegRow[];
	/** Another event on the board, or null when it is not loaded. */
	eventOf: (eventId: string) => EventRow | null;
	peopleLabel: (ids: string[]) => string;
	/** Who the block is for, as its Participants field holds it ([] is everyone). */
	participants: string[];
	/** The journey the reader pointed at, if they arrived here by clicking one. */
	focusLegId?: string;
	/** What the cards say so far, by leg key, or null once the dialog is gone. */
	onDraft?: (said: LegDrafts | null) => void;
}) {
	/* What the reader has said about a journey, keyed by leg key rather than by
	   leg id: an edit to who is going replans the day, so the row a journey is
	   stored in can appear, vanish or arrive only on save, while the key is what
	   both ends compute from the same facts. Only touched journeys are held, so
	   an untouched one always shows the live estimate. */
	const [edits, setEdits] = useState<Record<string, LegEdit>>({});
	/* Groups the reader has taken apart, and groups they have put together. Two
	   sets rather than one flag because the default is neither: a group whose
	   journeys already agree reads as one card until somebody says otherwise. */
	const [split, setSplit] = useState<Set<string>>(new Set());
	const [joined, setJoined] = useState<Set<string>>(new Set());

	const editOf = (l: LegRow) => shownOf(l, edits[l.key]);
	const setEdit = (group: LegRow[], patch: LegEdit) =>
		setEdits((m) => {
			const next = { ...m };
			for (const l of group) next[l.key] = { ...m[l.key], ...patch };
			return next;
		});

	/**
	 * What merging into `lead`'s card writes to every journey in the group.
	 *
	 * The fields the lead's reader touched, as typed. Of the rest, the name, the
	 * mode and the minutes only where the group disagrees on them, since one
	 * card has to show one answer and merging is choosing it; where the group
	 * agrees they are left untouched and keep following the event. So merging
	 * journeys that already agree and then moving the event cannot pin the
	 * minutes the journey had before the move, while merging a 12-minute walk
	 * with a pinned 30-minute one saves the 12 that the card shows.
	 */
	const mergeFrom = (lead: LegRow, group: LegRow[]): LegEdit => {
		const e = edits[lead.key];
		const shown = shownOf(lead, e);
		const all = group.map((l) => shownOf(l, edits[l.key]));
		const patch: LegEdit = {};
		if (e?.title != null) patch.title = e.title;
		else if (all.some((s) => s.title.trim() !== shown.title.trim())) patch.title = shown.title;
		if (e?.mode != null) patch.mode = e.mode;
		else if (all.some((s) => s.mode !== shown.mode)) patch.mode = shown.mode;
		// Minutes are compared after the name and mode above apply, so two
		// journeys that become the same mode over the same ground agree on its
		// estimate and nothing is pinned.
		const after = group.map((l) => shownOf(l, { ...edits[l.key], ...patch }));
		if (e?.mins != null) patch.mins = e.mins;
		else if (after.some((s) => s.mins !== shown.mins)) patch.mins = shown.mins;
		else patch.mins = undefined;
		return patch;
	};

	/* Changing the mode re-answers the question the number is an answer to. A
	   walk and a taxi over the same ground are not the same twelve minutes, and
	   leaving the old number there would state a duration nobody believes. So a
	   picked mode drops any typed minutes, and the card shows the mode's estimate
	   until a number is typed again. */
	const pickMode = (group: LegRow[], mode: string) =>
		setEdits((m) => {
			const next = { ...m };
			for (const l of group) next[l.key] = { ...m[l.key], mode, mins: undefined };
			return next;
		});

	/* What the cards say, as the board reads it: only journeys whose card
	   differs from the day as it stands, so an untouched or reverted card leaves
	   the bar exactly as it was. A card that has only renamed its journey says
	   nothing about how it is made, so the bar keeps following the event.
	   Minutes that are not a usable number yet are left to the mode's estimate
	   rather than drawn as a one-minute journey. */
	const said = useMemo(() => {
		const out: Record<string, LegDraft> = {};
		for (const l of legs) {
			const e = edits[l.key];
			const shown = shownOf(l, e);
			if (!e || sameEdit(shown, legEdit(l))) continue;
			const how = saysHow(e);
			out[l.key] = {
				title: shown.title.trim() || null,
				mode: how ? shown.mode : null,
				mins: how && e.mins != null ? parseMins(e.mins) : null
			};
		}
		return out;
	}, [legs, edits]);
	/* Reported up the way the event draft is, through a ref so an inline
	   callback does not re-fire the effect, and withdrawn when the dialog goes,
	   saved or not, so a cancel puts the board back exactly. */
	const report = useRef(onDraft);
	report.current = onDraft;
	useEffect(() => {
		report.current?.(said);
	}, [said]);
	useEffect(() => () => report.current?.(null), []);

	/** Each journey as the board is drawing it, which is where its warning is read. */
	const drawn = useMemo(() => new Map((live ?? legs).map((l) => [l.key, l])), [live, legs]);

	/**
	 * The journeys as cards: one per starting place, unless the reader has taken
	 * a place's journeys apart.
	 *
	 * Recomputed from the live list, so a change to who is going lands here as
	 * groups appearing, merging and disappearing rather than as a stale list.
	 */
	const journeys: Journey[] = useMemo(() => {
		const order: string[] = [];
		const byOrigin = new Map<string, LegRow[]>();
		for (const l of legs) {
			const k = originKey(l, eventOf(l.fromEventId));
			const list = byOrigin.get(k);
			if (list) list.push(l);
			else {
				byOrigin.set(k, [l]);
				order.push(k);
			}
		}
		return order.flatMap((k): Journey[] => {
			const group = byOrigin.get(k) as LegRow[];
			const first = editOf(group[0]);
			const agree = group.every((l) => sameEdit(editOf(l), first));
			const merged = group.length > 1 && !split.has(k) && (joined.has(k) || agree);
			return merged
				? [{ key: k, legs: group, merged: true }]
				: group.map((l) => ({ key: k, legs: [l], merged: false }));
		});
		// `edits` decides whether a group still agrees, so it belongs here.
	}, [legs, edits, split, joined, eventOf]);

	/**
	 * Writes what the reader said, after the event itself has been written.
	 *
	 * Matched by key rather than by id. A journey the reader set up may not have
	 * had a row when they set it up: changing who is going is what makes
	 * journeys exist, and the row only arrives when the server replans off the
	 * people just saved. The key is the same on both sides, so reading the day
	 * back is what turns what they said into the rows to write. A block being
	 * added is keyed under its draft id until the save gives it a real one,
	 * which is what `toEventId` re-points them at.
	 *
	 * Only touched journeys are written. A journey is unpinned by default, so
	 * sending every one back would pin a whole day's travel as the price of
	 * renaming one event.
	 */
	const save = async (base: string, day: string, toEventId: string) => {
		const touched = legs.filter(
			(l) => edits[l.key] && !sameEdit(shownOf(l, edits[l.key]), legEdit(l))
		);
		if (!touched.length) return;
		const fresh = await api<{ board: { legs: LegRow[] }[] }>(`${base}?day=${day}`);
		const rows = new Map(fresh.board.flatMap((b) => b.legs).map((l) => [l.key, l]));
		for (const l of touched) {
			const row = rows.get(rekeyLeg(l.key, toEventId));
			// A journey the save has planned away is not one to write to.
			if (!row) continue;
			const e = edits[l.key];
			// Read against the row as saved, so an untouched field is what the
			// journey now is, not what it was when the dialog opened.
			const now = shownOf(row, e);
			const legTitle = now.title.trim();
			const mins = parseMins(now.mins) ?? estimateFor(row, now.mode);
			await api(`${base}/legs/${row.id}`, {
				method: 'PATCH',
				// The route writes mode and minutes on every call, so a rename alone
				// sends back whatever the row already holds: a pin stays a pin and an
				// unpinned journey stays free to follow its events. Empty mode and
				// minutes is the reset, and the name is not part of it.
				body: !saysHow(e)
					? { mode: row.mode ?? '', mins: row.mins ?? '', title: legTitle }
					: isAutomatic(row, { ...now, mins: String(mins) })
						? { mode: '', mins: '', title: legTitle }
						: { mode: now.mode, mins, title: legTitle }
			});
		}
	};

	const section = journeys.length > 0 && (
		<section className="jsec">
			<h3 className="jhead">{cj.heading}</h3>
			{journeys.map((j) => {
				const lead = j.legs[0];
				const now = editOf(lead);
				// The origin is not always loaded: the first journey of a day starts at
				// the night before it, which the board may not be showing. The bar on
				// the board falls back to the bare mode in exactly the same case, so
				// the placeholder does too.
				const from = eventOf(lead.fromEventId)?.title ?? null;
				const who = peopleLabel(j.legs.flatMap((l) => l.people));
				// Off the board's copy, so the mark comes and goes as the mode and
				// the minutes are typed, in step with the bar behind the dialog.
				const tight = j.legs.some((l) => (drawn.get(l.key) ?? l).tight);
				// A journey planned but not yet saved has no id, so an absent focus
				// must not be allowed to match it.
				const focused = !!focusLegId && j.legs.some((l) => l.id === focusLegId);
				// A group of one cannot be split, and can only be merged when there is
				// another journey starting where it does.
				const siblings = journeys.filter((o) => o.key === j.key).length;
				// One card for everybody on the block says nothing the Participants
				// field above it does not, so it goes unnamed.
				const showWho = journeys.length > 1 || who !== peopleLabel(participants);
				return (
					<div
						key={j.merged ? j.key : lead.key}
						className={`jrow${focused ? ' on' : ''}`}
						role="group"
						aria-label={cj.groupLabel(who)}
					>
						{/* Who is on it names the journey: it is the only thing telling
						    six approaches to the same lunch apart. */}
						{(showWho || tight || j.merged || siblings > 1) && (
							<p className="jwho">
								{showWho && <span>{who}</span>}
								{/* Written out as well as drawn. The triangle's tooltip is a
							    hover, and a phone has none: the card is the one place a
							    tight journey is explained, so it says so in words. */}
								{tight && (
									<span className="jwarn">
										<WarningIcon />
										{copy.viewAs.travelWarning}
									</span>
								)}
								{j.merged && (
									<button
										type="button"
										className="jlink"
										onClick={() => {
											setSplit((s) => toggle(s, j.key, true));
											setJoined((s) => toggle(s, j.key, false));
										}}
									>
										{cj.split}
									</button>
								)}
								{!j.merged && siblings > 1 && (
									<button
										type="button"
										className="jlink"
										onClick={() => {
											setSplit((s) => toggle(s, j.key, false));
											setJoined((s) => toggle(s, j.key, true));
											// Merging is an answer, not just a layout: the card about
											// to stand for the group says what this one said, so every
											// journey under it is set to match. Only what it says,
											// though: see `mergeFrom`.
											const group = legs.filter(
												(l) => originKey(l, eventOf(l.fromEventId)) === j.key
											);
											setEdit(group, mergeFrom(lead, group));
										}}
									>
										{cj.merge}
									</button>
								)}
							</p>
						)}
						<div className="jfields">
							{/* Every field says what it is above it, as every other field
							    in the app does. The name used to be a placeholder alone, and
							    a placeholder is gone the moment anything is typed, which is
							    exactly when the reader is checking which box they are in.
							    The placeholder stays, because it is the name the journey
							    falls back to once this is cleared. */}
							<FieldShell label={cj.name} optional className="jname">
								<input
									className="input"
									placeholder={from ? `${modeLabel(now.mode)} from ${from}` : modeLabel(now.mode)}
									value={now.title}
									onChange={(e) => setEdit(j.legs, { title: e.target.value })}
								/>
							</FieldShell>
							<FieldShell label={copy.schedule.fields.mode} className="jmode">
								<Select
									value={now.mode}
									onChange={(v) => pickMode(j.legs, v)}
									options={modeOptionsFor(lead)}
									ariaLabel={copy.schedule.fields.mode}
								/>
							</FieldShell>
							<FieldShell label={cj.minutes} className="jminsf">
								<input
									className="input jmins"
									type="number"
									min={1}
									data-autofocus={focused ? '' : undefined}
									value={now.mins}
									onChange={(e) => setEdit(j.legs, { mins: e.target.value })}
								/>
							</FieldShell>
						</div>
					</div>
				);
			})}
		</section>
	);

	return { section, save };
}
