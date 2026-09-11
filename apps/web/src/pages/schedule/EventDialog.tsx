import { useState } from 'react';
import type { EventType } from '@trippy/core/types';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Select, { type Option } from '../../components/ui/Select';
import { Field, FieldShell } from '../../components/ui/Field';
import { copy } from '../../copy';
import PeoplePicker from './PeoplePicker';
import {
	CLOCK_OPTIONS,
	DURATION_OPTIONS,
	MODE_OPTIONS,
	START_OPTIONS,
	TYPE_OPTIONS,
	dayLabel,
	hhmm,
	lengthLabel,
	withCurrent
} from './shared';
import type { Crew, EventRow } from './types';

/**
 * One event: retitle, retype, retime, re-people, delete.
 *
 * Changing the type to free time clears the event's place on the server. That
 * is the point of free time rather than a side effect: nobody has promised to
 * be anywhere, so the travel chain breaks on both sides of it and the next
 * journey starts from whatever the person is committed to afterwards.
 */
export default function EventDialog({
	base,
	event,
	cityName,
	memberOptions,
	crews,
	onClose,
	onDone
}: {
	base: string;
	event: EventRow;
	cityName: string | null;
	memberOptions: Option[];
	crews: Crew[];
	onClose: () => void;
	onDone: () => void;
}) {
	const [title, setTitle] = useState(event.title);
	const [type, setType] = useState<EventType>(event.type);
	const [start, setStart] = useState(String(event.start_min));
	const [duration, setDuration] = useState(String(Math.max(15, event.end_min - event.start_min)));
	const [checkIn, setCheckIn] = useState(String(event.start_min));
	const [checkOut, setCheckOut] = useState(String(event.end_min));
	const [people, setPeople] = useState<string[]>([...event.people]);
	const [notes, setNotes] = useState(event.notes ?? '');
	const [mode, setMode] = useState(event.travel_mode ?? '');
	const [killing, setKilling] = useState(false);

	const isStay = type === 'stay';
	const startMin = Number(isStay ? checkIn : start);
	const endMin = isStay ? Number(checkOut) : startMin + Number(duration);

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
				travelMode: type === 'travel' ? mode : undefined
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
				title="Event"
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
								label="Title"
								className="grow"
								autoFocus
								required
								value={title}
								onChange={(e) => setTitle(e.target.value)}
							/>
						</div>

						<div className="srow">
							{isStay ? (
								<>
									<FieldShell label="Check-in" className="tf2">
										<Select
											value={checkIn}
											onChange={setCheckIn}
											options={withCurrent(CLOCK_OPTIONS, checkIn, hhmm)}
											ariaLabel="Check-in"
										/>
									</FieldShell>
									<FieldShell label="Checkout" className="tf2" hint="The next morning">
										<Select
											value={checkOut}
											onChange={setCheckOut}
											options={withCurrent(CLOCK_OPTIONS, checkOut, hhmm)}
											ariaLabel="Checkout"
										/>
									</FieldShell>
								</>
							) : (
								<>
									<FieldShell label="Start" className="tf2">
										<Select
											value={start}
											onChange={setStart}
											options={withCurrent(START_OPTIONS, start, hhmm)}
											ariaLabel="Start"
										/>
									</FieldShell>
									<FieldShell label="Length" className="tf2">
										<Select
											value={duration}
											onChange={setDuration}
											options={withCurrent(DURATION_OPTIONS, duration, lengthLabel)}
											ariaLabel="Length"
										/>
									</FieldShell>
								</>
							)}
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
							<Field
								label="Notes"
								optional
								className="grow"
								value={notes}
								onChange={(e) => setNotes(e.target.value)}
							/>
						</div>

						<div className="dfacts">
							<span className="dfact">
								{hhmm(startMin)} to {hhmm(endMin)}
								{isStay && <span className="muted"> (next morning)</span>}
								{cityName && <span className="muted"> in {cityName}</span>}
							</span>
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
