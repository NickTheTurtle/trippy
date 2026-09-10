import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter } from '../../components/ui/Modal';
import type { Person } from './types';
import { copy } from '../../copy';

const c = copy.people.rename;

/**
 * Renames one member of the trip.
 *
 * Only offered for people who cannot log in: an invited placeholder, whose name
 * the app made up out of their email address, and a seeded sample companion.
 * Everyone else's name belongs to their own account and to every other trip
 * they are on, so it is theirs to change in Account.
 */
export default function RenameMember({
	person,
	tripId,
	onClose,
	onSaved
}: {
	person: Person;
	tripId: string;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [name, setName] = useState(person.name);

	const save = useMutation(
		async () => {
			await api(`/trips/${tripId}/people/${person.id}`, { method: 'PATCH', body: { name } });
			onSaved();
			onClose();
		},
		{ fallback: c.fallback }
	);

	return (
		<Modal open size="sm" title={c.title} onClose={onClose}>
			<form className="mform" onSubmit={save.submit}>
				<div className="mbody">
					<label className="field">
						<span>{c.nameLabel}</span>
						<input
							autoFocus
							required
							value={name}
							onChange={(e) => setName(e.target.value)}
							className="input w-full"
						/>
					</label>
				</div>

				<ModalFooter
					error={save.error}
					onClose={onClose}
					busy={save.busy}
					disabled={name.trim() === ''}
					busyLabel={copy.common.saving}
					submitLabel={c.saveLabel}
				/>
			</form>
		</Modal>
	);
}
