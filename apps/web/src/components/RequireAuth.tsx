import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from '../auth';

/**
 * Gate for routes that need a signed-in user.
 *
 * The loading state renders nothing rather than a spinner: the session check is
 * a same-origin request that normally settles in a few milliseconds, and a
 * spinner that appears and vanishes that fast reads as a flicker. What it must
 * not do is redirect while still loading, which would bounce every signed-in
 * user to /login on each reload.
 */
export default function RequireAuth() {
	const { status } = useAuth();
	const location = useLocation();

	if (status === 'loading') return null;

	if (status === 'anonymous') {
		// Carry the attempted URL so login can return the user to it. Kept in
		// history state rather than the query string: it is plumbing, not
		// something worth showing in the address bar or letting a visitor edit.
		return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
	}

	return <Outlet />;
}
