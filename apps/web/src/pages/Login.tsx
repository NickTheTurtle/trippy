import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { AuthShell } from '../components/ui/AuthShell';
import { Field } from '../components/ui/Field';
import { useAuth } from '../auth';

export default function Login() {
	const { status, logIn } = useAuth();
	const location = useLocation();

	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	// Set by RequireAuth when it turned a deep link away. Sending the user back
	// there beats dropping everyone on /trips and making them navigate again.
	const next = (location.state as { from?: string } | null)?.from ?? '/trips';

	// Covers both arriving here already signed in and finishing a log in: the
	// success path is a state change, and this redirect is what reacts to it.
	// An imperative navigate() after logIn() would lose the race against this
	// render and silently send everyone to the default instead of `next`.
	if (status === 'authenticated') return <Navigate to={next} replace />;

	async function submit() {
		setSubmitting(true);
		setError(null);
		try {
			await logIn(email, password);
			// No navigate here on purpose. See the redirect above.
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Could not log in.');
			setSubmitting(false);
		}
	}

	return (
		<AuthShell
			title="Welcome back"
			blurb="Log in to keep planning."
			error={error}
			onSubmit={submit}
			submitting={submitting}
			submitLabel="Log in"
			footer={
				<>
					New here?{' '}
					<Link to="/register" className="font-medium text-accent-ink">
						Create an account
					</Link>
				</>
			}
		>
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
				autoComplete="current-password"
				value={password}
				onChange={(e) => setPassword(e.target.value)}
			/>
		</AuthShell>
	);
}
