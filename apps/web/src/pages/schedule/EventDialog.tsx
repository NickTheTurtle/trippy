import { useEffect, useRef, useState } from 'react';
import { isLocatedType, STAY_CHECK_IN, type EventType } from '@trippy/core/types';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import { useDeleteAction } from '../../components/ui/useDeleteAction';
import Select, { type Option } from '../../components/ui/Select';
import TimeField from '../../components/ui/TimeField';
import { Field, FieldShell, TextArea } from '../../components/ui/Field';
import { copy } from '../../copy';
import PeoplePicker from './PeoplePicker';
import { useJourneys } from './Journeys';
import {
	DAY_END,
	MIN_EVENT_MINS,
	MODE_OPTIONS,
	TYPE_OPTIONS,
	dayLabel,
	deriveTitle,
	keepsPick,
	placeLabel,
	placeOptions,
	rangeLabel,
	shiftDay
} from './shared';
import StayDates from './StayDates';
import type { Cell, Crew, EventDraft, EventRow, LegRow, SavedPoi } from './types';

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
	/* Which link the block already has depends on what it is: a stay is booked
	   into a proposed stay, everything else is scheduled at a saved place. */
	const savedPick = (event.type === 'stay' ? event.lodging_id : event.poi_id) ?? '';
	const [poi, setPoi] = useState(savedPick);

	const journeys = useJourneys({ legs, eventOf, peopleLabel, focusLegId });

	const startMin = Number(start);
	const endMin = Number(end);
	const staying = type === 'stay';
	/** The day the block lands on, which is its check-in once it is a stay. */
	const onDay = staying ? checkIn : event.day;

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

	/* One picker, two lists: a stay is booked into one of the stays the group is
	   voting on, everything else happens at a saved place. */
	const pickable = staying ? stays : saved;

	/* Where the draft stands, which the board, the map and the planner all read
	   as coordinates. An event can hold coordinates without a saved place, so an
	   untouched picker keeps them; choosing "No location" is what clears them. */
	const spot = pickable.find((p) => p.id === poi) ?? null;
	const lat = placeable ? (spot ? spot.lat : poi ? null : event.lat) : null;
	const lng = placeable ? (spot ? spot.lng : poi ? null : event.lng) : null;
	useEffect(() => {
		preview.current?.({
			id: event.id,
			day: onDay,
			end_day: staying ? checkOut : null,
			// Clearing the name is now a real edit rather than an unfinished one, so
			// the block shows the name the server will derive instead of holding on
			// to the one that is being removed.
			title: deriveTitle(title, placeable ? (spot?.name ?? null) : null, notes, type),
			type,
			start_min: staying ? STAY_CHECK_IN : startMin,
			end_min: staying ? DAY_END : endMin,
			people,
			lat,
			lng
		});
	}, [
		event.id,
		onDay,
		staying,
		checkOut,
		title,
		notes,
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

	const poiOptions = placeOptions(pickable, cities, cityId);

	/* Sent only when it has actually changed.
	 *
	 * An empty place means "unlink", and it clears the event's coordinates with
	 * it. But an event can hold coordinates without a saved place at all, and
	 * for one of those the picker reads "No location" the moment it opens: a
	 * reader who came here to change the end time and pressed Save would have
	 * wiped the spot the day is planned around, and every journey to it. */
	const placeMoved = poi !== savedPick;

	/* Sent only when it has actually changed, for the same reason.
	 *
	 * The name is optional now, so an empty one is a real instruction: clear it
	 * and the server derives a name again from the place, the notes or the type.
	 * That is only safe as long as the untouched case stays absent, because a
	 * reader who came here to move the block must not have the name they chose
	 * recomputed underneath them. Absent leaves it alone; empty re-derives. */
	const titleMoved = title.trim() !== event.title;

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
				title: titleMoved ? title.trim() : undefined,
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
				poiId: placeable && placeMoved ? poi : undefined,
				// What this form was opened on. The server refuses the write if the
				// event has moved on since, rather than letting this copy of every
				// untouched field overwrite whoever saved first.
				version: event.version
			});
			await api(`${base}/events/${event.id}/people`, { method: 'PUT', body: { people } });

			// The journeys last: they are planned off the people just saved, and
			// read back from the day the block has moved to rather than left.
			await journeys.save(base, onDay, event.id);

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
						    old flexbox row re-flowed everything each time it did.

						    The place leads here as it does in the add dialog, and the
						    wide half of the first row falls back to the name for a type
						    that has no place, so the row is never left half empty. */}
						<div className="grid grid-cols-12 gap-x-2.5 gap-y-3.5">
							{placeable ? (
								<FieldShell label={placeText} optional className="col-span-8">
									<Select
										value={poi}
										onChange={setPoi}
										options={poiOptions}
										ariaLabel={placeText}
									/>
								</FieldShell>
							) : (
								<Field
									label="Name"
									className="col-span-8"
									optional
									autoFocus
									value={title}
									onChange={(e) => setTitle(e.target.value)}
								/>
							)}
							<FieldShell label="Type" className="col-span-4">
								<Select
									value={type}
									onChange={(v) => {
										const next = v as EventType;
										if (!keepsPick(type, next)) setPoi('');
										setType(next);
									}}
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
								<Field
									label="Name"
									className={type === 'travel' ? 'col-span-8' : 'col-span-12'}
									optional
									value={title}
									onChange={(e) => setTitle(e.target.value)}
								/>
							)}
							<TextArea
								label="Notes"
								optional
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
