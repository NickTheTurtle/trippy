import { Link } from 'react-router';
import { useAuth } from '../auth';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { copy } from '../copy';

const c = copy.notFound;

/**
 * The catch-all route. It offers a way back rather than only stating the
 * problem, and where "back" goes depends on whether there is a session: a
 * signed-out visitor sent to /trips would only bounce to the login page.
 */
export default function NotFound() {
	const { status } = useAuth();
	useDocumentTitle([c.heading]);
	return (
		<main className="mx-auto flex w-full max-w-[34rem] flex-col items-start gap-4 px-6 pt-16 pb-16">
			<h1 className="text-title">{c.heading}</h1>
			<p className="muted">{c.body}</p>
			<Link className="btn primary" to={status === 'authenticated' ? '/trips' : '/'}>
				{status === 'authenticated' ? copy.common.allTrips : c.backAnonymous}
			</Link>
		</main>
	);
}
