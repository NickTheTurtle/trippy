import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import { Field } from '../../components/ui/Field';
import FormError from '../../components/ui/FormError';
import { copy } from '../../copy';

const c = copy.people.invite;

/** The organizer-only invite panel. */
export default function Invite({
	tripId,
	onDone
}: {
	tripId: string;
	onDone: (text: string) => void;
}) {
	const [email, setEmail] = useState('');

	const invite = useMutation(
		async () => {
			const { message } = await api<{ message: string }>(`/trips/${tripId}/people/invites`, {
				method: 'POST',
				body: { email }
			});
			setEmail('');
			onDone(message);
		},
		{ fallback: c.fallback }
	);

	return (
		<section className="card sticky top-4 px-5 py-5">
			<h2 className="mb-3.5 text-section">{c.heading}</h2>
			{/* Beside the box that was refused, not at the top of the page: the
			    message is almost always about the address that was just typed. */}
			<FormError message={invite.error} variant="banner" />
			<form className="flex flex-col gap-2" onSubmit={invite.submit}>
				<Field
					label={c.emailLabel}
					type="email"
					required
					autoComplete="off"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
				<button className="btn primary" type="submit" disabled={invite.busy}>
					{invite.busy ? c.busyLabel : c.submitLabel}
				</button>
			</form>
		</section>
	);
}
