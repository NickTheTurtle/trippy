import { useState } from 'react';
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router';
import { api, ApiError } from '../api';
import { useApi } from '../useApi';
import { TABS } from '../nav';
import Modal from '../components/Modal';
import Select from '../components/Select';
import Itinerary from '../components/Itinerary';
import { Field, FieldShell } from '../components/Field';

export type TripCity = {
	id: string;
	name: string;
	country: string;
	tz: string;
	arrive: string;
	depart: string;
	lat: number | null;
	lng: number | null;
};

export type Trip = {
	id: string;
	name: string;
	dates: string;
	cover: string;
	home_currency: string;
	start_date: string | null;
	end_date: string | null;
	role: string;
	cities: TripCity[];
	members: string[];
	memberList: { id: string; name: string }[];
};

type Ctx = { trip: Trip; reloadTrip: () => void; editItinerary: () => void };

/** Lets a section page read the trip the shell already loaded, rather than refetch it. */
export function useTrip(): Ctx {
	return useOutletContext<Ctx>();
}

export default function TripShell() {
	const { tripId } = useParams();
	const { data, error, loading, reload } = useApi<{ trip: Trip }>(`/trips/${tripId}`);
	const [showEdit, setShowEdit] = useState(false);
	const [showItinerary, setShowItinerary] = useState(false);

	if (loading && !data) return null;

	if (error || !data) {
		return (
			<main className="container py-8">
				<p>
					Trip not found.{' '}
					<Link to="/trips" className="text-accent-ink underline">
						Back to trips
					</Link>
				</p>
			</main>
		);
	}

	const trip = data.trip;
	const base = `/trips/${trip.id}`;
	const extra = trip.members.length - 8;

	return (
		<>
			<div className="border-b border-line bg-surface">
				<div className="container">
					<Link
						to="/trips"
						className="inline-block pt-5 pb-2.5 text-[0.88rem] text-ink-faint hover:text-accent"
					>
						← All trips
					</Link>

					<div className="flex items-start justify-between gap-4">
						<div className="min-w-0">
							<h1 className="text-[1.9rem] [overflow-wrap:anywhere]">{trip.name}</h1>
							<p className="muted">{trip.dates}</p>
						</div>

						<div className="flex shrink-0 items-center">
							{trip.members.slice(0, 8).map((m, i) => (
								<Avatar key={`${m}-${i}`} title={m} label={m[0]} />
							))}
							{extra > 0 && (
								<Avatar title={trip.members.slice(8).join(', ')} label={`+${extra}`} rest />
							)}
							{trip.role === 'organizer' && (
								<button
									type="button"
									className="btn ml-3 px-3 py-1.5 text-[0.85rem]"
									onClick={() => setShowEdit(true)}
								>
									Edit trip
								</button>
							)}
						</div>
					</div>

					<div className="mt-5 mb-1.5 flex flex-wrap items-center gap-1.5">
						{trip.cities.map((c, i) => (
							<div key={c.id} className="inline-flex items-center gap-1.5">
								<span className="size-2 rounded-full bg-accent" />
								<span className="font-medium">{c.name}</span>
								{i < trip.cities.length - 1 && <span className="mx-1 h-px w-7 bg-line" />}
							</div>
						))}
						{/* The itinerary opens from the chain it edits. A trip starts with
						    no cities and every section is scoped to one, so on a new trip
						    this is the only thing on the page worth pressing. */}
						{trip.role === 'organizer' &&
							(trip.cities.length === 0 ? (
								<button
									type="button"
									className="btn small primary"
									onClick={() => setShowItinerary(true)}
								>
									Add a city
								</button>
							) : (
								<button type="button" className="link ml-2" onClick={() => setShowItinerary(true)}>
									Edit itinerary
								</button>
							))}
					</div>

					<nav className="mt-5 flex gap-1 overflow-x-auto">
						{TABS.map((t) => (
							<NavLink
								key={t.slug}
								to={`${base}/${t.slug}`}
								className={({ isActive }) =>
									[
										'border-b-2 px-3.5 py-2.5 text-[0.92rem] font-medium whitespace-nowrap',
										isActive
											? 'border-accent text-accent-ink'
											: 'border-transparent text-ink-soft hover:text-ink'
									].join(' ')
								}
							>
								{t.label}
							</NavLink>
						))}
					</nav>
				</div>
			</div>

			{showEdit && <EditTrip trip={trip} onClose={() => setShowEdit(false)} onSaved={reload} />}
			{showItinerary && (
				<Itinerary trip={trip} onClose={() => setShowItinerary(false)} onChanged={reload} />
			)}

			<main className="container py-8">
				<Outlet
					context={
						{
							trip,
							reloadTrip: reload,
							editItinerary: () => setShowItinerary(true)
						} satisfies Ctx
					}
				/>
			</main>
		</>
	);
}

