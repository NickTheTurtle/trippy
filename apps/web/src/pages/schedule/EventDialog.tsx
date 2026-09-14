import { useEffect, useRef, useState } from 'react';
import { isLocatedType, type EventType } from '@trippy/core/types';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Select, { type Option } from '../../components/ui/Select';
import { Field, FieldShell } from '../../components/ui/Field';
import { copy } from '../../copy';
import PeoplePicker from './PeoplePicker';
import {
	DAY_END,
	MODE_OPTIONS,
	START_OPTIONS,
	TYPE_OPTIONS,
	dayLabel,
	endOptions,
	hhmm,
	placeOptions,
	withCurrent
} from './shared';
import type { Cell, Crew, EventDraft, EventRow, SavedPoi } from './types';

/**
 * One event: rename, retype, retime, re-people, relocate, delete.
 *
 * Changing the type to free time clears the event's location on the server.
 * That is the point of free time rather than a side effect: nobody has promised
 * to be anywhere, so the travel chain breaks on both sides of it and the next
 * journey starts from whatever the person is committed to afterwards.
 *
 * Every field that moves the block reports upward as it is typed, so the board
 * redraws under the dialog rather than after it. `peek` is what makes that
 * worth doing: it leaves the board uncovered and legible behind the panel.
 */
export default function EventDialog({
	base,
	event,
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

	const op = (body: Record<string, unknown>) =>
		api(`${base}/events/${event.id}/op`, { method: 'POST', body });

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
				startMin,
				endMin,
				// Absent leaves it alone; empty hands the journey back to the router.
				travelMode: type === 'travel' ? mode : undefined,
				// Absent leaves the place alone; empty unlinks it.
				poiId: placeable ? poi : undefined
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
					<div className="mbody">
						<div className="srow">
							<FieldShell label="Type" className="tf2">
								<Select
									value={type}
									onChange={(v) => setType(v as EventType)}
									options={TYPE_OPTIONS}
									ariaLabel="Type"
								/>
							</FieldShell>
							<Field
								label="Name"
								className="grow"
								autoFocus
								required
								value={title}
								onChange={(e) => setTitle(e.target.value)}
							/>
						</div>

						<div className="srow">
							<FieldShell label="Start" className="tf2">
								<Select
									value={start}
									onChange={moveStart}
									options={withCurrent(START_OPTIONS, start, hhmm)}
									ariaLabel="Start"
								/>
							</FieldShell>
							<FieldShell label="End" className="tf2">
								<Select
									value={end}
									onChange={setEnd}
									options={withCurrent(endOptions(startMin), end, hhmm)}
									ariaLabel="End"
								/>
							</FieldShell>
							{type === 'travel' && (
								<FieldShell label="Mode" optional className="tf2">
									<Select value={mode} onChange={setMode} options={MODE_OPTIONS} ariaLabel="Mode" />
								</FieldShell>
							)}
							<PeoplePicker
								people={people}
								onChange={setPeople}
								memberOptions={memberOptions}
								crews={crews}
								className="grow"
							/>
						</div>

						<div className="srow">
							{placeable && (
								<FieldShell label={placeLabel} optional className="grow">
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
								className="grow"
								value={notes}
								onChange={(e) => setNotes(e.target.value)}
							/>
						</div>
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
