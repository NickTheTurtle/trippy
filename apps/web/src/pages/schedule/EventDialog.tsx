import { useEffect, useRef, useState } from 'react';
import { isLocatedType, STAY_CHECK_IN, type EventType } from '@trippy/core/types';
import { MAX_NAME_LENGTH, MAX_NOTES_LENGTH } from '@trippy/core/validate';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import { useDeleteAction } from '../../components/ui/useDeleteAction';
import Select, { type Option } from '../../components/ui/Select';
import TimeField from '../../components/ui/TimeField';
import { FieldShell, Field, TextArea } from '../../components/ui/Field';
import { LockIcon } from '../../components/ui/icons';
import { copy } from '../../copy';
import PeoplePicker from './PeoplePicker';
import { usePlaceField } from './usePlaceField';
import { useJourneys } from './Journeys';
import {
	DAY_END,
	DRAFT_ID,
	MIN_EVENT_MINS,
	MODE_OPTIONS,
	TYPE_OPTIONS,
	dayLabel,
	deriveTitle,
	NO_PEOPLE,
	rangeLabel,
	shiftDay
} from './shared';
import StayDates from './StayDates';
import type { Cell, Crew, EventDraft, EventRow, LegRow, SavedPoi } from './types';

const cf = copy.schedule.fields;
const cs = copy.schedule;

/**
 * One event: describe it, retype it, retime it, re-people it, relocate it, set
 * the journeys that arrive at it, and delete it.
 *
 * Adding and editing are the same dialog rather than two that drifted. They ask
 * the same question about the same board, and while they were two components
 * the answer differed: adding could not say which day the block was for, its
 * type field measured differently, and every fix had to be made twice. `event`
 * is the whole difference. Null means the block does not exist yet, so the
 * dialog previews it under an id no event has and posts it; otherwise it edits
 * the row it was given.
 *
 * A block is named from what it is, which is the place it is at, the first line
 * of its notes, or its own type. The label field overrides that and is blank
 * when the name is simply what would be derived anyway, so a block named
 * deliberately keeps the name it was given and one that was not does not look
 * like it was.
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
 * `locked` is the frozen board's copy of it. A lock takes away the writing, not
 * the reading: the block is still the thing the reader wants to look at, so it
 * still opens, with the fields inert and nothing to press but Close.
 */
