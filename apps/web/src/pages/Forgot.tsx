import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { AuthNotice, AuthShell } from '../components/ui/AuthShell';
import { Field } from '../components/ui/Field';
import { useErrorSlot } from '../components/ui/Toast';
import { useAuth } from '../auth';
import { api } from '../lib/api';
import { copy } from '../copy';

const c = copy.auth.forgot;

export default function Forgot() {
	const { status } = useAuth();
	const failure = useErrorSlot();
	const [email, setEmail] = useState('');
	const [sent, setSent] = useState(false);
	const [submitting, setSubmitting] = useState(false);

	if (status === 'authenticated') return <Navigate to="/trips" replace />;

	async function submit() {
		// The last attempt's refusal is not this attempt's answer.
		failure.clear();
		setSubmitting(true);
		try {
			await api('/auth/forgot', { method: 'POST', body: { email } });
			// Shown whatever the address turns out to be, matching the server, which
			// answers the same way for an address it has never seen. A page that
			// only confirmed for real accounts would give away the thing the server
			// is being careful not to.
			setSent(true);
		} catch (err) {
			failure.show(err instanceof Error ? err.message : c.fallback);
			setSubmitting(false);
		}
	}

	const logIn = (
		<Link to="/login" className="font-medium text-accent-ink">
			{c.footerLink}
		</Link>
	);

	if (sent) {
		return (
			<AuthNotice
				title={c.sentTitle}
				blurb={c.sentBlurb}
				footer={
					<>
						{c.footerPrompt} {logIn}
					</>
				}
			/>
		);
	}

	return (
		<AuthShell
			title={c.title}
			blurb={c.blurb}
			onSubmit={submit}
			submitting={submitting}
			submitLabel={c.submitLabel}
			footer={
				<>
					{c.footerPrompt} {logIn}
				</>
			}
		>
			<Field
				label={c.emailLabel}
				type="email"
				name="email"
				autoComplete="email"
				required
				value={email}
				onChange={(e) => setEmail(e.target.value)}
			/>
		</AuthShell>
	);
}
