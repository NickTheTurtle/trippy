import { Link } from 'react-router';
import { useAuth } from '../auth';

/**
 * The catch-all route. It offers a way back rather than only stating the
 * problem, and where "back" goes depends on whether there is a session: a
 * signed-out visitor sent to /trips would only bounce to the login page.
 */
export default function NotFound() {
	const { status } = useAuth();
	return (
		<main className="mx-auto flex w-full max-w-[34rem] flex-col items-start gap-4 px-6 pt-16 pb-16">
			<h1 className="text-[1.7rem]">Page not found</h1>
			<p className="muted">That link does not point at anything in this app.</p>
			<Link className="btn primary" to={status === 'authenticated' ? '/trips' : '/'}>
				{status === 'authenticated' ? 'Back to my trips' : 'Back to the start'}
			</Link>
		</main>
	);
}
