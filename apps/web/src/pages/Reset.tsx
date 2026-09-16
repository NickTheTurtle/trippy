import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { AuthNotice, AuthShell } from '../components/ui/AuthShell';
import { Field } from '../components/ui/Field';
import { useToast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { copy } from '../copy';

const c = copy.auth.reset;

export default function Reset() {
	const [params] = useSearchParams();
	const token = params.get('token') ?? '';
	const toast = useToast();

	const [password, setPassword] = useState('');
	const [done, setDone] = useState(false);
	const [submitting, setSubmitting] = useState(false);

	// Nothing on this page works without a token, and a bare /reset is somebody
	// who typed the path rather than followed a link.
	if (!token) return <Navigate to="/forgot" replace />;

	async function submit() {
		setSubmitting(true);
		try {
			await api('/auth/reset', { method: 'POST', body: { token, password } });
			setDone(true);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : c.fallback);
			setSubmitting(false);
		}
	}

	const logIn = (
		<Link to="/login" className="font-medium text-accent-ink">
			{c.footerLink}
		</Link>
	);

	// No redirect and no session: the server drops every session on a reset, so
	// signing in is the next step and the page says so rather than doing it.
	if (done) {
		return <AuthNotice title={c.doneTitle} blurb={c.doneBlurb} footer={logIn} />;
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
