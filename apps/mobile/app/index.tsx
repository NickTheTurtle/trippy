import { Redirect } from 'expo-router';
import { useAuth } from '../src/auth';
import { Loading } from '../src/ui';

/**
 * There is no landing page on mobile. Someone who opened the app either has a
 * session, in which case they want their trips, or does not, in which case they
 * want to sign in. A marketing screen between the two would be in the way.
 */
export default function Index() {
	const { user, loading } = useAuth();
	if (loading) return <Loading />;
	return <Redirect href={user ? '/trips' : '/login'} />;
}
