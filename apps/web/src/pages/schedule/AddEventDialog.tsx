import { useState } from 'react';
import type { EventType } from '@trippy/core/types';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import Select, { type Option } from '../../components/ui/Select';
import { Field, FieldShell } from '../../components/ui/Field';
import { copy } from '../../copy';
import PeoplePicker from './PeoplePicker';
import { CLOCK_OPTIONS, DURATION_OPTIONS, START_OPTIONS, TYPE_OPTIONS, dayLabel } from './shared';
import type { Crew, SavedPoi } from './types';

/**
 * Adds one event to a day.
 *
 * A stay asks for check-in and checkout rather than a length, because it is the
 * one event that spans midnight: its checkout is a time on the following
 * morning, so a duration would have to be counted through the night to mean
 * anything.
 */
export default function AddEventDialog({
	base,
	day,
	defaults,
	memberOptions,
	crews,
	saved,
	onClose,
	onDone
}: {
	base: string;
	day: string;
	defaults: { checkIn: number; checkOut: number };
	memberOptions: Option[];
	crews: Crew[];
	saved: SavedPoi[];
	onClose: () => void;
	onDone: () => void;
}) {
	const [type, setType] = useState<EventType>('activity');
	const [title, setTitle] = useState('');
	const [start, setStart] = useState(String(9 * 60));
	const [duration, setDuration] = useState('60');
	const [checkIn, setCheckIn] = useState(String(defaults.checkIn));
	const [checkOut, setCheckOut] = useState(String(defaults.checkOut));
	const [people, setPeople] = useState<string[]>([]);
	const [poi, setPoi] = useState('');
	const [notes, setNotes] = useState('');

	const isStay = type === 'stay';
	// Free time is deliberately nowhere: the server clears a place off it, so
	// offering one here would promise something the save undoes.
	const placeable = type !== 'freetime';

	const poiOptions: Option[] = [
		{ value: '', label: 'No place' },
		...saved.map((p) => ({ value: p.id, label: p.name }))
	];

	const add = useMutation(
		async () => {
			await api(`${base}/events`, {
				method: 'POST',
				body: {
					day,
					title: title.trim(),
					type,
					start: Number(isStay ? checkIn : start),
					duration: Number(duration),
					// Only a stay carries an end: for everything else the server reads
					// the duration and keeps the event on its own day.
					end: isStay ? Number(checkOut) : undefined,
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
		<Modal open size="lg" title="Add event" subtitle={dayLabel(day)} onClose={onClose}>
			<ModalForm className="schedule" onSubmit={add.submit}>
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
										options={CLOCK_OPTIONS}
										ariaLabel="Check-in"
									/>
								</FieldShell>
								<FieldShell label="Checkout" className="tf2" hint="The next morning">
									<Select
										value={checkOut}
										onChange={setCheckOut}
										options={CLOCK_OPTIONS}
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
										options={START_OPTIONS}
										ariaLabel="Start"
									/>
								</FieldShell>
								<FieldShell label="Length" className="tf2">
									<Select
										value={duration}
										onChange={setDuration}
										options={DURATION_OPTIONS}
										ariaLabel="Length"
									/>
								</FieldShell>
							</>
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
							<FieldShell label="Place" optional className="grow">
								<Select value={poi} onChange={setPoi} options={poiOptions} ariaLabel="Place" />
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
