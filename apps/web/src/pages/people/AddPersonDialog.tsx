import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter } from '../../components/ui/Modal';
import { Field } from '../../components/ui/Field';
import { copy } from '../../copy';

const c = copy.people.add;

/**
 * Adds somebody to the trip: a display name, and an address only if they are
 * going to use the app.
 *
 * The address used to be the whole form, which meant every name on the roster
 * was guessed from the local part of an email and anyone not using the app
 * could not be on the trip at all, even though the money almost always
 * involves them. The organizer knows the name; the app should not be guessing
 * it, and should not be insisting on an address to hear it.
 */
export default function AddPersonDialog({
	tripId,
	onClose,
	onDone
}: {
	tripId: string;
	onClose: () => void;
	onDone: (text: string) => void;
}) {
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');

	const add = useMutation(
		async () => {
			const { message } = await api<{ message: string }>(`/trips/${tripId}/people/invites`, {
				method: 'POST',
				body: { name, email }
			});
			onDone(message);
			onClose();
		},
		{ fallback: c.fallback }
	);

	return (
		<Modal open size="sm" title={c.title} onClose={onClose}>
			<form className="mform" onSubmit={add.submit}>
				<div className="mbody flex flex-col gap-4">
					<Field
						label={c.nameLabel}
						autoFocus
						required
						autoComplete="off"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
					<Field
						label={c.emailLabel}
						type="email"
						autoComplete="off"
						hint={c.emailHint}
						value={email}
						onChange={(e) => setEmail(e.target.value)}
					/>
				</div>

				<ModalFooter
					error={add.error}
					onClose={onClose}
					busy={add.busy}
					busyLabel={copy.common.adding}
					submitLabel={copy.common.add}
				/>
			</form>
		</Modal>
	);
}
