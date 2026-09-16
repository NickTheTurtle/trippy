import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { AuthShell } from '../components/ui/AuthShell';
import { Field } from '../components/ui/Field';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../auth';
import { copy } from '../copy';

const c = copy.auth.login;

export default function Login() {
	const { status, logIn } = useAuth();
	const location = useLocation();
	const toast = useToast();

	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
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
		try {
			await logIn(email, password);
			// No navigate here on purpose. See the redirect above.
		} catch (err) {
			toast.error(err instanceof Error ? err.message : c.fallback);
			setSubmitting(false);
		}
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
					<Link to="/forgot" className="mb-1.5 block font-medium text-accent-ink">
						{copy.auth.forgot.link}
					</Link>
					{c.footerPrompt}{' '}
					<Link to="/register" className="font-medium text-accent-ink">
						{c.footerLink}
					</Link>
				</>
			}
		>
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
				autoComplete="current-password"
				value={password}
				onChange={(e) => setPassword(e.target.value)}
			/>
		</AuthShell>
	);
}
