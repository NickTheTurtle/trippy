import { useState } from 'react';
import type { EventType } from '@trippy/core/types';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import Select, { type Option } from '../../components/ui/Select';
import { Field, FieldShell } from '../../components/ui/Field';
import { copy } from '../../copy';
import PeoplePicker from './PeoplePicker';
import {
	DURATION_OPTIONS,
	START_OPTIONS,
	TYPE_OPTIONS,
	dayLabel,
	hhmm,
	lengthLabel,
	withCurrent
} from './shared';
import type { Crew, SavedPoi } from './types';

/**
 * Adds one event to a day.
 *
 * A stay is an ordinary block like everything else, so it is asked for the same
 * way: it only arrives with a later start and a longer length, because that is
 * what a night usually looks like rather than something the model enforces.
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
	defaults: { stayStart: number; stayMins: number };
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
	const [people, setPeople] = useState<string[]>([]);
	const [poi, setPoi] = useState('');
	const [notes, setNotes] = useState('');

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
					start: Number(start),
					duration: Number(duration),
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
								onChange={(v) => {
									const next = v as EventType;
									setType(next);
									// A night is the one type with a useful starting guess, and
									// typing 21:00 by hand every time is the sort of work the
									// dialog exists to save.
									if (next === 'stay') {
										setStart(String(defaults.stayStart));
										setDuration(String(defaults.stayMins));
									}
								}}
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
