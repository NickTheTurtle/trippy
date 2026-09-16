import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import Cover from '../components/Cover';
import EmptyState from '../components/ui/EmptyState';
import LoadError from '../components/ui/LoadError';
import TripFormDialog from '../components/TripFormDialog';
import { PlusIcon } from '../components/ui/icons';
import { copy } from '../copy';

const c = copy.trips;

type City = { id: string; name: string; photo: string | null };
type Trip = {
	id: string;
	name: string;
	dates: string;
	cover: string;
	role: string;
	cities: City[];
	memberCount: number;
};

export default function Trips() {
	const { data, error, loading, reload } = useApi<{ trips: Trip[] }>('/trips');
	const [showNew, setShowNew] = useState(false);

	return (
		<>
			<section className="container flex items-end justify-between pt-12 pb-6">
				<div>
					<h1 className="text-title">{c.heading}</h1>
				</div>
				<button type="button" className="btn primary" onClick={() => setShowNew(true)}>
					<PlusIcon />
					{copy.common.add}
				</button>
			</section>

			<section className="container grid grid-cols-1 gap-5 md:grid-cols-2">
				{/* The reason goes to the corner. The panel only appears when the grid
				    is empty, so a failed reload does not push the trips down. */}
				{error && <LoadError message={error} panel={!data} className="col-span-full" />}

				{data?.trips.map((t) => (
					<TripCard key={t.id} trip={t} />
				))}

				{/* Only after a successful load, so an empty grid mid-fetch does not
				    briefly claim the user has no trips. In a card, like every other
				    empty state: the drawing is filled with the card colour, so on the
				    bare page background its body and wings showed as white cut-outs. */}
				{!loading && !error && data?.trips.length === 0 && (
					<div className="card col-span-full">
						<EmptyState graphic message={copy.common.nothingAdded} />
					</div>
				)}
			</section>

			{/* Mounted only while open, so each visit to the dialog starts from a
			    blank form rather than from whatever the last attempt left behind. */}
			{showNew && <NewTrip onClose={() => setShowNew(false)} onCreated={reload} />}
		</>
	);
}

function TripCard({ trip }: { trip: Trip }) {
	const first = trip.cities[0] ?? null;
	return (
		<Link
			to={`/trips/${trip.id}`}
			className="card overflow-hidden transition-[box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:shadow-card"
		>
			{/* The trip's own gradient stays the fallback, so a trip with no cities
			    yet, or one whose first city has no picture, looks the same as it
			    always did rather than blank. */}
			<Cover
				photo={first?.photo ?? null}
				seed={trip.name}
				height="150px"
				background={first?.photo ? undefined : trip.cover}
			>
				<span className="chip absolute top-4 left-4 border-none bg-white/85">
					{c.cityCount(trip.cities.length)}
				</span>
			</Cover>
			<div className="px-6 pt-5 pb-6">
				<h2 className="text-section">{trip.name}</h2>
				{/* The card carries how many cities, not which ones. The names were
				    joined with a chevron, which read as an itinerary, but cities are
				    stored as an unordered pool and the arrows implied a route nobody
				    had chosen. */}
				<p className="muted mt-1 mb-4 text-body">{trip.dates}</p>
				<span className="flex flex-wrap items-center gap-2.5">
					<span className="chip accent capitalize">{trip.role}</span>
					<span className="muted text-meta">{c.memberCount(trip.memberCount)}</span>
				</span>
			</div>
		</Link>
	);
}

/**
 * Create. The form itself is `TripFormDialog`, shared with the edit dialog in
 * `TripShell`; what is local to creating is the endpoint, the `homeCurrency`
 * spelling it takes, and going to the new trip afterwards.
 */
function NewTrip({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
	const navigate = useNavigate();
	return (
		<TripFormDialog
			title={c.newDialog.title}
			submitLabel={copy.common.add}
			busyLabel={copy.common.adding}
			fallback={c.newDialog.fallback}
			onClose={onClose}
			onSubmit={async (v) => {
				// No `dates`: the label on the card is derived by the server from the
				// two endpoints on every write, so sending one would be inventing a
				// second source of truth that could then disagree with them.
				const { trip } = await api<{ trip: { id: string } }>('/trips', {
					method: 'POST',
					body: {
						name: v.name,
						startDate: v.startDate,
						endDate: v.endDate,
						homeCurrency: v.currency
					}
				});
				onCreated();
				navigate(`/trips/${trip.id}`);
			}}
		/>
	);
}
