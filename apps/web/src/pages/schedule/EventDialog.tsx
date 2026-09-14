import { useEffect, useRef, useState } from 'react';
import { isLocatedType, type EventType } from '@trippy/core/types';
import { guessLeg, minsByMode } from '@trippy/core/travel';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Select, { type Option } from '../../components/ui/Select';
import TimeField from '../../components/ui/TimeField';
import { Field, FieldShell } from '../../components/ui/Field';
import { copy } from '../../copy';
import PeoplePicker from './PeoplePicker';
import {
	DAY_END,
	MIN_EVENT_MINS,
	MODE_OPTIONS,
	TYPE_OPTIONS,
	dayLabel,
	modeLabel,
	placeOptions
} from './shared';
import type { Cell, Crew, EventDraft, EventRow, LegRow, SavedPoi } from './types';

/** What a reader can say about a journey, and the automatic estimate it began at. */
type LegEdit = { title: string; mode: string; mins: string; auto: boolean };

const legEdit = (l: LegRow): LegEdit => ({
	title: l.title ?? '',
	mode: l.resolvedMode,
	mins: String(l.resolvedMins),
	auto: !l.manual
});

const sameEdit = (a: LegEdit, b: LegEdit) =>
	a.auto === b.auto && a.mode === b.mode && a.mins === b.mins && a.title.trim() === b.title.trim();

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

