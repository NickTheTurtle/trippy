import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { AuthNotice } from '../components/ui/AuthShell';
import { useAuth } from '../auth';
import { copy } from '../copy';

const c = copy.auth.verify;

/**
 * The landing page for a confirmation link. There is nothing to fill in: the
 * link is the whole credential, so the page spends it on arrival and then
 * either the app is signed in or it says why not.
 */
export default function Verify() {
	const { status, verify } = useAuth();
	const [params] = useSearchParams();
	const token = params.get('token') ?? '';
	const [error, setError] = useState<string | null>(null);
	// The token is single use, so a second POST would always fail. React runs
	// effects twice in development, which would otherwise turn every successful
	// confirmation into a failure on screen.
	const spent = useRef(false);

	useEffect(() => {
		if (!token || spent.current) return;
		spent.current = true;
		verify(token).catch((err) => setError(err instanceof Error ? err.message : c.failedTitle));
	}, [token, verify]);

	if (status === 'authenticated') return <Navigate to="/trips" replace />;
	if (!token) return <Navigate to="/register" replace />;

	if (error) {
		return (
			<AuthNotice
				title={c.failedTitle}
				blurb={error}
				footer={
					<Link to="/register" className="font-medium text-accent-ink">
						{c.retry}
					</Link>
				}
			/>
		);
	}

	return <AuthNotice title={c.title} blurb={c.blurb} />;
}
