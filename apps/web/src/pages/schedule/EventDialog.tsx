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
import { copy } from '../../copy';
import PeoplePicker from './PeoplePicker';
import { usePlaceField } from './usePlaceField';
import { useJourneys } from './Journeys';
import {
	DAY_END,
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

/**
 * One event: retype, retime, re-people, relocate, delete, and set the journeys
 * that arrive at it.
 *
 * Not rename: a block is named from what it is, which is the place it is at,
 * the first line of its notes, or its own type, and the server owns that order.
 * The dialog is silent about the name, so a block named deliberately keeps the
 * name it was given.
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
 * The journeys arriving at it are edited here too, in the section `useJourneys`
 * draws.
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
	stays,
	cities,
	cityId,
	firstDay,
	lastDay,
	provider,
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
	/** The proposed stays a stay block can be booked into. */
	stays: SavedPoi[];
	cities: (Cell | null)[];
	cityId: string | null;
	/** The first and last day the trip reaches, which bound the date field. */
	firstDay: string;
	lastDay: string;
	/** Who answers the place search, for the attribution under its results. */
	provider?: 'google' | 'osm';
	/** Which edge to stand at. */
	dock?: 'left' | 'right';
	/** Whether there is room to leave the board showing rather than covering it. */
	peek?: boolean;
	/** The edit so far, or null once this dialog is gone. */
	onPreview?: (draft: EventDraft | null) => void;
	onClose: () => void;
	onDone: () => void;
}) {
	const [type, setType] = useState<EventType>(event.type);
	const [start, setStart] = useState(String(event.start_min));
	const [end, setEnd] = useState(String(event.end_min));
	/* A stay's dates, which are what it has instead of a clock. Defaulted for a
	   block that is not a stay yet, so switching type to one has an answer. */
	const [checkIn, setCheckIn] = useState(event.day);
	const [checkOut, setCheckOut] = useState(event.end_day ?? shiftDay(event.day, 1));
	/* The day everything else sits on. Its own state because the date is now a
	   field rather than a fact about where the dialog was opened from, and a
	   block can be sent to another day without being dragged there. */
	const [date, setDate] = useState(event.day);
	/* `null` once the organiser has emptied the field. Distinct from `[]`, which
	   is how everyone is stored, and refused at the save rather than at the tick. */
	const [people, setPeople] = useState<string[] | null>([...event.people]);
	const [notes, setNotes] = useState(event.notes ?? '');
	const [mode, setMode] = useState(event.travel_mode ?? '');
	/* Which link the block already has depends on what it is: a stay is booked
	   into a proposed stay, everything else is scheduled at a saved place. */
	const savedPick = (event.type === 'stay' ? event.lodging_id : event.poi_id) ?? '';
	/* The name the box opens on: the linked place's, or the one typed by hand
	   when there is no link. Both are the same field to the reader, so both have
	   to come back when the dialog is reopened. */
	const openedOn =
		((event.type === 'stay' ? stays : saved).find((p) => p.id === savedPick)?.name ??
			(savedPick ? '' : event.place_text)) ||
		'';

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
		initialPoi: savedPick,
		initialPlace: openedOn
	});

	const journeys = useJourneys({ legs, eventOf, peopleLabel, focusLegId });

	const startMin = Number(start);
	const endMin = Number(end);
	const staying = type === 'stay';
	/** The day the block lands on, which is its check-in once it is a stay. */
	const onDay = staying ? checkIn : date;

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

	/* Where the draft stands, which the board, the map and the planner all read
	   as coordinates. An event can hold coordinates without a saved place, so an
	   untouched picker keeps them; choosing "No location" is what clears them. */
	const lat = placeable ? (spot ? spot.lat : poi ? null : event.lat) : null;
	const lng = placeable ? (spot ? spot.lng : poi ? null : event.lng) : null;

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
		const was = deriveTitle(
			isLocatedType(event.type) ? openedOn || null : null,
			event.notes ?? '',
			event.type
		);
		return event.title === was ? '' : event.title;
	});
	useEffect(() => {
		preview.current?.({
			id: event.id,
			day: onDay,
			end_day: staying ? checkOut : null,
			/* A typed label is the name; without one the block is named the way it
			   would be named on a fresh save, so the preview shows the rename the
			   save is actually going to make rather than the name on record. */
			title: label.trim() || derived,
			type,
			start_min: staying ? STAY_CHECK_IN : startMin,
			end_min: staying ? DAY_END : endMin,
			// An emptied field has nobody to draw, and the board reads no names as
			// the whole group, which is what the event still is until this saves.
			people: people ?? [],
			lat,
			lng
		});
	}, [
		event.id,
		event.title,
		onDay,
		staying,
		checkOut,
		notes,
		label,
		derived,
		type,
		placeable,
		spot?.name,
		startMin,
		endMin,
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
				/* Sent on every save, because the field is on screen on every save.
				   Blank is not silence: it is the organiser clearing the label, and
				   the server reads it as a request to derive the name again from the
				   place and the notes this body is writing. */
				title: label.trim(),
				type,
				notes: notes.trim(),
				startMin: staying ? undefined : startMin,
				endMin: staying ? undefined : endMin,
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
				version: event.version
			});
			// Never null here: `submit` refuses an emptied field before it gets
			// this far.
			await api(`${base}/events/${event.id}/people`, {
				method: 'PUT',
				body: { people: people ?? [] }
			});

			// The journeys last: they are planned off the people just saved, and
			// read back from the day the block has moved to rather than left.
			await journeys.save(base, onDay, event.id);

			onDone();
		},
		{ fallback: 'Could not save that event.' }
	);

	/* The Participants field can be emptied but not saved empty, so the refusal
	   is raised here, in the same footer slot and the same corner toast a server
	   refusal would use. */
	function submit(e: React.FormEvent) {
		e.preventDefault();
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
				title="Edit event"
				subtitle={staying ? rangeLabel(checkIn, checkOut) : dayLabel(onDay)}
				onClose={onClose}
			>
				<ModalForm className="schedule" onSubmit={submit}>
					<div className="mbody flex flex-col gap-4">
						{/* The same 12-column grid the rest of the app's dialogs use, so a
						    field keeps its width whether or not the row beside it is
						    showing: the mode field comes and goes with the type, and the
						    old flexbox row re-flowed everything each time it did.

						    The place leads here as it does in the add dialog. With the
						    name field gone, two rows are laid out for what is missing:
						    free time has no place, so its type moves down to share the
						    clock's row, and a journey's mode takes the rest of the
						    second row the people used to share, with the people running
						    full width underneath. No row is left half empty for any of
						    the five types.

						    The clock takes seven of the twelve columns rather than six,
						    which is what the pair actually measures: two fixed-width
						    clocks, a gap either side of "to", and 242px in all. Six
						    columns is 232px, and the difference used to come out of the
						    meridiem. Whatever shares the row takes the other five.

						    The clock and whatever shares its row take the whole width
						    below `sm`: two clocks of three segments each do not fit in
						    half of a 390px dialog. */}
						<div className="grid grid-cols-12 gap-x-2.5 gap-y-3.5">
							{placeField}
							<FieldShell label={cf.type} className={placeable ? 'col-span-4' : 'col-span-12'}>
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
												value={startMin}
												onChange={(v) => moveStart(String(v))}
												ariaLabel={cf.start}
											/>
											<span className="tfto">to</span>
											<TimeField
												value={endMin}
												onChange={(v) => setEnd(String(v))}
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
										? 'col-span-4'
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

						{journeys.section}
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
