import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { AuthShell, Field } from '../components/AuthShell';
import { useAuth } from '../auth';

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
			setError(err instanceof Error ? err.message : 'Could not create the account.');
			setSubmitting(false);
		}
	}

	return (
		<AuthShell
			title="Create your account"
			blurb="Start planning your first trip in minutes."
			error={error}
			onSubmit={submit}
			submitting={submitting}
			submitLabel="Create account"
			footer={
				<>
					Already have an account?{' '}
					<Link to="/login" className="font-medium text-accent-ink">
						Log in
					</Link>
				</>
			}
		>
			<Field
				label="Name"
				type="text"
				name="name"
				autoComplete="name"
				value={name}
				onChange={(e) => setName(e.target.value)}
			/>
			<Field
				label="Email"
				type="email"
				name="email"
				autoComplete="email"
				value={email}
				onChange={(e) => setEmail(e.target.value)}
			/>
			<Field
				label="Password"
				type="password"
				name="password"
				autoComplete="new-password"
				hint="At least 8 characters"
				value={password}
				onChange={(e) => setPassword(e.target.value)}
			/>
		</AuthShell>
	);
}
