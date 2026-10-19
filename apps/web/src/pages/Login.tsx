import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { AuthShell } from '../components/ui/AuthShell';
import { Field } from '../components/ui/Field';
import { useErrorSlot } from '../components/ui/Toast';
import ProviderButtons from '../components/ProviderButtons';
import { useAuth } from '../auth';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { copy, providerError } from '../copy';

const c = copy.auth.login;

export default function Login() {
	const { status, logIn } = useAuth();
	const location = useLocation();
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const failure = useErrorSlot();
	useDocumentTitle([c.submitLabel]);

	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [submitting, setSubmitting] = useState(false);

	// Set by RequireAuth when it turned a deep link away. Sending the user back
	// there beats dropping everyone on /trips and making them navigate again.
	const from = (location.state as { from?: string } | null)?.from;
	const next = from ?? '/trips';

	// A Google or Apple sign-in that failed comes back here with the reason in
	// the query, since a redirect has no other way to carry it. It goes in the
	// same corner as a wrong password, and then out of the address bar
	// (`replace`, which is `history.replaceState` under the router) so a reload
	// does not report the same failure a second time.
	const authError = params.get('authError');
	useEffect(() => {
		if (authError === null) return;
		failure.show(providerError(authError));
		const rest = new URLSearchParams(params);
		rest.delete('authError');
		const search = rest.toString();
		navigate({ search: search ? `?${search}` : '' }, { replace: true, state: location.state });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [authError]);

	// Covers both arriving here already signed in and finishing a log in: the
	// success path is a state change, and this redirect is what reacts to it.
	// An imperative navigate() after logIn() would lose the race against this
	// render and silently send everyone to the default instead of `next`.
	if (status === 'authenticated') return <Navigate to={next} replace />;

	async function submit() {
		// The last attempt's refusal is not this attempt's answer.
		failure.clear();
		setSubmitting(true);
		try {
			await logIn(email, password);
			// No navigate here on purpose. See the redirect above.
		} catch (err) {
			failure.show(err instanceof Error ? err.message : c.fallback);
			setSubmitting(false);
		}
	}

	return (
		<AuthShell
			title={c.title}
			blurb={c.blurb}
			failure={failure}
			onSubmit={submit}
			submitting={submitting}
			submitLabel={c.submitLabel}
			// The deep link RequireAuth saved, if there was one; with none the
			// server sends a provider sign-in to /trips, as the form does.
			lead={<ProviderButtons next={from} />}
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
				required
				value={email}
				onChange={(e) => setEmail(e.target.value)}
			/>
			<Field
				label={c.passwordLabel}
				type="password"
				name="password"
				autoComplete="current-password"
				required
				value={password}
				onChange={(e) => setPassword(e.target.value)}
			/>
		</AuthShell>
	);
}
