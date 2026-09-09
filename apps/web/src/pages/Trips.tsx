import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../api';
import { useApi } from '../useApi';
import { Field } from '../components/Field';

type City = { id: string; name: string };
type Trip = {
	id: string;
	name: string;
	dates: string;
	cover: string;
	role: string;
	cities: City[];
};

export default function Trips() {
	const { data, error, loading, reload } = useApi<{ trips: Trip[] }>('/trips');
	const [showNew, setShowNew] = useState(false);

	return (
		<>
			<section className="container flex items-end justify-between pt-12 pb-6">
				<div>
					<h1 className="text-[2rem]">My trips</h1>
					<p className="muted">Trips you organize or belong to.</p>
				</div>
				<button className="btn primary" onClick={() => setShowNew((v) => !v)}>
					New trip
				</button>
			</section>

			{showNew && (
				<section className="container">
					<NewTrip onCancel={() => setShowNew(false)} onCreated={reload} />
				</section>
			)}

			<section className="container grid grid-cols-1 gap-5 md:grid-cols-2">
				{error && <p className="col-span-full text-warn">{error}</p>}

				{data?.trips.map((t) => (
					<TripCard key={t.id} trip={t} />
				))}

				{/* Only after a successful load, so an empty grid mid-fetch does not
				    briefly claim the user has no trips. */}
				{!loading && !error && data?.trips.length === 0 && (
					<p className="muted col-span-full py-8">
						No trips yet. Create your first one to get started.
					</p>
				)}
			</section>
		</>
	);
}

function TripCard({ trip }: { trip: Trip }) {
	return (
		<Link
			to={`/trips/${trip.id}`}
			className="card overflow-hidden transition-[box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:shadow-card"
		>
			<div className="flex h-[150px] items-start p-4" style={{ background: trip.cover }}>
				<span className="chip border-none bg-white/85">
					{trip.cities.length} {trip.cities.length === 1 ? 'city' : 'cities'}
				</span>
			</div>
			<div className="px-6 pt-5 pb-6">
				<h3 className="text-[1.15rem]">{trip.name}</h3>
				<p className="muted mt-1 mb-3 text-[0.9rem]">{trip.dates}</p>
				<p className="mb-4 text-[0.95rem] text-ink-soft">
					{trip.cities.length ? trip.cities.map((c) => c.name).join('  ›  ') : 'No cities yet'}
				</p>
				<span className="chip accent capitalize">{trip.role}</span>
			</div>
		</Link>
	);
}

function NewTrip({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
	const navigate = useNavigate();
	const [name, setName] = useState('');
	const [dates, setDates] = useState('');
	const [currency, setCurrency] = useState('USD');
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (!name.trim()) {
			setError('Give your trip a name.');
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const { trip } = await api<{ trip: { id: string } }>('/trips', {
				method: 'POST',
				body: {
					name,
					dates: dates.trim() || 'Dates to be set',
					homeCurrency: currency
				}
			});
			onCreated();
			navigate(`/trips/${trip.id}`);
		} catch (err) {
			setError(err instanceof ApiError ? err.message : 'Could not create the trip.');
			setSaving(false);
		}
	}

	return (
		<form className="card mb-6 p-6" onSubmit={submit}>
			{error && (
				<p role="alert" className="mb-3 text-[0.85rem] text-warn">
					{error}
				</p>
			)}
			<div className="grid grid-cols-1 gap-3.5 sm:grid-cols-[2fr_1.5fr_1fr]">
				<Field label="Trip name" value={name} onChange={(e) => setName(e.target.value)} />
				{/* The field takes free text, so the accepted shape has to stay
				    readable while you type it, which a placeholder does not. */}
				<Field
					label="Dates"
					value={dates}
					onChange={(e) => setDates(e.target.value)}
					hint="e.g. Jul 3 – Jul 15, 2027"
				/>
				<Field label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} />
			</div>
			<div className="mt-4 flex justify-end gap-2.5">
				<button className="btn" type="button" onClick={onCancel}>
					Cancel
				</button>
				<button className="btn primary" type="submit" disabled={saving}>
					{saving ? 'Creating...' : 'Create trip'}
				</button>
			</div>
		</form>
	);
}
