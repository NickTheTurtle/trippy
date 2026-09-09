import { Link } from 'react-router';

/**
 * The signed-out front page.
 *
 * Anyone with a session is redirected to `/trips` before this renders, so the
 * only reader is someone who has not signed in yet. That is why the primary
 * action is registering rather than a link into the app, and why it repeats the
 * header's wording instead of offering a third phrasing for the same thing.
 */
export default function Landing() {
	return (
		<main className="container py-16">
			<section className="max-w-2xl">
				<h1 className="font-serif text-[2.6rem] leading-tight text-ink">
					Plan the trip together, not in twelve group chats.
				</h1>
				<p className="muted mt-4 text-[1.05rem]">
					Trippy keeps a group's places, days, beds and money in one place, in every time zone the
					trip passes through.
				</p>

				<div className="mt-8 flex flex-wrap gap-3">
					<Link to="/register" className="btn primary">
						Start planning
					</Link>
					<Link to="/login" className="btn">
						Log in
					</Link>
				</div>
			</section>

			<section className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
				{FEATURES.map((f) => (
					<div key={f.title} className="card px-5 py-5">
						<h2 className="text-[1.05rem]">{f.title}</h2>
						<p className="muted mt-1.5 text-[0.92rem]">{f.body}</p>
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
const FEATURES = [
	{
		title: 'Collect the places',
		body: 'Search a city and everyone adds what they want to see. Vote, so the shortlist picks itself.'
	},
	{
		title: 'Build the days',
		body: 'Put places on a calendar with the travel time between them already worked out.'
	},
	{
		title: 'Split the group',
		body: 'Run parallel tracks when half the group wants the museum and half wants the beach.'
	},
	{
		title: 'Pick where to sleep',
		body: 'Put the options up with prices and nights, let the group vote, then lock the choice.'
	},
	{
		title: 'Know what it costs',
		body: 'Estimate before you go, log what was actually spent, in whichever currency it was spent in.'
	},
	{
		title: 'Settle up at the end',
		body: 'The fewest transfers that clear everyone, and a button to record each one as paid.'
	}
];
