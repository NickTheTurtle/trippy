import { useEffect, useMemo, useRef, useState } from 'react';
import { isLocatedType, STAY_CHECK_IN, type EventType } from '@trippy/core/types';
import { guessLeg, minsByMode } from '@trippy/core/travel';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import { useDeleteAction } from '../../components/ui/useDeleteAction';
import Select, { type Option } from '../../components/ui/Select';
import TimeField from '../../components/ui/TimeField';
import { Field, FieldShell, TextArea } from '../../components/ui/Field';
import { copy } from '../../copy';
import PeoplePicker from './PeoplePicker';
import {
	DAY_END,
	MIN_EVENT_MINS,
	MODE_OPTIONS,
	TYPE_OPTIONS,
	dayLabel,
	modeLabel,
	placeLabel,
	placeOptions,
	rangeLabel,
	shiftDay
} from './shared';
import StayDates from './StayDates';
import type { Cell, Crew, EventDraft, EventRow, LegRow, SavedPoi } from './types';

/** What a reader can say about a journey. */
type LegEdit = { title: string; mode: string; mins: string };

const legEdit = (l: LegRow): LegEdit => ({
	title: l.title ?? '',
	mode: l.resolvedMode,
	mins: String(l.resolvedMins)
});

const sameEdit = (a: LegEdit, b: LegEdit) =>
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
const isAutomatic = (l: LegRow, e: LegEdit) => {
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
	MODE_OPTIONS.map((o) => ({ ...o, hint: `${estimateFor(l, o.value)} min` }));

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

/**
 * One event: rename, retype, retime, re-people, relocate, delete, and set the
 * journeys that arrive at it.
 *
 * Changing the type to free time clears the event's location on the server.
 * That is the point of free time rather than a side effect: nobody has promised
 * to be anywhere, so the travel chain breaks on both sides of it and the next
 * journey starts from whatever the person is committed to afterwards.
 *
 * Every field that moves the block reports upward as it is typed, so the board
 * redraws under the dialog rather than after it. `peek` is what makes that
 * worth doing: it leaves the board uncovered and legible behind the panel.
 *
 * A journey has no dialog of its own. It is not a thing anybody creates: the
 * server plans one for every pair of consecutive events a given set of people
 * attends, so it only exists as the approach to the event it arrives at, and
 * that is where it is now edited. There can be several, one per group of people
 * converging on the same block, which is why this is a list and not a field.
 */
export default function EventDialog({
	base,
	event,
	legs,
	focusLegId,
	eventOf,
	peopleLabel,
	memberOptions,
	crews,
	saved,
	cities,
	cityId,
	dock,
	peek,
	onPreview,
	onClose,
	onDone
}: {
	base: string;
	event: EventRow;
	/** The journeys that arrive at this event, replanned as the edit is typed. */
	legs: LegRow[];
	/** The journey the reader pointed at, if they arrived here by clicking one. */
	focusLegId?: string;
	/** Another event on the board, or null when it is not loaded. */
	eventOf: (eventId: string) => EventRow | null;
	peopleLabel: (ids: string[]) => string;
	memberOptions: Option[];
	crews: Crew[];
	saved: SavedPoi[];
	cities: (Cell | null)[];
	cityId: string | null;
	/** Which edge to stand at. */
	dock?: 'left' | 'right';
	/** Whether there is room to leave the board showing rather than covering it. */
	peek?: boolean;
	/** The edit so far, or null once this dialog is gone. */
	onPreview?: (draft: EventDraft | null) => void;
	onClose: () => void;
	onDone: () => void;
}) {
	const [title, setTitle] = useState(event.title);
	const [type, setType] = useState<EventType>(event.type);
	const [start, setStart] = useState(String(event.start_min));
	const [end, setEnd] = useState(String(event.end_min));
	/* A stay's dates, which are what it has instead of a clock. Defaulted for a
	   block that is not a stay yet, so switching type to one has an answer. */
	const [checkIn, setCheckIn] = useState(event.day);
	const [checkOut, setCheckOut] = useState(event.end_day ?? shiftDay(event.day, 1));
	const [people, setPeople] = useState<string[]>([...event.people]);
	const [notes, setNotes] = useState(event.notes ?? '');
	const [mode, setMode] = useState(event.travel_mode ?? '');
	const [poi, setPoi] = useState(event.poi_id ?? '');

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

	const editOf = (l: LegRow) => edits[l.key] ?? legEdit(l);
	const setEdit = (group: LegRow[], patch: Partial<LegEdit>) =>
		setEdits((m) => {
			const next = { ...m };
			for (const l of group) next[l.key] = { ...(m[l.key] ?? legEdit(l)), ...patch };
			return next;
		});

	const toggle = (set: Set<string>, key: string, on: boolean) => {
		const next = new Set(set);
		if (on) next.add(key);
		else next.delete(key);
		return next;
	};

	/* Changing the mode re-answers the question the number is an answer to. A
	   walk and a taxi over the same ground are not the same twelve minutes, and
	   leaving the old number there would state a duration nobody believes. */
	const pickMode = (group: LegRow[], mode: string) =>
		setEdit(group, { mode, mins: String(estimateFor(group[0], mode)) });

	const startMin = Number(start);
	const endMin = Number(end);
	const staying = type === 'stay';

	/**
	 * Moving the start carries the end with it, keeping the length.
	 *
	 * The board asks for two times because that is what an event is, but moving
	 * one is far more often "this happens later" than "this runs longer", and
	 * making the reader fix the end afterwards would put the work back that the
	 * pair was meant to save. Pushed past the end of the board it simply stops
	 * there, which is the same clamp the board draws with.
	 */
	const moveStart = (next: string) => {
		setStart(next);
		setEnd(String(Math.min(DAY_END, Number(next) + (endMin - startMin))));
	};

	/* A typed end can be mid-thought: "9:15" on the way to "19:15" is behind the
	   start for as long as it takes to press the second key. Nothing is refused
	   while the field has focus; the shortest event the server accepts is what
	   it settles on once focus leaves. */
	const fixEnd = () => {
		if (endMin < startMin + MIN_EVENT_MINS) setEnd(String(startMin + MIN_EVENT_MINS));
	};

	/* Held in a ref so a caller passing an inline function does not restart the
	   effect, and so the teardown can fire without the effect depending on it. */
	const preview = useRef(onPreview);
	preview.current = onPreview;

	// Only a located type stands somewhere: free time is deliberately nowhere.
	// A journey's location is the far end of it: where it puts you, and where
	// the rest of the day is then planned from.
	const placeable = isLocatedType(type);
	const placeText = placeLabel(type);

	/* Where the draft stands, which the board, the map and the planner all read
	   as coordinates. An event can hold coordinates without a saved place, so an
	   untouched picker keeps them; choosing "No location" is what clears them. */
	const spot = saved.find((p) => p.id === poi) ?? null;
	const lat = placeable ? (spot ? spot.lat : poi ? null : event.lat) : null;
	const lng = placeable ? (spot ? spot.lng : poi ? null : event.lng) : null;
	useEffect(() => {
		preview.current?.({
			id: event.id,
			day: staying ? checkIn : event.day,
			end_day: staying ? checkOut : null,
			// An empty title is not savable, and a nameless block on the board reads
			// as a bug rather than as an unfinished edit, so the saved name stands
			// until there is a new one.
			title: title.trim() || event.title,
			type,
			start_min: staying ? STAY_CHECK_IN : startMin,
			end_min: staying ? DAY_END : endMin,
			people,
			lat,
			lng
		});
	}, [
		event.id,
		event.day,
		event.title,
		staying,
		checkIn,
		checkOut,
		title,
		type,
		startMin,
		endMin,
		people,
		lat,
		lng
	]);
	// Separate from the effect above, and mount-scoped: the board must drop the
	// preview when the dialog goes, whether it was saved, cancelled or escaped.
	useEffect(() => () => preview.current?.(null), []);

	const poiOptions = placeOptions(saved, cities, cityId);

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

	/* Sent only when it has actually changed.
	 *
	 * An empty place means "unlink", and it clears the event's coordinates with
	 * it. But an event can hold coordinates without a saved place at all, and
	 * for one of those the picker reads "No location" the moment it opens: a
	 * reader who came here to change the end time and pressed Save would have
	 * wiped the spot the day is planned around, and every journey to it. */
	const placeMoved = poi !== (event.poi_id ?? '');

	const op = (body: Record<string, unknown>) =>
		api(`${base}/events/${event.id}/op`, { method: 'POST', body });

	/* The delete goes straight through `api` rather than a mutation, so a refusal
	   throws and the confirmation shows the server's own message instead of
	   closing over the top of a delete that did not happen. */
	const del = useDeleteAction({
		title: `Delete ${event.title}?`,
		busyLabel: copy.common.deleting,
		onDelete: async () => {
			await op({ op: 'delete' });
			onDone();
		}
	});

	const save = useMutation(
		async () => {
			// Two calls, because the people are their own endpoint: they are what
			// splits and rejoins the group, and the server recomputes the day's
			// travel off them rather than off anything in the edit.
			await op({
				op: 'edit',
				title: title.trim(),
				type,
				notes: notes.trim(),
				startMin: staying ? undefined : startMin,
				endMin: staying ? undefined : endMin,
				// A stay moves and stretches by its dates instead of by its clock.
				day: staying ? checkIn : undefined,
				endDay: staying ? checkOut : undefined,
				// Absent leaves it alone; empty hands the journey back to the router.
				travelMode: type === 'travel' ? mode : undefined,
				// Absent leaves the place alone; empty unlinks it.
				poiId: placeable && placeMoved ? poi : undefined
			});
			await api(`${base}/events/${event.id}/people`, { method: 'PUT', body: { people } });

			/* The journeys last, and matched by key rather than by id.
			 *
			 * A journey the reader set up may not have had a row when they set it
			 * up: changing who is going is what makes journeys exist, and the row
			 * only arrives when the server replans off the people just saved. The
			 * key is the same on both sides, so reading the day back is what turns
			 * what they said into the rows to write.
			 *
			 * Only touched journeys are written. A journey is unpinned by default,
			 * so sending every one back would pin a whole day's travel as the price
			 * of renaming one event. */
			const touched = legs.filter((l) => edits[l.key] && !sameEdit(edits[l.key], legEdit(l)));
			if (touched.length) {
				const fresh = await api<{ board: { legs: LegRow[] }[] }>(`${base}?day=${event.day}`);
				const rows = new Map(fresh.board.flatMap((b) => b.legs).map((l) => [l.key, l]));
				for (const l of touched) {
					const row = rows.get(l.key);
					// A journey the save has planned away is not one to write to.
					if (!row) continue;
					const now = edits[l.key];
					const legTitle = now.title.trim();
					await api(`${base}/legs/${row.id}`, {
						method: 'PATCH',
						// Empty mode and minutes is the reset, and the name is not part of it.
						body: isAutomatic(row, now)
							? { mode: '', mins: '', title: legTitle }
							: { mode: now.mode, mins: now.mins, title: legTitle }
					});
				}
			}
			onDone();
		},
		{ fallback: 'Could not save that event.' }
	);

	return (
		<>
			<Modal
				open={!del.asking}
				size="lg"
				dock={dock}
				peek={peek}
				title="Edit event"
				subtitle={staying ? rangeLabel(checkIn, checkOut) : dayLabel(event.day)}
				onClose={onClose}
			>
				<ModalForm className="schedule" onSubmit={save.submit}>
					<div className="mbody flex flex-col gap-4">
						{/* The same 12-column grid the rest of the app's dialogs use, so a
						    field keeps its width whether or not the row beside it is
						    showing: the mode field comes and goes with the type, and the
						    old flexbox row re-flowed everything each time it did. */}
						<div className="grid grid-cols-12 gap-x-2.5 gap-y-3.5">
							<Field
								label="Name"
								className="col-span-8"
								autoFocus
								required
								value={title}
								onChange={(e) => setTitle(e.target.value)}
							/>
							<FieldShell label="Type" className="col-span-4">
								<Select
									value={type}
									onChange={(v) => setType(v as EventType)}
									options={TYPE_OPTIONS}
									ariaLabel="Type"
								/>
							</FieldShell>

							{/* One field, because a start without an end is not an answer:
							    an event is a span, and the pair reads as one on a line. A
							    stay's span is in nights, so it asks for dates instead. */}
							{staying ? (
								<StayDates
									checkIn={checkIn}
									checkOut={checkOut}
									onCheckIn={setCheckIn}
									onCheckOut={setCheckOut}
								/>
							) : (
								<FieldShell label="When" className="col-span-6">
									<div className="tfpair">
										<TimeField
											value={startMin}
											onChange={(v) => moveStart(String(v))}
											ariaLabel="Start"
										/>
										<span className="tfto">to</span>
										<TimeField
											value={endMin}
											onChange={(v) => setEnd(String(v))}
											onCommit={fixEnd}
											ariaLabel="End"
										/>
									</div>
								</FieldShell>
							)}
							<PeoplePicker
								people={people}
								onChange={setPeople}
								memberOptions={memberOptions}
								crews={crews}
								className={staying ? 'col-span-4' : 'col-span-6'}
							/>

							{type === 'travel' && (
								<FieldShell label="Mode" optional className="col-span-4">
									<Select value={mode} onChange={setMode} options={MODE_OPTIONS} ariaLabel="Mode" />
								</FieldShell>
							)}
							{placeable && (
								<FieldShell
									label={placeText}
									optional
									className={type === 'travel' ? 'col-span-8' : 'col-span-12'}
								>
									<Select
										value={poi}
										onChange={setPoi}
										options={poiOptions}
										ariaLabel={placeText}
									/>
								</FieldShell>
							)}
							<TextArea
								label="Notes"
								optional
								className="col-span-12"
								value={notes}
								onChange={(e) => setNotes(e.target.value)}
							/>
						</div>

						{journeys.length > 0 && (
							<section className="jsec">
								<h3 className="jhead">Getting here</h3>
								{journeys.map((j) => {
									const lead = j.legs[0];
									const now = editOf(lead);
									// The origin is not always loaded: the first journey of a day
									// starts at the night before it, which the board may not be
									// showing. The bar on the board falls back to the bare mode in
									// exactly the same case, so the placeholder does too.
									const from = eventOf(lead.fromEventId)?.title ?? null;
									const who = peopleLabel(j.legs.flatMap((l) => l.people));
									const tight = j.legs.some((l) => l.tight);
									// A journey planned but not yet saved has no id, so an absent
									// focus must not be allowed to match it.
									const focused = !!focusLegId && j.legs.some((l) => l.id === focusLegId);
									// A group of one cannot be split, and can only be merged when
									// there is another journey starting where it does.
									const siblings = journeys.filter((o) => o.key === j.key).length;
									return (
										<div
											key={j.merged ? j.key : lead.key}
											className={`jrow${focused ? ' on' : ''}`}
											aria-label={`Journey, ${who}`}
										>
											{/* Who is on it names the journey: it is the only thing
											    telling six approaches to the same lunch apart. */}
											<p className="jwho">
												<span>{who}</span>
												{tight && <span className="tag warn">does not fit the gap</span>}
												{j.merged && (
													<button
														type="button"
														className="jlink"
														onClick={() => {
															setSplit((s) => toggle(s, j.key, true));
															setJoined((s) => toggle(s, j.key, false));
														}}
													>
														Split
													</button>
												)}
												{!j.merged && siblings > 1 && (
													<button
														type="button"
														className="jlink"
														onClick={() => {
															setSplit((s) => toggle(s, j.key, false));
															setJoined((s) => toggle(s, j.key, true));
															// Merging is an answer, not just a layout: the card
															// about to stand for the group says what this one
															// said, so every journey under it is set to match.
															setEdit(
																legs.filter((l) => originKey(l, eventOf(l.fromEventId)) === j.key),
																now
															);
														}}
													>
														Merge
													</button>
												)}
											</p>
											<div className="jfields">
												<input
													className="input jname"
													aria-label={`Journey name, ${who}`}
													placeholder={
														from ? `${modeLabel(now.mode)} from ${from}` : modeLabel(now.mode)
													}
													value={now.title}
													onChange={(e) => setEdit(j.legs, { title: e.target.value })}
												/>
												<div className="jmode">
													<Select
														value={now.mode}
														onChange={(v) => pickMode(j.legs, v)}
														options={modeOptionsFor(lead)}
														ariaLabel={`Mode, ${who}`}
													/>
												</div>
												<div className="input jmins">
													<input
														type="number"
														min={1}
														data-autofocus={focused ? '' : undefined}
														aria-label={`Minutes, ${who}`}
														value={now.mins}
														onChange={(e) => setEdit(j.legs, { mins: e.target.value })}
													/>
													<span>min</span>
												</div>
											</div>
										</div>
									);
								})}
							</section>
						)}
					</div>

					<ModalFooter
						error={save.error}
						onClose={onClose}
						busy={save.busy}
						busyLabel={copy.common.saving}
						submitLabel={copy.common.save}
						start={del.button}
					/>
				</ModalForm>
			</Modal>

			{del.confirm}
		</>
	);
}
