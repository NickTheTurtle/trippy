import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import { Field } from '../../components/ui/Field';
import FormError from '../../components/ui/FormError';

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
		{ fallback: 'Could not send that invite.' }
	);

	return (
		<section className="card sticky top-4 px-5 py-5">
			<h3 className="mb-3.5 text-[1.05rem]">Invite someone</h3>
			{/* Beside the box that was refused, not at the top of the page: the
			    message is almost always about the address that was just typed. */}
			<FormError message={invite.error} variant="banner" />
			<form className="flex flex-col gap-2" onSubmit={invite.submit}>
				<Field
					label="Email address"
					type="email"
					required
					autoComplete="off"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
				<button className="btn primary" type="submit" disabled={invite.busy}>
					{invite.busy ? 'Sending...' : 'Send invite'}
				</button>
			</form>
			<p className="muted mt-2.5 text-[0.82rem]">
				If they have an account they join right away. Otherwise they hold a placeholder spot, and
				take it over (with any expenses assigned to them) when they register with this email.
			</p>
		</section>
	);
}