/** What the journey resolves to with nothing pinned: the provider, or the guess. */
const automatic = (l: LegRow) => {
	const mode = l.autoMode ?? guessLeg(l.km).mode;
	return { mode, mins: estimateFor(l, mode) };
};

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
	titleOf,
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
	/** The journeys that arrive at this event, in the order the board drew them. */
	legs: LegRow[];
	/** The journey the reader pointed at, if they arrived here by clicking one. */
	focusLegId?: string;
	/** The name of another event on the board, or null when it is not loaded. */
	titleOf: (eventId: string) => string | null;
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
	const [people, setPeople] = useState<string[]>([...event.people]);
	const [notes, setNotes] = useState(event.notes ?? '');
	const [mode, setMode] = useState(event.travel_mode ?? '');
	const [poi, setPoi] = useState(event.poi_id ?? '');
	const [killing, setKilling] = useState(false);
	/* Keyed by leg id and seeded once: the dialog is mounted per event, and the
	   list it was opened with is the list it saves. */
	const [journeys, setJourneys] = useState<Record<string, LegEdit>>(() =>
		Object.fromEntries(legs.map((l) => [l.id, legEdit(l)]))
	);
	const setJourney = (id: string, patch: Partial<LegEdit>) =>
		setJourneys((m) => ({ ...m, [id]: { ...m[id], ...patch } }));

	/* Changing the mode re-answers the question the number is an answer to. A
	   walk and a taxi over the same ground are not the same twelve minutes, and
	   leaving the old number there would state a duration nobody believes. */
	const pickMode = (l: LegRow, mode: string) => {
		const mins = estimateFor(l, mode);
		setJourney(l.id, {
			mode,
			mins: String(mins),
			// Picking the planned mode back, at its own estimate, is the automatic
			// answer again rather than a pin that happens to agree with it.
			auto: mode === l.autoMode && mins === l.autoMins
		});
	};
	const resetJourney = (l: LegRow) => {
		const a = automatic(l);
		setJourney(l.id, { mode: a.mode, mins: String(a.mins), auto: true });
	};

	const startMin = Number(start);
	const endMin = Number(end);

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
	useEffect(() => {
		preview.current?.({
			id: event.id,
			// An empty title is not savable, and a nameless block on the board reads
			// as a bug rather than as an unfinished edit, so the saved name stands
			// until there is a new one.
			title: title.trim() || event.title,
			type,
			start_min: startMin,
			end_min: endMin,
			people
		});
	}, [event.id, event.title, title, type, startMin, endMin, people]);
	// Separate from the effect above, and mount-scoped: the board must drop the
	// preview when the dialog goes, whether it was saved, cancelled or escaped.
	useEffect(() => () => preview.current?.(null), []);

	// Only a located type stands somewhere: free time is deliberately nowhere.
	// A journey's location is the far end of it: where it puts you, and where
	// the rest of the day is then planned from.
	const placeable = isLocatedType(type);
	const placeLabel = type === 'travel' ? 'Ends at' : 'Location';

	const poiOptions = placeOptions(saved, cities, cityId);

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

	const save = useMutation(
		async () => {
			/* Journeys first, while the ids still mean what the reader saw. Only the
			   ones actually touched: a leg is unpinned by default, and writing every
			   row back would pin the whole day just for opening this dialog. */
			for (const l of legs) {
				const now = journeys[l.id];
				if (!now || sameEdit(now, legEdit(l))) continue;
				const title = now.title.trim();
				await api(`${base}/legs/${l.id}`, {
					method: 'PATCH',
					// Empty mode and minutes is the reset, and the name is not part of it.
					body: now.auto ? { mode: '', mins: '', title } : { mode: now.mode, mins: now.mins, title }
				});
			}
			// Two calls, because the people are their own endpoint: they are what
			// splits and rejoins the group, and the server recomputes the day's
			// travel off them rather than off anything in the edit.
			await op({
				op: 'edit',
				title: title.trim(),
				type,
				notes: notes.trim(),
				startMin,
				endMin,
				// Absent leaves it alone; empty hands the journey back to the router.
				travelMode: type === 'travel' ? mode : undefined,
				// Absent leaves the place alone; empty unlinks it.
				poiId: placeable && placeMoved ? poi : undefined
			});
			await api(`${base}/events/${event.id}/people`, { method: 'PUT', body: { people } });
			onDone();
		},
		{ fallback: 'Could not save that event.' }
	);

	return (
		<>
			<Modal
				open={!killing}
				size="lg"
				dock={dock}
				peek={peek}
				title="Edit event"
				subtitle={dayLabel(event.day)}
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
							    an event is a span, and the pair reads as one on a line. */}
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
							<PeoplePicker
								people={people}
								onChange={setPeople}
								memberOptions={memberOptions}
								crews={crews}
								className="col-span-6"
							/>

							{type === 'travel' && (
								<FieldShell label="Mode" optional className="col-span-4">
									<Select value={mode} onChange={setMode} options={MODE_OPTIONS} ariaLabel="Mode" />
								</FieldShell>
							)}
							{placeable && (
								<FieldShell
									label={placeLabel}
									optional
									className={type === 'travel' ? 'col-span-8' : 'col-span-12'}
								>
									<Select
										value={poi}
										onChange={setPoi}
										options={poiOptions}
										ariaLabel={placeLabel}
									/>
								</FieldShell>
							)}
							<Field
								label="Notes"
								optional
								className="col-span-12"
								value={notes}
								onChange={(e) => setNotes(e.target.value)}
							/>
						</div>

						{legs.length > 0 && (
							<section className="jsec">
								<h3 className="jhead">Getting here</h3>
								{legs.map((l) => {
									const j = journeys[l.id];
									if (!j) return null;
									// The origin is not always loaded: the first journey of a day
									// starts at the night before it, which the board may not be
									// showing. The bar on the board falls back to the bare mode in
									// exactly the same case, so the placeholder does too.
									const from = titleOf(l.fromEventId);
									const who = peopleLabel(l.people);
									return (
										<div
											key={l.id}
											className={`jrow${focusLegId === l.id ? ' on' : ''}`}
											aria-label={`Journey, ${who}`}
										>
											<div className="jfields">
												<input
													className="input jname"
													aria-label={`Journey name, ${who}`}
													placeholder={
														from ? `${modeLabel(j.mode)} from ${from}` : modeLabel(j.mode)
													}
													value={j.title}
													onChange={(e) => setJourney(l.id, { title: e.target.value })}
												/>
												<div className="jmode">
													<Select
														value={j.mode}
														onChange={(v) => pickMode(l, v)}
														options={MODE_OPTIONS}
														ariaLabel={`Mode, ${who}`}
													/>
												</div>
												<div className="input jmins">
													<input
														type="number"
														min={1}
														data-autofocus={focusLegId === l.id ? '' : undefined}
														aria-label={`Minutes, ${who}`}
														value={j.mins}
														onChange={(e) =>
															setJourney(l.id, { mins: e.target.value, auto: false })
														}
													/>
													<span>min</span>
												</div>
											</div>
											<p className="jnote m-0 text-meta muted">
												<span>{who}</span>
												{j.auto ? (
													<span>Automatic</span>
												) : (
													<>
														<span>Pinned</span>
														<span>
															<button
																type="button"
																className="link"
																onClick={() => resetJourney(l)}
															>
																Use the estimate
															</button>
														</span>
													</>
												)}
												{l.tight && <span className="tag warn">does not fit the gap</span>}
											</p>
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
						start={
							<button type="button" className="btn danger" onClick={() => setKilling(true)}>
								{copy.common.delete}
							</button>
						}
					/>
				</ModalForm>
			</Modal>

			{/* The delete goes straight through `api` rather than a mutation, so a
			    refusal throws and `ConfirmDialog` shows the server's own message
			    instead of closing over the top of a delete that did not happen. */}
			<ConfirmDialog
				open={killing}
				title={`Delete ${event.title}?`}
				busyLabel={copy.common.deleting}
				onCancel={() => setKilling(false)}
				onConfirm={async () => {
					await op({ op: 'delete' });
					onDone();
				}}
			/>
		</>
	);
}
