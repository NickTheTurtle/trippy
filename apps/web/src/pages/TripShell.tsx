import { useState } from 'react';
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router';
import { api, ApiError } from '../api';
import { useApi } from '../useApi';
import { TABS } from '../nav';
import Modal from '../components/Modal';

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

type Ctx = { trip: Trip; reloadTrip: () => void };

/** Lets a section page read the trip the shell already loaded, rather than refetch it. */
export function useTrip(): Ctx {
	return useOutletContext<Ctx>();
}

export default function TripShell() {
	const { tripId } = useParams();
	const { data, error, loading, reload } = useApi<{ trip: Trip }>(`/trips/${tripId}`);
	const [showEdit, setShowEdit] = useState(false);

	if (loading && !data) return null;

	if (error || !data) {
		return (
			<main className="container py-8">
				<p>
					Trip not found. <Link to="/trips" className="text-accent-ink underline">Back to trips</Link>
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

			{showEdit && (
				<EditTrip trip={trip} onClose={() => setShowEdit(false)} onSaved={reload} />
			)}

			<main className="container py-8">
				<Outlet context={{ trip, reloadTrip: reload } satisfies Ctx} />
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
	'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF',
	'CNY', 'INR', 'MXN', 'SEK', 'NZD', 'SGD', 'ZAR', 'BRL'
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
					<L label="Trip name">
						<input
							// The dialog opens with nothing focused otherwise, so Escape
							// works but typing does not go anywhere useful.
							autoFocus
							required
							value={name}
							onChange={(e) => setName(e.target.value)}
							className={INPUT}
						/>
					</L>
					<div className="flex flex-wrap gap-2.5">
						<div className="min-w-0 flex-[1_1_130px]">
							<L label="Start">
								<input
									type="date"
									value={startDate}
									onChange={(e) => setStartDate(e.target.value)}
									className={INPUT}
								/>
							</L>
						</div>
						<div className="min-w-0 flex-[1_1_130px]">
							<L label="End">
								<input
									type="date"
									value={endDate}
									onChange={(e) => setEndDate(e.target.value)}
									className={INPUT}
								/>
							</L>
						</div>
						<div className="min-w-0 flex-[0_1_130px]">
							<L label="Currency">
								<select
									aria-label="Home currency"
									value={currency}
									onChange={(e) => setCurrency(e.target.value)}
									className={INPUT}
								>
									{CURRENCIES.map((c) => (
										<option key={c} value={c}>
											{c}
										</option>
									))}
								</select>
							</L>
						</div>
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

const INPUT =
	'w-full min-w-0 rounded border border-line bg-surface px-2.5 py-2 text-ink outline-none focus:border-accent';

function L({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<label className="flex min-w-0 flex-col gap-1 text-[0.8rem] text-ink-soft">
			<span>{label}</span>
			{children}
		</label>
	);
}
