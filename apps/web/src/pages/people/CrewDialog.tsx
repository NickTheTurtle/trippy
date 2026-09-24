import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import { useDeleteAction } from '../../components/ui/useDeleteAction';
import MultiSelect from '../../components/ui/MultiSelect';
import type { Option } from '../../components/ui/Select';
import { Field, FieldShell } from '../../components/ui/Field';
import { copy } from '../../copy';
import type { Crew } from './types';

const c = copy.people.crews;

/**
 * One crew: a name and the people in it.
 *
 * The form used to carry a third field, a picker choosing which crew was being
 * edited, because the dialog was the only place a crew was ever shown. The
 * sidebar lists them now, so the choice is made by the row that opened this,
 * and the dialog is the same add-or-edit shape as every other one in the app.
 */
export default function CrewDialog({
	tripId,
	crew,
	memberOptions,
	onClose,
	onDone
}: {
	tripId: string;
	/** Null when adding. */
	crew: Crew | null;
	memberOptions: Option[];
	onClose: () => void;
	onDone: () => void;
}) {
	const [name, setName] = useState(crew?.name ?? '');
	const [members, setMembers] = useState<string[]>(crew ? [...crew.members] : []);

	const base = `/trips/${tripId}/people/crews`;

	const del = useDeleteAction({
		title: copy.common.deleteTitle(crew?.name ?? ''),
		name: crew?.name ?? '',
		busyLabel: copy.common.deleting,
		onDelete:
			crew &&
			(async () => {
				await api(`${base}/${crew.id}`, { method: 'DELETE' });
				onDone();
				onClose();
			})
	});

	const save = useMutation(
		async () => {
			await api(crew ? `${base}/${crew.id}` : base, {
				method: crew ? 'PATCH' : 'POST',
				body: { name: name.trim(), people: members }
			});
			onDone();
			onClose();
		},
		{ fallback: c.fallback }
	);

	return (
		<>
			<Modal open={!del.asking} size="sm" title={crew ? c.editTitle : c.addTitle} onClose={onClose}>
				<ModalForm onSubmit={save.submit}>
					<div className="mbody flex flex-col gap-4">
						<Field
							label={c.nameLabel}
							autoFocus
							required
							autoComplete="off"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>

						<FieldShell label={c.peopleLabel}>
							<MultiSelect
								selected={members}
								onChange={setMembers}
								options={memberOptions}
								placeholder={c.nobody}
								ariaLabel={c.peopleAriaLabel}
							/>
						</FieldShell>
					</div>

					<ModalFooter
						error={save.error}
						onClose={onClose}
						busy={save.busy}
						busyLabel={crew ? copy.common.saving : copy.common.adding}
						submitLabel={crew ? copy.common.save : copy.common.add}
						start={del.button}
					/>
				</ModalForm>
			</Modal>

			{del.confirm}
		</>
	);
}
