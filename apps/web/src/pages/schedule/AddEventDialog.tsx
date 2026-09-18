import { useEffect, useRef, useState } from 'react';
import { isLocatedType, STAY_CHECK_IN, type EventType } from '@trippy/core/types';
import { MAX_NAME_LENGTH } from '@trippy/core/validate';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import Select, { type Option } from '../../components/ui/Select';
import TimeField from '../../components/ui/TimeField';
import { FieldShell, Field, TextArea } from '../../components/ui/Field';
import { copy } from '../../copy';
import PeoplePicker from './PeoplePicker';
import PlaceField from './PlaceField';
import { usePlaceLookup } from './usePlaceSearch';
import StayDates from './StayDates';
import { useJourneys } from './Journeys';
import {
	DAY_END,
	DRAFT_ID,
	MIN_EVENT_MINS,
	MODE_OPTIONS,
	TYPE_OPTIONS,
	dayLabel,
	deriveTitle,
	keepsPick,
	NO_PEOPLE,
	placeLabel,
	placeOptions,
	rangeLabel,
	shiftDay
} from './shared';
import type { Cell, Crew, EventDraft, EventRow, LegRow, SavedPoi } from './types';

/**
 * Adds one event to a day.
 *
 * A stay is an ordinary block like everything else, so it is asked for the same
 * way: it only arrives with a later start and a later end, because that is what
 * a night usually looks like rather than something the model enforces.
 *
 * It docks and previews exactly as the edit dialog does. The two ask the same
 * question about the same board, and one of them standing at the edge with the
 * block drawn behind it while the other covered the page was the difference
 * reading as a bug.
 *
 * That extends to the journeys arriving at it. Adding is when they appear:
 * naming who is going is what makes the day plan travel to the new block, so
 * they are shown and editable while the block is being described rather than
 * only once it has been saved and reopened.
 */
