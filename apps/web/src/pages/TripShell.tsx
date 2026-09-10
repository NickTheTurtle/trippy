import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useTripEvents, TripEventsProvider } from '../hooks/useTripEvents';
import { TABS } from '../nav';
import AddCityDialog from '../components/AddCityDialog';
import TripFormDialog from '../components/TripFormDialog';
import LiveOff from '../components/LiveOff';
import { copy } from '../copy';

const c = copy.tripShell;

export type TripCity = {
	id: string;
	name: string;
	country: string;
	/**
	 * State / province, as `cities.region`. Null when the geocoder had none
	 * (Singapore, Monaco) or the row predates the column, so every reader has to
	 * cope with its absence rather than print an empty separator.
	 */
	region: string | null;
	tz: string;
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
};

type Ctx = {
	trip: Trip;
	reloadTrip: () => void;
	/**
	 * Opens the add-city dialog. The header does not offer this: cities are the
	 * axis of Discover, so that is the page it is reached from. The dialog still
	 * lives here because it changes the trip the shell owns and reloading it is
	 * the shell's call, but Discover is the only way in.
	 *
	 * The optional callback fires after each successful add, for a section
	 * holding its own copy of the cities that has to refetch alongside the trip.
	 */
	addCity: (onChanged?: () => void) => void;
};

/** Lets a section page read the trip the shell already loaded, rather than refetch it. */
export function useTrip(): Ctx {
	return useOutletContext<Ctx>();
}

export default function TripShell() {
	const { tripId } = useParams();
	const { data, error, reload } = useApi<{ trip: Trip }>(`/trips/${tripId}`);
	const [showEdit, setShowEdit] = useState(false);
	const [showAddCity, setShowAddCity] = useState(false);
	/** Set by whoever opened the add-city dialog; see `Ctx.addCity`. */
	const onCityAdded = useRef<(() => void) | undefined>(undefined);

	// One live stream per open trip, owned here rather than by each section, so
	// moving between the tabs of a trip does not churn connections and switching
	// trips closes the old one before opening the new one.
	const events = useTripEvents(tripId ?? null);
	// The header carries the name, the dates, the member avatars and the city
	// strip, so it follows all three of those topics.
	useEffect(() => events.subscribe(['trip', 'members', 'schedule'], reload), [events, reload]);

	// `useApi` deliberately keeps the previous response while the next one is in
	// flight, which is what stops a reload blanking the page. Switching trips
	// goes through the same state, though, so the loaded trip has to be checked
	// against the one in the URL: without this the header, the tabs and every
	// section below render the trip you just left for as long as the fetch takes.
	const trip = data && data.trip.id === tripId ? data.trip : null;

	if (!trip) {
		if (!error) return null;
		return (
			<main className="container py-8">
				<p>
					{c.notFound}{' '}
					<Link to="/trips" className="text-accent-ink underline">
						{c.notFoundLink}
					</Link>
				</p>
			</main>
		);
	}

	const base = `/trips/${trip.id}`;
	const extra = trip.members.length - 8;

	return (
		<TripEventsProvider value={events}>
			<div className="border-b border-line bg-surface">
				<div className="container">
					<Link
						to="/trips"
						className="inline-block pt-5 pb-2.5 text-[0.88rem] text-ink-faint hover:text-accent"
					>
						{c.backToTrips}
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
								<button type="button" className="btn small ml-3" onClick={() => setShowEdit(true)}>
									{c.editTrip}
								</button>
							)}
						</div>
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
			{showAddCity && (
				<AddCityDialog
					trip={trip}
					onClose={() => {
						setShowAddCity(false);
						onCityAdded.current = undefined;
					}}
					onChanged={() => {
						reload();
						// The section that opened the dialog usually has its own copy of
						// the cities. It is subscribed to the live `trip` event too, but
						// this must not be the only thing that refreshes it: the stream
						// drops, and an added city that appears in no list until a manual
						// reload reads as a failed add.
						onCityAdded.current?.();
					}}
				/>
			)}

			<main className="container py-8">
				<LiveOff />
				<Outlet
					context={
						{
							trip,
							reloadTrip: reload,
							addCity: (onChanged) => {
								onCityAdded.current = onChanged;
								setShowAddCity(true);
							}
						} satisfies Ctx
					}
				/>
			</main>
		</TripEventsProvider>
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

/**
 * Edit. Same form as creating one, with the trip's own values in it; what is
 * local here is the PATCH, the `currency` spelling that endpoint takes, and
 * closing rather than navigating.
 */
function EditTrip({
	trip,
	onClose,
	onSaved
}: {
	trip: Trip;
	onClose: () => void;
	onSaved: () => void;
}) {
	return (
		<TripFormDialog
			title={c.editDialog.title}
			submitLabel={c.editDialog.submitLabel}
			busyLabel={copy.common.saving}
			fallback={c.editDialog.fallback}
			initial={{
				name: trip.name,
				startDate: trip.start_date ?? '',
				endDate: trip.end_date ?? '',
				currency: trip.home_currency
			}}
			onClose={onClose}
			onSubmit={async (v) => {
				await api(`/trips/${trip.id}`, {
					method: 'PATCH',
					body: { name: v.name, startDate: v.startDate, endDate: v.endDate, currency: v.currency }
				});
				onSaved();
				onClose();
			}}
		/>
	);
}
