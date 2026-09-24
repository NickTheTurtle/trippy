import { useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../auth';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import { useDeleteAction } from '../../components/ui/useDeleteAction';
import { Field } from '../../components/ui/Field';
import type { Person } from './types';
import { copy } from '../../copy';

const c = copy.people.edit;

/**
 * One member of the trip: their name, the address an invite goes to, and the
 * button that takes them off the trip.
 *
 * Three kinds of row open this. A placeholder or a seeded companion is the
 * trip's to name, so both fields are the trip's to write. Your own row is your
 * account's: the name is still editable, but it is saved to the account and
 * changes everywhere you appear, which is what anyone renaming themselves
 * means. Anybody else who can log in owns their own name, so their row states
 * who they are and offers only the removal.
 *
 * Name and email are one dialog rather than two because they are one thought
 * ("this is who that is"), and because a second pencil on the row would make
 * the reader choose between them before knowing what either did.
 */
export default function EditMember({
	person,
	me,
	tripId,
	onClose,
	onSaved,
	onDone,
	onRemove
}: {
	person: Person;
	/** The reader's own member id, since renaming yourself is not a trip write. */
	me: string;
	tripId: string;
	onClose: () => void;
	onSaved: () => void;
	onDone: (text: string) => void;
	/** Null for your own row, and for anybody at all when you are not the organizer. */
	onRemove?: (() => void | Promise<void>) | null;
}) {
	const { refresh } = useAuth();
	const [name, setName] = useState(person.name);
	// A placeholder with no address shows an empty box, not the synthetic one the
	// server keeps to satisfy its UNIQUE index.
	const [email, setEmail] = useState(person.invitedEmail ?? '');
	// A seeded companion is a sample, not a person waiting on an invite, so it
	// has no address to offer.
	const editableEmail = person.placeholder;
	const own = person.id === me && !person.placeholder && !person.seeded;
	/** Whether this name can be changed from here at all. */
	const editable = person.placeholder || person.seeded || own;

	const del = useDeleteAction({
		title: copy.common.deleteTitle(person.name),
		name: person.name,
		busyLabel: copy.common.deleting,
		onDelete: onRemove
	});

	const save = useMutation(
		async () => {
			if (name.trim() !== person.name) {
				if (own) {
					// Your name is the account's, not this trip's, so it is saved where
					// it lives. The top bar renders the session user, so it has to be
					// told the name it is showing has changed.
					await api('/account/profile', { method: 'PATCH', body: { name } });
					await refresh();
				} else {
					await api(`/trips/${tripId}/people/${person.id}`, { method: 'PATCH', body: { name } });
				}
			}
			// Only when it actually changed. Nothing is emailed, so saving the same
			// address again would be a write that does nothing and a notice saying
			// so. The server lower-cases what it stores, so the comparison does too.
			const next = email.trim().toLowerCase();
			if (editableEmail && next !== (person.invitedEmail ?? '')) {
				const { message } = await api<{ message: string }>(
					`/trips/${tripId}/people/${person.id}/email`,
					{ method: 'PATCH', body: { email: next } }
				);
				onDone(message);
			}
			onSaved();
			onClose();
		},
		{ fallback: c.fallback }
	);

	return (
		<>
			<Modal
				open={!del.asking}
				size="sm"
				title={editable ? c.title : person.name}
				onClose={onClose}
			>
				<ModalForm onSubmit={save.submit}>
					<div className="mbody flex flex-col gap-4">
						{editable ? (
							<>
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
										optional
										autoComplete="off"
										value={email}
										onChange={(e) => setEmail(e.target.value)}
									/>
								)}
							</>
						) : (
							// Nothing here is this trip's to change, so the dialog states
							// who they are and leaves the footer to do the only thing that
							// can be done from here.
							<p className="muted m-0">{person.email}</p>
						)}
					</div>

					<ModalFooter
						error={save.error}
						onClose={onClose}
						busy={save.busy}
						busyLabel={copy.common.saving}
						submitLabel={editable ? copy.common.save : undefined}
						start={del.button}
					/>
				</ModalForm>
			</Modal>
			{del.confirm}
		</>
	);
}