export default function AddEventDialog({
	base,
	day,
	startMin,
	initialType,
	initialPoi,
	legs,
	eventOf,
	peopleLabel,
	memberOptions,
	crews,
	saved,
	stays,
	cities,
	cityId,
	provider,
	dock,
	peek,
	onPreview,
	onClose,
	onDone
}: {
	base: string;
	day: string;
	/** Where on the clock the dialog was opened, when it was opened by pointing at a time. */
	startMin: number | null;
	/** What the dialog opens as, when it was opened from something type-specific. */
	initialType?: EventType;
	/** A saved place the dialog opens with already picked, as the map's "+ Add" does. */
	initialPoi?: { id: string; name: string };
	/** The journeys the day plans to the block being added, replanned as it is typed. */
	legs: LegRow[];
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
	/** Who answers the place search, for the attribution under its results. */
	provider?: 'google' | 'osm';
	/** Which edge to stand at. */
	dock?: 'left' | 'right';
	/** Whether there is room to leave the board showing rather than covering it. */
	peek?: boolean;
	/** The block so far, or null once this dialog is gone. */
	onPreview?: (draft: EventDraft | null) => void;
	onClose: () => void;
	onDone: () => void;
}) {
	const [type, setType] = useState<EventType>(initialType ?? 'activity');
	const [start, setStart] = useState(String(startMin ?? 9 * 60));
	const [end, setEnd] = useState(String((startMin ?? 9 * 60) + 60));
	/* A stay is asked for by its dates instead of by a clock. Kept beside the
	   times rather than instead of them, so switching type back and forth does
	   not lose what was already typed. */
	const [checkIn, setCheckIn] = useState(day);
	const [checkOut, setCheckOut] = useState(shiftDay(day, 1));
	/* `null` once the organiser has emptied the field. Distinct from `[]`, which
	   is how everyone is stored, and refused at the save rather than at the tick. */
	const [people, setPeople] = useState<string[] | null>([]);
	/* Where the block is, as the field holds it: an id when a saved place was
	   picked, and the text either way. A typed name that matches nothing keeps
	   the id empty, and that pair is what the save sends. */
	const [poi, setPoi] = useState(initialPoi?.id ?? '');
	const [place, setPlace] = useState(initialPoi?.name ?? '');
	const [notes, setNotes] = useState('');
	/* What to call the block, when the name it would be given is not the one the
	   organiser wants. Blank is the normal case and means "name it yourself":
	   the server derives from the place, the first line of the notes, or the
	   type's own noun, which is the order the preview below mirrors. */
	const [label, setLabel] = useState('');
	/* Blank means "let the router decide", which is what the API does with an
	   absent mode, so an untouched field and no field at all are the same
	   request. Kept across a change of type, like the times and the dates, so
	   flipping to Activity and back does not lose the ferry that was picked. */
	const [mode, setMode] = useState('');

	const staying = type === 'stay';
	/** The day the block lands on, which is its check-in once it is a stay. */
	const onDay = staying ? checkIn : day;
	const startAt = staying ? STAY_CHECK_IN : Number(start);
	const endAt = staying ? DAY_END : Number(end);

	/** Moving the start carries the end with it: see `EventDialog`. */
	const moveStart = (next: string) => {
		setStart(next);
		setEnd(String(Math.min(DAY_END, Number(next) + (endAt - startAt))));
	};

	/** A typed end is only held to being an end once it is finished: see `EventDialog`. */
	const fixEnd = () => {
		if (endAt < startAt + MIN_EVENT_MINS) setEnd(String(startAt + MIN_EVENT_MINS));
	};

	// Free time is deliberately nowhere, so it is the one type with no location.
	// A journey's location is the far end of it: where it puts you.
	const placeable = isLocatedType(type);
	const placeFieldLabel = placeLabel(type);

	/* The provider search is biased to a city, so a day without one searches
	   nothing and the field is the saved list alone. */
	const searchCity = cities.find((c): c is Cell => c?.id === cityId) ?? null;
	const { found, onTyped, fieldProps } = usePlaceLookup({
		base,
		city: searchCity,
		type,
		provider,
		onPicked: (made, stay) => {
			setPlace(made.name);
			// Linked only when the block can hold what was added: a hotel found
			// from an activity is saved to the trip either way, but this block is
			// not the thing that books it.
			setPoi(stay === staying ? made.id : '');
		}
	});

	/* A stay is booked into one of the stays the group is voting on; everything
	   else happens at a saved place. One picker, two lists, because the field is
	   asking the same question either way: which of the things we have already
	   shortlisted is this? Anything the provider search added while this dialog
	   has been open goes in front of both: the newest thing is the thing being
	   looked for. */
	const pickable = staying ? [...found.stays, ...stays] : [...found.places, ...saved];
	const poiOptions = placeOptions(pickable, cities, cityId, type);

	const journeys = useJourneys({ legs, eventOf, peopleLabel });

	/** The block once it exists, so a retry after a failed save does not add it twice. */
	const created = useRef<string | null>(null);

	/* The same preview the edit dialog reports, under an id no event has: the
	   board inserts it into the day rather than overwriting a block, so the
	   reader watches the thing they are describing take its place. */
	const preview = useRef(onPreview);
	preview.current = onPreview;
	const spot = placeable ? (pickable.find((p) => p.id === poi) ?? null) : null;
	useEffect(() => {
		preview.current?.({
			id: DRAFT_ID,
			day: onDay,
			end_day: staying ? checkOut : null,
			// A typed label is the name; without one the block reads as the thing
			// it is about to be saved as rather than as a gap or a placeholder,
			// which is the same order the server names it in.
			title: label.trim() || deriveTitle(spot?.name ?? (place.trim() || null), notes, type),
			type,
			start_min: startAt,
			end_min: endAt,
			// An emptied field has nobody to draw, and the board reads no names as
			// the whole group, which is what it will be if this never gets saved.
			people: people ?? [],
			lat: spot?.lat ?? null,
			lng: spot?.lng ?? null
		});
	}, [
		onDay,
		staying,
		checkOut,
		notes,
		label,
		type,
		startAt,
		endAt,
		people,
		spot?.name,
		place,
		spot?.lat,
		spot?.lng
	]);
	// Mount-scoped, so the board drops the block whether it was added or not.
	useEffect(() => () => preview.current?.(null), []);

	const add = useMutation(
		async () => {
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
						// is the order the preview above mirrors.
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
						people: people ?? []
					}
				})
			).id;
			// The journeys were planned against the draft id, so they are written
			// back against the id the block ended up with.
			await journeys.save(base, onDay, created.current);
			onDone();
		},
		{ fallback: 'Could not add that event.' }
	);

	/* The Participants field can be emptied but not saved empty, so the refusal
	   is raised here, in the same footer slot and the same corner toast a server
	   refusal would use. */
	function submit(e: React.FormEvent) {
		e.preventDefault();
		if (!people) return add.setError(NO_PEOPLE);
		void add.run();
	}

	return (
		<Modal
			open
			size="lg"
			dock={dock}
			peek={peek}
			title="Add event"
			subtitle={staying ? rangeLabel(checkIn, checkOut) : dayLabel(day)}
			onClose={onClose}
		>
			<ModalForm className="schedule" onSubmit={submit}>
				<div className="mbody flex flex-col gap-4">
					{/* The same 12-column grid as the edit dialog: the two ask for the
					    same thing and should read the same way.

					    The place leads, because picking one is how a block is usually
					    added and the name usually follows from it. Free time has no
					    place at all, so its type moves down to share the clock's row
					    rather than leaving a hole. A label is the override for when
					    the derived name reads badly, so it sits at the bottom with
					    the notes rather than at the top where it would look required.

					    The clock takes seven of the twelve columns rather than six,
					    which is what the pair actually measures: two fixed-width
					    clocks, a gap either side of "to", and 242px in all. Six
					    columns is 232px, and the difference used to come out of the
					    meridiem. Whatever shares the row takes the other five.

					    The clock and whatever shares its row take the whole width
					    below `sm`: two clocks of three segments each do not fit in
					    half of a 390px dialog.

					    A journey's mode sits beside the clock and takes those five,
					    exactly as it does in the edit dialog, and the people move to a
					    full-width row underneath rather than being squeezed out of the
					    clock's row. Without it a journey could only be given a mode by
					    saving the block and opening it again, and the row it would
					    otherwise share was left half empty. */}
					<div className="grid grid-cols-12 gap-x-2.5 gap-y-3.5">
						{placeable && (
							<PlaceField
								label={placeFieldLabel}
								className="col-span-8"
								options={poiOptions}
								value={place}
								onChange={(text, id) => {
									setPlace(text);
									setPoi(id);
									// Only a typed query searches. A pick puts a name in the
									// box that nobody asked the provider for.
									onTyped(id ? '' : text);
								}}
								{...fieldProps}
							/>
						)}
						<FieldShell
							label="Type"
							className={placeable ? 'col-span-4' : 'col-span-12 sm:col-span-5'}
						>
							<Select
								value={type}
								onChange={(v) => {
									const next = v as EventType;
									// A pick the new type cannot hold goes, and the name it put
									// in the box goes with it: leaving the text behind would
									// silently turn a picked place into a typed one.
									if (!keepsPick(type, next, spot)) {
										setPoi('');
										setPlace('');
									}
									setType(next);
								}}
								options={TYPE_OPTIONS}
								ariaLabel="Type"
							/>
						</FieldShell>

						{staying ? (
							<StayDates
								checkIn={checkIn}
								checkOut={checkOut}
								onCheckIn={setCheckIn}
								onCheckOut={setCheckOut}
							/>
						) : (
							<FieldShell label="When" className="col-span-12 sm:col-span-7">
								<div className="tfpair">
									<TimeField
										value={startAt}
										onChange={(v) => moveStart(String(v))}
										ariaLabel="Start"
									/>
									<span className="tfto">to</span>
									<TimeField
										value={endAt}
										onChange={(v) => setEnd(String(v))}
										onCommit={fixEnd}
										ariaLabel="End"
									/>
								</div>
							</FieldShell>
						)}
						{type === 'travel' && (
							<FieldShell label="Mode" optional className="col-span-12 sm:col-span-5">
								<Select value={mode} onChange={setMode} options={MODE_OPTIONS} ariaLabel="Mode" />
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
									: placeable && type !== 'travel'
										? 'col-span-12 sm:col-span-5'
										: 'col-span-12'
							}
						/>

						{/* The placeholder is the name the block gets if this is left
						    alone, so the field says what it overrides without a hint
						    line repeating it. */}
						<Field
							label="Label"
							optional
							className="col-span-12"
							value={label}
							maxLength={MAX_NAME_LENGTH}
							placeholder={deriveTitle(spot?.name ?? (place.trim() || null), notes, type)}
							onChange={(e) => setLabel(e.target.value)}
						/>

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
					error={add.error}
					onClose={onClose}
					busy={add.busy}
					busyLabel={copy.common.adding}
					submitLabel={copy.common.add}
				/>
			</ModalForm>
		</Modal>
	);
}