function Avatar({ title, label, rest }: { title: string; label: string; rest?: boolean }) {
	return (
		<span
			title={title}
			className={[
				'-ml-1.5 grid size-[30px] shrink-0 place-items-center rounded-full border-2 border-surface font-semibold',
				rest
					? 'cursor-help bg-surface-2 text-[0.72rem] text-ink-soft'
					: 'bg-accent-soft text-[0.82rem] text-accent-ink'
			].join(' ')}
		>
			{label}
		</span>
	);
}

const CURRENCIES = [
	'USD',
	'EUR',
	'GBP',
	'JPY',
	'CAD',
	'AUD',
	'CHF',
	'CNY',
	'INR',
	'MXN',
	'SEK',
	'NZD',
	'SGD',
	'ZAR',
	'BRL'
];

function EditTrip({
	trip,
	onClose,
	onSaved
}: {
	trip: Trip;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [name, setName] = useState(trip.name);
	const [startDate, setStartDate] = useState(trip.start_date ?? '');
	const [endDate, setEndDate] = useState(trip.end_date ?? '');
	const [currency, setCurrency] = useState(trip.home_currency);
	const [error, setError] = useState('');
	const [saving, setSaving] = useState(false);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setSaving(true);
		setError('');
		try {
			await api(`/trips/${trip.id}`, {
				method: 'PATCH',
				body: { name, startDate, endDate, currency }
			});
			onSaved();
			onClose();
		} catch (err) {
			setError(err instanceof ApiError ? err.message : 'Could not save.');
			setSaving(false);
		}
	}

	return (
		<Modal open title="Edit trip" size="sm" onClose={onClose}>
			<form className="mform" onSubmit={submit}>
				<div className="mbody flex flex-col gap-3">
					{error && (
						<p role="alert" className="m-0 text-[0.88rem] text-warn">
							{error}
						</p>
					)}
					<Field
						label="Trip name"
						// The dialog opens with nothing focused otherwise, so Escape
						// works but typing does not go anywhere useful.
						autoFocus
						required
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
					<div className="flex flex-wrap gap-2.5">
						<Field
							label="Start"
							className="flex-[1_1_130px]"
							type="date"
							value={startDate}
							onChange={(e) => setStartDate(e.target.value)}
						/>
						<Field
							label="End"
							className="flex-[1_1_130px]"
							type="date"
							value={endDate}
							onChange={(e) => setEndDate(e.target.value)}
						/>
						<FieldShell label="Currency" className="flex-[0_1_130px]">
							<Select
								ariaLabel="Home currency"
								value={currency}
								onChange={setCurrency}
								options={CURRENCIES.map((c) => ({ value: c, label: c }))}
							/>
						</FieldShell>
					</div>
					<p className="muted m-0 text-[0.78rem] leading-relaxed">
						The header label is generated from these dates. Currency is what totals and estimates
						are shown in.
					</p>
				</div>
				<div className="mfoot">
					<button className="btn" type="button" onClick={onClose}>
						Cancel
					</button>
					<button className="btn primary" type="submit" disabled={saving}>
						{saving ? 'Saving...' : 'Save changes'}
					</button>
				</div>
			</form>
		</Modal>
	);
}
