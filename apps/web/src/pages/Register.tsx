import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { AuthShell } from '../components/ui/AuthShell';
import { Field } from '../components/ui/Field';
import { useAuth } from '../auth';
import { copy } from '../copy';

const c = copy.auth.register;

export default function Register() {
	const { status, register } = useAuth();

	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	// Handles both arriving signed in and a successful sign up. A brand new
	// account has no deep link to return to, so this always goes to /trips.
	if (status === 'authenticated') return <Navigate to="/trips" replace />;

	async function submit() {
		setSubmitting(true);
		setError(null);
		try {
			await register(name, email, password);
		} catch (err) {
			setError(err instanceof Error ? err.message : c.fallback);
			setSubmitting(false);
		}
	}

	return (
		<AuthShell
			title={c.title}
			blurb={c.blurb}
			error={error}
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
				value={name}
				onChange={(e) => setName(e.target.value)}
			/>
			<Field
				label={c.emailLabel}
				type="email"
				name="email"
				autoComplete="email"
				value={email}
				onChange={(e) => setEmail(e.target.value)}
			/>
			<Field
				label={c.passwordLabel}
				type="password"
				name="password"
				autoComplete="new-password"
				hint={c.passwordHint}
				value={password}
				onChange={(e) => setPassword(e.target.value)}
			/>
		</AuthShell>
	);
}