export default function EventDialog({
	base,
	event,
	day,
	startMin,
	suggestedStart,
	initialType,
	initialPoi,
	legs,
	focusLegId,
	eventOf,
	peopleLabel,
	memberOptions,
	crews,
	saved,
	stays,
	cities,
	cityId,
	firstDay,
	lastDay,
	provider,
	locked = false,
	dock,
	peek,
	onPreview,
	onClose,
	onDone
}: {
	base: string;
	/** The block being edited, or null to add one. */
	event: EventRow | null;
	/** Which day an added block starts out on. */
	day: string;
	/** Where on the clock the dialog was opened, when it was opened by pointing at a time. */
	startMin?: number | null;
	/**
	 * Where a block goes when nobody pointed at a time: the end of the day so
	 * far. Left untouched it is sent as a suggestion, so the block keeps
	 * following whatever ends up in front of it.
	 */
	suggestedStart?: number;
	/** What the dialog opens as, when it was opened from something type-specific. */
	initialType?: EventType;
	/** A saved place the dialog opens with already picked, as the map's "+ Add" does. */
	initialPoi?: { id: string; name: string };
	/** The journeys that arrive at this block, replanned as the dialog is typed. */
	legs: LegRow[];
	/** The journey the reader pointed at, if they arrived here by clicking one. */
	focusLegId?: string;
	/** Another event on the board, or null when it is not loaded. */
	eventOf: (eventId: string) => EventRow | null;
	peopleLabel: (ids: string[]) => string;
	memberOptions: Option[];
	crews: Crew[];
	saved: SavedPoi[];
	/** The proposed stays a stay block can be booked into. */
	stays: SavedPoi[];
	cities: (Cell | null)[];
	cityId: string | null;
	/** The first and last day the trip reaches, which bound the date field. */
	firstDay: string;
	lastDay: string;
	/** Who answers the place search, for the attribution under its results. */
	provider?: 'google' | 'osm';
	/** Whether the board is frozen, which makes this a read-only view of it. */
	locked?: boolean;
	/** Which edge to stand at. */
	dock?: 'left' | 'right';
	/** Whether there is room to leave the board showing rather than covering it. */
	peek?: boolean;
	/** The block so far, or null once this dialog is gone. */
	onPreview?: (draft: EventDraft | null) => void;
	onClose: () => void;
	onDone: () => void;
}) {
	const opensAt = startMin ?? suggestedStart ?? STAY_CHECK_IN;
	const [type, setType] = useState<EventType>(event?.type ?? initialType ?? 'activity');
	const [start, setStart] = useState(String(event ? event.start_min : opensAt));
	const [end, setEnd] = useState(String(event ? event.end_min : opensAt + 60));
	/* Whether the start is still the one the board proposed. Pointing at a time
	   to open the dialog is already a choice, so only an add that opened without
	   one can stay a suggestion, and typing into the field ends it. The server
	   then keeps a suggested block behind whatever ends up in front of it. */
	const [timeChosen, setTimeChosen] = useState(!!event || startMin != null);
	/* A stay's dates, which are what it has instead of a clock. Kept beside the
	   times rather than instead of them, so switching type back and forth does
	   not lose what was already typed. */
	const [checkIn, setCheckIn] = useState(event?.day ?? day);
	const [checkOut, setCheckOut] = useState(event?.end_day ?? shiftDay(event?.day ?? day, 1));
	/* The day everything else sits on. Its own state because the date is a field
	   rather than a fact about where the dialog was opened from: a block can be
	   sent to another day without being dragged there, and one being added can
	   be put on a day other than the one on screen. */
	const [date, setDate] = useState(event?.day ?? day);
	/* `null` once the organiser has emptied the field. Distinct from `[]`, which
	   is how everyone is stored, and refused at the save rather than at the tick. */
	const [people, setPeople] = useState<string[] | null>(event ? [...event.people] : []);
	const [notes, setNotes] = useState(event?.notes ?? '');
	/* Blank means "let the router decide", which is what the API does with an
	   absent mode, so an untouched field and no field at all are the same
	   request. Kept across a change of type, like the times and the dates, so
	   flipping to Activity and back does not lose the ferry that was picked. */
	const [mode, setMode] = useState(event?.travel_mode ?? '');

	/* Which link the block already has depends on what it is: a stay is booked
	   into a proposed stay, everything else is scheduled at a saved place. */
	const savedPick =
		(event ? (event.type === 'stay' ? event.lodging_id : event.poi_id) : null) ?? '';
	/* The name the box opens on: the linked place's, or the one typed by hand
	   when there is no link. Both are the same field to the reader, so both have
	   to come back when the dialog is reopened. */
	const openedOn = event
		? ((event.type === 'stay' ? stays : saved).find((p) => p.id === savedPick)?.name ??
				(savedPick ? '' : event.place_text)) ||
			''
		: (initialPoi?.name ?? '');

	const {
		poi,
		place,
		spot,
		placeable,
		field: placeField,
		retype
	} = usePlaceField({
		base,
		type,
		cities,
		cityId,
		saved,
		stays,
		provider,
		initialPoi: event ? savedPick : (initialPoi?.id ?? ''),
		initialPlace: openedOn
	});

	const journeys = useJourneys({ legs, eventOf, peopleLabel, focusLegId });

	const startMinNow = Number(start);
	const endMinNow = Number(end);
	const staying = type === 'stay';
	/** The day the block lands on, which is its check-in once it is a stay. */
	const onDay = staying ? checkIn : date;
	const startAt = staying ? STAY_CHECK_IN : startMinNow;
	const endAt = staying ? DAY_END : endMinNow;

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
		setTimeChosen(true);
		setStart(next);
		setEnd(String(Math.min(DAY_END, Number(next) + (endMinNow - startMinNow))));
	};

	/* A typed end can be mid-thought: "9:15" on the way to "19:15" is behind the
	   start for as long as it takes to press the second key. Nothing is refused
	   while the field has focus; the shortest event the server accepts is what
	   it settles on once focus leaves. */
	const fixEnd = () => {
		if (endMinNow < startMinNow + MIN_EVENT_MINS) setEnd(String(startMinNow + MIN_EVENT_MINS));
	};

	/* Held in a ref so a caller passing an inline function does not restart the
	   effect, and so the teardown can fire without the effect depending on it. */
	const preview = useRef(onPreview);
	preview.current = onPreview;

	/* Where the draft stands, which the board, the map and the planner all read
	   as coordinates. An event can hold coordinates without a saved place, so an
	   untouched picker keeps them; choosing "No location" is what clears them. */
	const lat = placeable ? (spot ? spot.lat : poi ? null : (event?.lat ?? null)) : null;
	const lng = placeable ? (spot ? spot.lng : poi ? null : (event?.lng ?? null)) : null;

	/** The name this block would be given if nobody had labelled it. */
	const derived = deriveTitle(
		placeable ? (spot?.name ?? (poi ? null : place.trim() || null)) : null,
		notes,
		type
	);

	/* What to call the block, blank when its name is simply the one it would be
	   derived anyway. Showing a derived name as typed text would make every block
	   look deliberately named, and a reader clearing what they found there would
	   be undoing something they never wrote. Blank with the derived name as the
	   placeholder says the same thing and is true. */
	const [label, setLabel] = useState(() => {
		if (!event) return '';
		const was = deriveTitle(
			isLocatedType(event.type) ? openedOn || null : null,
			event.notes ?? '',
			event.type
		);
		return event.title === was ? '' : event.title;
	});

	/* The block as it currently reads, drawn on the board under the dialog. An
	   edit previews over the block it belongs to; an add is inserted into the day
	   under an id no event has, so the reader watches the thing they are
	   describing take its place. */
	const previewId = event?.id ?? DRAFT_ID;
	useEffect(() => {
		preview.current?.({
			id: previewId,
			day: onDay,
			end_day: staying ? checkOut : null,
			/* A typed label is the name; without one the block is named the way it
			   would be named on a fresh save, so the preview shows the rename the
			   save is actually going to make rather than the name on record. */
			title: label.trim() || derived,
			type,
			start_min: startAt,
			end_min: endAt,
			// An emptied field has nobody to draw, and the board reads no names as
			// the whole group, which is what the event still is until this saves.
			people: people ?? [],
			lat,
			lng
		});
	}, [
		previewId,
		onDay,
		staying,
		checkOut,
		notes,
		label,
		derived,
		type,
		startAt,
		endAt,
		people,
		lat,
		lng
	]);
	// Separate from the effect above, and mount-scoped: the board must drop the
	// preview when the dialog goes, whether it was saved, cancelled or escaped.
	useEffect(() => () => preview.current?.(null), []);

	/* Sent only when it has actually changed.
	 *
	 * An empty place means "unlink", and it clears the event's coordinates with
	 * it. But an event can hold coordinates without a saved place at all, and
	 * for one of those the picker reads "No location" the moment it opens: a
	 * reader who came here to change the end time and pressed Save would have
	 * wiped the spot the day is planned around, and every journey to it. */
	const placeMoved = poi !== savedPick || place.trim() !== openedOn.trim();

	const op = (body: Record<string, unknown>) =>
		api<{ ok?: boolean; version?: number }>(`${base}/events/${event!.id}/op`, {
			method: 'POST',
			body
		});

	/* The version this form is writing against.
	 *
	 * Taken from the row the dialog was opened on and never from a later load:
	 * the page used to hand this dialog a row it re-read on every live reload,
	 * so the version was always the newest one and a stale form overwrote
	 * whoever had saved in the meantime without a word. The page now holds the
	 * opened row still (see `opened` in `Schedule.tsx`), and this is the one
	 * place the number moves: each of this dialog's own writes answers with the
	 * version it left behind, so a save that is refused halfway, after the edit
	 * landed and before the people did, can be pressed again without being
	 * refused by its own first half. */
	const version = useRef(event?.version);
	const took = (res: { version?: number } | null | undefined) => {
		if (typeof res?.version === 'number') version.current = res.version;
	};

	/* The delete goes straight through `api` rather than a mutation, so a refusal
	   throws and the confirmation shows the server's own message instead of
	   closing over the top of a delete that did not happen. */
	const del = useDeleteAction({
		title: `Delete ${event?.title ?? ''}?`,
		name: event?.title ?? '',
		busyLabel: copy.common.deleting,
		onDelete: async () => {
			await op({ op: 'delete' });
			onDone();
		}
	});

	/** The block once it exists, so a retry after a failed add does not add it twice. */
	const created = useRef<string | null>(null);

	const save = useMutation(
		async () => {
			if (!event) {
				/* The event first, then the journeys, and the id is kept: if a journey
				   write fails the block has already been added, and a second press of
				   Add must finish what it started rather than add it twice. */
				created.current ??= (
					await api<{ id: string }>(`${base}/events`, {
						method: 'POST',
						body: {
							day: onDay,
							endDay: staying ? checkOut : undefined,
							// Absent unless the organiser typed one, which is how most
							// blocks are added: the server then names it from the place,
							// the first line of the notes or the type's own noun, which
							// is the order the placeholder above mirrors.
							title: label.trim() || undefined,
							type,
							start: startAt,
							duration: endAt - startAt,
							poiId: placeable && poi ? poi : undefined,
							// Only when nothing was picked, which is what makes it a typed
							// location rather than a second name for a saved one.
							placeName: placeable && !poi ? place.trim() || undefined : undefined,
							notes: notes.trim() || undefined,
							// Absent hands the journey to the router, which is the right
							// default and the only thing this form could send before.
							travelMode: type === 'travel' && mode ? mode : undefined,
							// Never null here: `submit` refuses an emptied field before it
							// gets this far.
							people: people ?? [],
							// A start nobody chose is sent as one, so the board can keep
							// the block behind whatever ends up in front of it.
							timeAuto: !timeChosen && !staying
						}
					})
				).id;
				// The journeys were planned against the draft id, so they are written
				// back against the id the block ended up with.
				await journeys.save(base, onDay, created.current);
				return onDone();
			}

			// Two calls, because the people are their own endpoint: they are what
			// splits and rejoins the group, and the server recomputes the day's
			// travel off them rather than off anything in the edit.
			took(
				await op({
					op: 'edit',
					/* Sent on every save, because the field is on screen on every save.
				   Blank is not silence: it is the organiser clearing the label, and
				   the server reads it as a request to derive the name again from the
				   place and the notes this body is writing. */
					title: label.trim(),
					type,
					notes: notes.trim(),
					startMin: staying ? undefined : startAt,
					endMin: staying ? undefined : endAt,
					// A stay moves and stretches by its dates; everything else moves by
					// the one date it has. Both arrive as `day`, and the server ignores
					// one that names the day the block is already on.
					day: onDay,
					endDay: staying ? checkOut : undefined,
					// Absent leaves it alone; empty hands the journey back to the router.
					travelMode: type === 'travel' ? mode : undefined,
					// Absent leaves the place alone; empty unlinks it.
					poiId: placeable && placeMoved ? poi : undefined,
					// Only carries a name when nothing is picked: a link names itself.
					placeName: placeable && placeMoved && !poi ? place.trim() : undefined,
					// What this form was opened on. The server refuses the write if the
					// event has moved on since, rather than letting this copy of every
					// untouched field overwrite whoever saved first.
					version: version.current
				})
			);
			// Never null here: `submit` refuses an emptied field before it gets
			// this far. The people write bumps the version too (re-peopling
			// replans the day), and answers with the one it left, which is what
			// the next press of Save has to send. Read defensively all the same:
			// a missing number leaves the last one standing rather than clearing it.
			took(
				await api<{ version?: number }>(`${base}/events/${event.id}/people`, {
					method: 'PUT',
					body: { people: people ?? [] }
				})
			);

			// The journeys last: they are planned off the people just saved, and
			// read back from the day the block has moved to rather than left.
			await journeys.save(base, onDay, event.id);

			onDone();
		},
		{ fallback: event ? 'Could not save that event.' : 'Could not add that event.' }
	);

	/* The Participants field can be emptied but not saved empty, so the refusal
	   is raised here, in the same footer slot and the same corner toast a server
	   refusal would use. */
	function submit(e: React.FormEvent) {
		e.preventDefault();
		if (locked) return;
		if (!people) return save.setError(NO_PEOPLE);
		void save.run();
	}

	return (
		<>
			<Modal
				open={!del.asking}
				size="lg"
				dock={dock}
				peek={peek}
				title={locked ? cs.dialog.view : event ? cs.dialog.edit : cs.dialog.add}
				subtitle={staying ? rangeLabel(checkIn, checkOut) : dayLabel(onDay)}
				onClose={onClose}
			>
				<ModalForm className="schedule" onSubmit={submit}>
					{/* Inert rather than disabled field by field: the clock and the
					    pickers are spans and buttons of the app's own, so there is no
					    one attribute they all honour, and a reader tabbing through a
					    frozen board should not land inside it either.

					    On what the body holds, not on the body. `.mbody` is the
					    dialog's only scroll box, and an inert box takes no wheel and
					    no touch: a long read-only event on a phone showed its first
					    screen and could not be scrolled to its notes or its journeys,
					    which is most of what a locked board is opened to read. */}
					<div className={`mbody flex flex-col gap-4${locked ? ' readonly' : ''}`}>
						{/* The same 12-column grid the rest of the app's dialogs use, so a
						    field keeps its width whether or not the row beside it is
						    showing: the mode field comes and goes with the type, and the
						    old flexbox row re-flowed everything each time it did.

						    The place leads, because picking one is how a block is usually
						    added and the name usually follows from it. Free time has no
						    place at all, so its type takes the full row rather than
						    leaving a hole. A label is the override for when the derived
						    name reads badly, so it sits at the bottom with the notes
						    rather than at the top where it would look required.

						    The clock takes seven of the twelve columns rather than six,
						    which is what the pair actually measures: two fixed-width
						    clocks, a gap either side of "to", and 242px in all. Six
						    columns is 232px, and the difference used to come out of the
						    meridiem. The date takes the other five.

						    The clock and whatever shares its row take the whole width
						    below `sm`: two clocks of three segments each do not fit in
						    half of a 390px dialog. The place and its type share a row only
						    from `sm` for the same reason: a third of a phone's dialog is
						    too narrow for "Activity" and its chevron. */}
						<div className="grid grid-cols-12 gap-x-2.5 gap-y-3.5" inert={locked || undefined}>
							{placeField}
							<FieldShell
								label={cf.type}
								className={placeable ? 'col-span-12 sm:col-span-4' : 'col-span-12'}
							>
								<Select
									value={type}
									onChange={(v) => {
										const next = v as EventType;
										retype(next);
										setType(next);
									}}
									options={TYPE_OPTIONS}
									ariaLabel={cf.type}
								/>
							</FieldShell>

							{/* One field, because a start without an end is not an answer:
							    an event is a span, and the pair reads as one on a line. A
							    stay's span is in nights, so it asks for dates instead. */}
							{staying ? (
								<StayDates
									checkIn={checkIn}
									checkOut={checkOut}
									firstDay={firstDay}
									lastDay={lastDay}
									onCheckIn={setCheckIn}
									onCheckOut={setCheckOut}
								/>
							) : (
								<>
									{/* The date sits beside the clock rather than inside it: a
									    block that is on the wrong day is moved by saying so,
									    which is the one move a drag down a single day's column
									    cannot make. Bounded by the trip, because the board
									    only draws days the trip has.

									    Clamped, not merely bounded. `min` and `max` colour a
									    date input's own picker but do not stop a date being
									    typed into it, and a typed 2027-05-16 on a trip that
									    ends on the 15th left the field reading one day while
									    the board read another, with nothing to say which the
									    save would use. */}
									<Field
										label={cf.date}
										className="col-span-12 sm:col-span-5"
										type="date"
										min={firstDay}
										max={lastDay}
										value={date}
										onChange={(e) => {
											const typed = e.target.value;
											if (!typed) return;
											setDate(typed < firstDay ? firstDay : typed > lastDay ? lastDay : typed);
										}}
									/>
									<FieldShell label={cf.when} className="col-span-12 sm:col-span-7">
										<div className="tfpair">
											<TimeField
												value={startAt}
												onChange={(v) => moveStart(String(v))}
												ariaLabel={cf.start}
											/>
											<span className="tfto">to</span>
											<TimeField
												value={endAt}
												onChange={(v) => {
													setTimeChosen(true);
													setEnd(String(v));
												}}
												onCommit={fixEnd}
												ariaLabel={cf.end}
											/>
										</div>
									</FieldShell>
								</>
							)}
							{type === 'travel' && (
								<FieldShell label={cf.mode} optional className="col-span-12 sm:col-span-5">
									<Select
										value={mode}
										onChange={setMode}
										options={MODE_OPTIONS}
										ariaLabel={cf.mode}
									/>
								</FieldShell>
							)}
							<PeoplePicker
								people={people}
								onChange={setPeople}
								memberOptions={memberOptions}
								crews={crews}
								className={
									staying
										? 'col-span-12 sm:col-span-4'
										: type === 'travel'
											? 'col-span-12 sm:col-span-7'
											: 'col-span-12'
								}
							/>

							{/* The placeholder is the name the block falls back to once
							    this is cleared, so the field says what it overrides
							    without a hint line repeating it. */}
							<Field
								label={cf.label}
								optional
								className="col-span-12"
								value={label}
								maxLength={MAX_NAME_LENGTH}
								placeholder={derived}
								onChange={(e) => setLabel(e.target.value)}
							/>

							<TextArea
								label={cf.notes}
								optional
								maxLength={MAX_NOTES_LENGTH}
								className="col-span-12"
								value={notes}
								onChange={(e) => setNotes(e.target.value)}
							/>
						</div>

						{journeys.section && <div inert={locked || undefined}>{journeys.section}</div>}
					</div>

					{/* A frozen board has nothing to save and nothing to delete, so the
					    footer is the lock itself and a way out. */}
					<ModalFooter
						error={save.error}
						onClose={onClose}
						busy={save.busy}
						busyLabel={event ? copy.common.saving : copy.common.adding}
						submitLabel={locked ? undefined : event ? copy.common.save : copy.common.add}
						start={
							locked ? (
								<span className="lockmark" title={cs.lock.hint}>
									<LockIcon />
									{cs.lock.tag}
								</span>
							) : event ? (
								del.button
							) : undefined
						}
					/>
				</ModalForm>
			</Modal>

			{del.confirm}
		</>
	);
}
