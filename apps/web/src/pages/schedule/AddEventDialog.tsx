import { useEffect, useRef, useState } from 'react';
import { isLocatedType, type EventType } from '@trippy/core/types';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import Select, { type Option } from '../../components/ui/Select';
import TimeField from '../../components/ui/TimeField';
import { Field, FieldShell, TextArea } from '../../components/ui/Field';
import { copy } from '../../copy';
import PeoplePicker from './PeoplePicker';
import {
	DAY_END,
	MIN_EVENT_MINS,
	TYPE_OPTIONS,
	dayLabel,
	placeLabel,
	placeOptions
} from './shared';
import type { Cell, Crew, EventDraft, SavedPoi } from './types';

/** The id a block being added stands under until it has one of its own. */
const DRAFT_ID = 'draft';

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
 */
export default function AddEventDialog({
	base,
	day,
	defaults,
	startMin,
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
	day: string;
	defaults: { stayStart: number; stayMins: number };
	/** Where on the clock the dialog was opened, when it was opened by pointing at a time. */
	startMin: number | null;
	memberOptions: Option[];
	crews: Crew[];
	saved: SavedPoi[];
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
	const [type, setType] = useState<EventType>('activity');
	const [title, setTitle] = useState('');
	const [start, setStart] = useState(String(startMin ?? 9 * 60));
	const [end, setEnd] = useState(String((startMin ?? 9 * 60) + 60));
	const [people, setPeople] = useState<string[]>([]);
	const [poi, setPoi] = useState('');
	const [notes, setNotes] = useState('');

	const startAt = Number(start);
	const endAt = Number(end);

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

	const poiOptions = placeOptions(saved, cities, cityId);

	/* The same preview the edit dialog reports, under an id no event has: the
	   board inserts it into the day rather than overwriting a block, so the
	   reader watches the thing they are describing take its place. */
	const preview = useRef(onPreview);
	preview.current = onPreview;
	const spot = placeable ? (saved.find((p) => p.id === poi) ?? null) : null;
	useEffect(() => {
		preview.current?.({
			id: DRAFT_ID,
			day,
			// An unnamed block still has to read as a block rather than as a gap.
			title: title.trim() || 'New event',
			type,
			start_min: startAt,
			end_min: endAt,
			people,
			lat: spot?.lat ?? null,
			lng: spot?.lng ?? null
		});
	}, [day, title, type, startAt, endAt, people, spot?.lat, spot?.lng]);
	// Mount-scoped, so the board drops the block whether it was added or not.
	useEffect(() => () => preview.current?.(null), []);

	const add = useMutation(
		async () => {
			await api(`${base}/events`, {
				method: 'POST',
				body: {
					day,
					title: title.trim(),
					type,
					start: Number(start),
					duration: endAt - startAt,
					poiId: placeable && poi ? poi : undefined,
					notes: notes.trim() || undefined,
					people
				}
			});
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
			subtitle={dayLabel(day)}
			onClose={onClose}
		>
			<ModalForm className="schedule" onSubmit={add.submit}>
				<div className="mbody flex flex-col gap-4">
					{/* The same 12-column grid as the edit dialog: the two ask for the
					    same thing and should read the same way. */}
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
								onChange={(v) => {
									const next = v as EventType;
									setType(next);
									// A night is the one type with a useful starting guess, and
									// typing 21:00 by hand every time is the sort of work the
									// dialog exists to save. A time the reader pointed at is a
									// better guess than ours, so it is left alone.
									if (next === 'stay' && startMin == null) {
										setStart(String(defaults.stayStart));
										setEnd(String(Math.min(DAY_END, defaults.stayStart + defaults.stayMins)));
									}
								}}
								options={TYPE_OPTIONS}
								ariaLabel="Type"
							/>
						</FieldShell>

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
						<PeoplePicker
							people={people}
							onChange={setPeople}
							memberOptions={memberOptions}
							crews={crews}
							className="col-span-6"
						/>

						{placeable && (
							<FieldShell label={placeText} optional className="col-span-12">
								<Select value={poi} onChange={setPoi} options={poiOptions} ariaLabel={placeText} />
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
