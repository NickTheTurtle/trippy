import { useEffect, useRef, useState } from 'react';
import { isLocatedType, STAY_CHECK_IN, type EventType } from '@trippy/core/types';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import Select, { type Option } from '../../components/ui/Select';
import TimeField from '../../components/ui/TimeField';
import { Field, FieldShell, TextArea } from '../../components/ui/Field';
import { copy } from '../../copy';
import PeoplePicker from './PeoplePicker';
import StayDates from './StayDates';
import { useJourneys } from './Journeys';
import {
	DAY_END,
	DRAFT_ID,
	MIN_EVENT_MINS,
	TYPE_OPTIONS,
	dayLabel,
	deriveTitle,
	keepsPick,
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
	legs,
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
	day: string;
	/** Where on the clock the dialog was opened, when it was opened by pointing at a time. */
	startMin: number | null;
	/** What the dialog opens as, when it was opened from something type-specific. */
	initialType?: EventType;
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
	const [title, setTitle] = useState('');
	const [start, setStart] = useState(String(startMin ?? 9 * 60));
	const [end, setEnd] = useState(String((startMin ?? 9 * 60) + 60));
	/* A stay is asked for by its dates instead of by a clock. Kept beside the
	   times rather than instead of them, so switching type back and forth does
	   not lose what was already typed. */
	const [checkIn, setCheckIn] = useState(day);
	const [checkOut, setCheckOut] = useState(shiftDay(day, 1));
	const [people, setPeople] = useState<string[]>([]);
	const [poi, setPoi] = useState('');
	const [notes, setNotes] = useState('');

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
	const placeText = placeLabel(type);

	/* A stay is booked into one of the stays the group is voting on; everything
	   else happens at a saved place. One picker, two lists, because the field is
	   asking the same question either way: which of the things we have already
	   shortlisted is this? */
	const pickable = staying ? stays : saved;
	const poiOptions = placeOptions(pickable, cities, cityId);

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
			// An unnamed block still has to read as a block rather than as a gap,
			// and now reads as the name the server is about to give it.
			title: deriveTitle(title, spot?.name ?? null, notes, type),
			type,
			start_min: startAt,
			end_min: endAt,
			people,
			lat: spot?.lat ?? null,
			lng: spot?.lng ?? null
		});
	}, [
		onDay,
		staying,
		checkOut,
		title,
		notes,
		type,
		startAt,
		endAt,
		people,
		spot?.name,
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
						title: title.trim(),
						type,
						start: startAt,
						duration: endAt - startAt,
						poiId: placeable && poi ? poi : undefined,
						notes: notes.trim() || undefined,
						people
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
			<ModalForm className="schedule" onSubmit={add.submit}>
				<div className="mbody flex flex-col gap-4">
					{/* The same 12-column grid as the edit dialog: the two ask for the
					    same thing and should read the same way.

					    The place leads, because picking one is how a block is usually
					    added and the name follows from it. The grid stays full either
					    way: the wide half of the first row is the place when the type
					    has one, and the name when it does not, so free time does not
					    leave a hole beside the type. */}
					<div className="grid grid-cols-12 gap-x-2.5 gap-y-3.5">
						{placeable ? (
							<FieldShell label={placeText} optional className="col-span-8">
								<Select value={poi} onChange={setPoi} options={poiOptions} ariaLabel={placeText} />
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
						<PeoplePicker
							people={people}
							onChange={setPeople}
							memberOptions={memberOptions}
							crews={crews}
							className={staying ? 'col-span-4' : 'col-span-6'}
						/>

						{placeable && (
							<Field
								label="Name"
								className="col-span-12"
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
