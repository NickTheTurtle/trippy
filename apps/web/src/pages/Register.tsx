import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { AuthNotice, AuthShell } from '../components/ui/AuthShell';
import { Field } from '../components/ui/Field';
import { useErrorSlot } from '../components/ui/Toast';
import { useAuth } from '../auth';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { copy } from '../copy';

const c = copy.auth.register;

export default function Register() {
	const { status, register } = useAuth();
	const [params] = useSearchParams();
	const failure = useErrorSlot();
	useDocumentTitle([c.submitLabel]);

	// An invite link carries the address it was sent to, so the one field that
	// has to match exactly for the invite to be consumed is filled in already.
	const [name, setName] = useState('');
	const [email, setEmail] = useState(params.get('email') ?? '');
	const [password, setPassword] = useState('');
	const [pending, setPending] = useState(false);
	const [submitting, setSubmitting] = useState(false);

	// Handles both arriving signed in and a successful sign up. A brand new
	// account has no deep link to return to, so this always goes to /trips.
	if (status === 'authenticated') return <Navigate to="/trips" replace />;

	async function submit() {
		// The last attempt's refusal is not this attempt's answer.
		failure.clear();
		setSubmitting(true);
		try {
			// 'pending' means the account does not exist yet and a confirmation link
			// is in the post. The signed-in case redirects above, so only this one
			// needs anything rendered for it.
			if ((await register(name, email, password)) === 'pending') setPending(true);
		} catch (err) {
			failure.show(err instanceof Error ? err.message : c.fallback);
			setSubmitting(false);
		}
	}

	if (pending) return <AuthNotice title={c.sentTitle} blurb={c.sentBlurb} />;

	return (
		<AuthShell
			title={c.title}
			blurb={c.blurb}
			failure={failure}
			onSubmit={submit}
			submitting={submitting}
			submitLabel={c.submitLabel}
			footer={
				<>
					{c.footerPrompt}{' '}
					<Link to="/login" className="font-medium text-accent-ink">
						{c.footerLink}
					</Link>
				</>
			}
		>
			<Field
				label={c.nameLabel}
				type="text"
				name="name"
				autoComplete="name"
				required
				value={name}
				onChange={(e) => setName(e.target.value)}
			/>
			<Field
				label={c.emailLabel}
				type="email"
				name="email"
				autoComplete="email"
				required
				value={email}
				onChange={(e) => setEmail(e.target.value)}
			/>
			<Field
				label={c.passwordLabel}
				type="password"
				name="password"
				autoComplete="new-password"
				required
				hint={c.passwordHint}
				value={password}
				onChange={(e) => setPassword(e.target.value)}
			/>
		</AuthShell>
	);
}
