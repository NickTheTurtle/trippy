import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { AuthNotice } from '../components/ui/AuthShell';
import { api } from '../lib/api';
import { useAuth } from '../auth';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { copy } from '../copy';

const c = copy.auth.verifyEmail;

/**
 * Where the link sent to a *new* address lands, when a signed-in member
 * changes their email. Modelled on `Verify`, with one difference that matters:
 * this does not sign anybody in. The link proves a mailbox, not a password,
 * and it may be opened on a phone that has never had a session here, so it
 * applies the change and says so, and the way on depends on whether this
 * browser is already signed in.
 *
 * Public, not behind `RequireAuth`, for the same reason: a guard would send
 * that phone to the login form and spend the link's only chance on a detour.
 */
export default function VerifyEmail() {
	const { status, refresh } = useAuth();
	const [params] = useSearchParams();
	const token = params.get('token') ?? '';
	const [state, setState] = useState<'working' | 'done' | { error: string }>('working');
	// Single use, like every emailed token, and React runs effects twice in
	// development: without this the second POST would fail and replace the
	// success on screen with "That link did not work".
	const spent = useRef(false);

	useEffect(() => {
		if (!token || spent.current) return;
		spent.current = true;
		api('/auth/verify-email', { method: 'POST', body: { token } })
			.then(async () => {
				// The session user carries the address, so a signed-in tab should
				// read the new one rather than the one it started with.
				await refresh();
				setState('done');
			})
			.catch((err) =>
				setState({ error: err instanceof Error ? err.message : copy.api.requestFailed })
			);
	}, [token, refresh]);

	const failed = typeof state === 'object';
	useDocumentTitle([failed ? c.failedTitle : state === 'done' ? c.doneTitle : c.title]);

	if (!token) return <Navigate to="/" replace />;

	const signedIn = status === 'authenticated';
	const onward = (
		<span className="flex flex-wrap justify-center gap-x-4 gap-y-1">
			{signedIn ? (
				<>
					<Link to="/account" className="font-medium text-accent-ink">
						{copy.shell.accountSettings}
					</Link>
					<Link to="/trips" className="font-medium text-accent-ink">
						{copy.common.allTrips}
					</Link>
				</>
			) : (
				<Link to="/login" className="font-medium text-accent-ink">
					{copy.shell.logIn}
				</Link>
			)}
		</span>
	);

	if (failed) return <AuthNotice title={c.failedTitle} blurb={state.error} footer={onward} />;
	if (state === 'done')
		return <AuthNotice title={c.doneTitle} blurb={c.doneBlurb} footer={onward} />;
	return <AuthNotice title={c.title} blurb={c.blurb} />;
}
