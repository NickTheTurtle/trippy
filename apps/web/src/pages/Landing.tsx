import { Link, Navigate } from 'react-router';
import { useAuth } from '../auth';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { copy } from '../copy';

const c = copy.landing;

/**
 * The signed-out front page.
 *
 * Anyone with a session is redirected to `/trips` before this renders, so the
 * only reader is someone who has not signed in yet. That is why the primary
 * action is registering rather than a link into the app, and why it repeats the
 * header's wording instead of offering a third phrasing for the same thing.
 *
 * The redirect is here rather than in a guard around the route, because this
 * is the one public page that has it: the auth pages each already send a
 * signed-in visitor on in their own way. Nothing renders while the session is
 * still being checked, for the reason `RequireAuth` gives: a signed-in reload
 * of `/` would otherwise flash the pitch before leaving it.
 */
export default function Landing() {
	const { status } = useAuth();
	useDocumentTitle([]);
	if (status === 'loading') return null;
	if (status === 'authenticated') return <Navigate to="/trips" replace />;
	return (
		<main className="container py-16">
			<section className="max-w-2xl">
				<h1 className="font-serif text-hero leading-tight text-ink">{c.heading}</h1>
				<p className="muted mt-4 text-section">{c.blurb}</p>

				<div className="mt-8 flex flex-wrap gap-3">
					<Link to="/register" className="btn primary">
						{c.primaryCta}
					</Link>
					<Link to="/login" className="btn">
						{c.secondaryCta}
					</Link>
				</div>
			</section>

			<section className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
				{FEATURES.map((f) => (
					<div key={f.title} className="card px-5 py-5">
						<h2 className="text-section">{f.title}</h2>
						<p className="muted mt-1.5 text-body">{f.body}</p>
					</div>
				))}
			</section>
		</main>
	);
}

/**
 * Each of these is something the app does today. Nothing aspirational: a landing
 * page that promises more than the tool delivers is a bug report waiting to be
 * filed.
 */
const FEATURES = c.features;
