import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter } from '../../components/ui/Modal';
import { Field } from '../../components/ui/Field';
import type { Person } from './types';
import { copy } from '../../copy';

const c = copy.people.edit;

/**
 * Edits one member of the trip: their name, and for somebody who has not
 * registered yet, the address their invite goes to.
 *
 * Only offered for people who cannot log in: an invited placeholder and a
 * seeded sample companion. Everyone else's name and address belong to their own
 * account and to every other trip they are on, so they are theirs to change in
 * Account.
 *
 * Name and email are one dialog rather than two because they are one thought
 * ("this is who that is"), and because a second pencil on the row would make
 * the reader choose between them before knowing what either did.
 */
export default function EditMember({
	person,
	tripId,
	onClose,
	onSaved,
	onDone
}: {
	person: Person;
	tripId: string;
	onClose: () => void;
	onSaved: () => void;
	onDone: (text: string) => void;
}) {
	const [name, setName] = useState(person.name);
	// A placeholder with no address shows an empty box, not the synthetic one the
	// server keeps to satisfy its UNIQUE index.
	const [email, setEmail] = useState(person.invitedEmail ?? '');
	// A seeded companion is a sample, not a person waiting on an invite, so it
	// has no address to offer.
	const editableEmail = person.placeholder;

	const save = useMutation(
		async () => {
			if (name.trim() !== person.name) {
				await api(`/trips/${tripId}/people/${person.id}`, { method: 'PATCH', body: { name } });
			}
			// Sent whenever the box was touched, including back to the same address:
			// re-sending a lost invite is the same intent as setting one, so it is
			// the same control rather than a second button that looks identical.
			if (editableEmail && email.trim()) {
				const { message } = await api<{ message: string }>(
					`/trips/${tripId}/people/${person.id}/email`,
					{ method: 'PATCH', body: { email } }
				);
				onDone(message);
			} else if (editableEmail && person.invitedEmail) {
				await api(`/trips/${tripId}/people/${person.id}/email`, {
					method: 'PATCH',
					body: { email: '' }
				});
			}
			onSaved();
			onClose();
		},
		{ fallback: c.fallback }
	);

	return (
		<Modal open size="sm" title={c.title} onClose={onClose}>
			<form className="mform" onSubmit={save.submit}>
				<div className="mbody flex flex-col gap-4">
					<Field
						label={c.nameLabel}
						autoFocus
						required
						autoComplete="off"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
					{editableEmail && (
						<Field
							label={c.emailLabel}
							type="email"
							autoComplete="off"
							hint={person.invitedEmail ? c.emailResendHint : c.emailHint}
							value={email}
							onChange={(e) => setEmail(e.target.value)}
						/>
					)}
				</div>

				<ModalFooter
					error={save.error}
					onClose={onClose}
					busy={save.busy}
					busyLabel={copy.common.saving}
					submitLabel={copy.common.save}
				/>
			</form>
		</Modal>
	);
}
