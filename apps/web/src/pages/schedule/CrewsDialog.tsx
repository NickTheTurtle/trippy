import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import MultiSelect from '../../components/ui/MultiSelect';
import Select, { type Option } from '../../components/ui/Select';
import { Field, FieldShell } from '../../components/ui/Field';
import { copy } from '../../copy';
import type { Crew } from './types';

const NEW = '';

/**
 * Crews: saved groups of people, and nothing else.
 *
 * The old party owned a schedule, a city and a membership that changed through
 * the day, so putting two people in a group was a planning decision with
 * week-long consequences. A crew only fills in the people picker, so it can be
 * renamed or deleted at any time without the schedule moving underneath
 * anybody.
 *
 * One form rather than a list of rows: create, rename, set members and delete
 * are all the same three fields, and the picker at the top is what chooses
 * between making a new one and editing one that exists.
 */
export default function CrewsDialog({
	base,
	crews,
	memberOptions,
	onClose,
	onDone
}: {
	base: string;
	crews: Crew[];
	memberOptions: Option[];
	onClose: () => void;
	onDone: () => void;
}) {
	const [picked, setPicked] = useState(NEW);
	const [name, setName] = useState('');
	const [members, setMembers] = useState<string[]>([]);
	const [killing, setKilling] = useState(false);

	const current = crews.find((c) => c.id === picked) ?? null;

	/** Switching crews reloads the fields, since they describe the picked one. */
	function pick(id: string) {
		setPicked(id);
		const crew = crews.find((c) => c.id === id) ?? null;
		setName(crew?.name ?? '');
		setMembers(crew ? [...crew.members] : []);
	}

	const save = useMutation(
		async () => {
			if (current) {
				await api(`${base}/crews/${current.id}`, {
					method: 'PATCH',
					body: { name: name.trim(), people: members }
				});
			} else {
				await api(`${base}/crews`, {
					method: 'POST',
					body: { name: name.trim(), people: members }
				});
				// The dialog stays open on the "New crew" entry, because the next
				// thing after making one crew is usually making the other one.
				setName('');
				setMembers([]);
			}
			onDone();
		},
		{ fallback: 'Could not save that crew.' }
	);

	const options: Option[] = [
		{ value: NEW, label: 'New crew' },
		...crews.map((c) => ({ value: c.id, label: c.name }))
	];

	return (
		<>
			<Modal open={!killing} size="md" title="Crews" onClose={onClose}>
				<ModalForm className="schedule" onSubmit={save.submit}>
					<div className="mbody">
						<FieldShell label="Crew">
							<Select value={picked} onChange={pick} options={options} ariaLabel="Crew" />
						</FieldShell>

						<Field label="Name" required value={name} onChange={(e) => setName(e.target.value)} />

						<FieldShell label="People">
							<MultiSelect
								selected={members}
								onChange={setMembers}
								options={memberOptions}
								placeholder="Nobody yet"
								ariaLabel="Crew members"
							/>
						</FieldShell>
					</div>

					<ModalFooter
						error={save.error}
						onClose={onClose}
						busy={save.busy}
						busyLabel={current ? copy.common.saving : copy.common.adding}
						submitLabel={current ? copy.common.save : copy.common.add}
						start={
							current && (
								<button type="button" className="btn danger" onClick={() => setKilling(true)}>
									{copy.common.delete}
								</button>
							)
						}
					/>
				</ModalForm>
			</Modal>

			{current && (
				<ConfirmDialog
					open={killing}
					title={`Delete ${current.name}?`}
					busyLabel={copy.common.deleting}
					onCancel={() => setKilling(false)}
					onConfirm={async () => {
						await api(`${base}/crews/${current.id}`, { method: 'DELETE' });
						pick(NEW);
						setKilling(false);
						onDone();
					}}
				/>
			)}
		</>
	);
}
