import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useOutletContext, useParams } from 'react-router';
import { api } from '../api';
import { useApi } from '../useApi';
import { useTripEvents, TripEventsProvider } from '../useTripEvents';
import { TABS } from '../nav';
import Itinerary from '../components/Itinerary';
import TripFormDialog from '../components/TripFormDialog';
import { LinkButton } from '../components/buttons';
import LiveOff from '../components/LiveOff';

export type TripCity = {
	id: string;
	name: string;
	country: string;
	/**
	 * State / province, as `cities.region`. Null when the geocoder had none
	 * (Singapore, Monaco) or the row predates the column, so every reader has to
	 * cope with its absence rather than print an empty separator.
	 *
	 * Declared here and not only where it is rendered because the itinerary
	 * editor's date save is a PATCH of the whole row (`{ ...city, ...next }`).
	 * A field missing from this type is missing from that body, and the city
	 * route writes `region = ?` unconditionally, so leaving it out would quietly
	 * null the region of any city whose dates were edited.
	 */
	region: string | null;
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
};

type Ctx = { trip: Trip; reloadTrip: () => void; editItinerary: () => void };

/** Lets a section page read the trip the shell already loaded, rather than refetch it. */
export function useTrip(): Ctx {
	return useOutletContext<Ctx>();
}

export default function TripShell() {
	const { tripId } = useParams();
	const { pathname } = useLocation();
	const { data, error, reload } = useApi<{ trip: Trip }>(`/trips/${tripId}`);
	const [showEdit, setShowEdit] = useState(false);
	const [showItinerary, setShowItinerary] = useState(false);

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
					Trip not found.{' '}
					<Link to="/trips" className="text-accent-ink underline">
						Back to trips
					</Link>
				</p>
			</main>
		);
	}

	const base = `/trips/${trip.id}`;
	const extra = trip.members.length - 8;
	// Discover carries its own "Add a city" in its empty state; see below.
	const onDiscover = pathname === base || pathname.startsWith(`${base}/discover`);

	return (
		<TripEventsProvider value={events}>
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
								<button type="button" className="btn small ml-3" onClick={() => setShowEdit(true)}>
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
						    this is the only thing on the page worth pressing.

						    Except on Discover, which renders its own empty state with the
						    same "Add a city" button in it. Two primary buttons for one
						    intent, three feet apart, is one too many, and the empty state
						    is the better of the two: it sits where the missing content
						    would be and says why the page is blank. So this one stands
						    down while that one is on screen. Every other tab keeps it,
						    because Discover's empty state is the *only* other way in and
						    a cityless Calendar would otherwise be a dead end. */}
						{trip.role === 'organizer' &&
							(trip.cities.length === 0 ? (
								onDiscover ? null : (
									<button
										type="button"
										className="btn small primary"
										onClick={() => setShowItinerary(true)}
									>
										Add a city
									</button>
								)
							) : (
								<LinkButton className="ml-2" onClick={() => setShowItinerary(true)}>
									Edit itinerary
								</LinkButton>
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
				<LiveOff />
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
			title="Edit trip"
			submitLabel="Save changes"
			busyLabel="Saving..."
			note="The header label is generated from these dates. Currency is what totals and estimates are shown in."
			fallback="Could not save."
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
