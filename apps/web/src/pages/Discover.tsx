import { useState } from 'react';
import { api } from '../api';
import { useApi } from '../useApi';
import { useLiveSection } from '../useTripEvents';
import { useMutation } from '../useMutation';
import { useTrip } from './TripShell';
import Select from '../components/Select';
import EmptyState from '../components/EmptyState';
import FormError from '../components/FormError';
import ConfirmDialog from '../components/ConfirmDialog';
import type { DiscoverData, Poi } from '../api-types';
import CityList, { type CityRow } from './discover/CityList';
import PlaceCard from './discover/PlaceCard';
import StayCard from './discover/StayCard';
import AddDialog from './discover/AddDialog';
import EditPlaceDialog from './discover/EditPlaceDialog';
import NoCities from './discover/NoCities';
import { PlusIcon } from './discover/card-controls';
import { VIEW_LABEL, VIEW_OPTIONS, isStayView, type DiscoverView } from './discover/views';

/**
 * Discover: the pool of places and stays a group is choosing between.
 *
 * The page has two axes. Which city you are looking at is the standing choice,
 * so it is the sidebar; what kind of thing you are looking at changes far more
 * often, so it is one dropdown in the header. Attractions and Food & Drink
 * filter the same list by `pois.kind`; Stays swaps the list for
 * `lodging_options`, which is why there is no "All" (see docs/DESIGN.md 2.3).
 *
 * This file is composition only. The search-and-add popup, the two card types
 * and the city sidebar each live in `pages/discover/`.
 */
export default function Discover() {
	const { trip, editItinerary, reloadTrip } = useTrip();
	const base = `/trips/${trip.id}/discover`;
	const { data, error, reload } = useApi<DiscoverData>(base);
	// Places, stays and their votes, plus the cities the sidebar lists.
	useLiveSection(['pois', 'lodging', 'schedule', 'members', 'trip'], reload);

	const [activeCity, setActiveCity] = useState('');
	const [view, setView] = useState<DiscoverView>('attraction');
	const [adding, setAdding] = useState(false);
	const [editPoi, setEditPoi] = useState<Poi | null>(null);
	const [deletePoi, setDeletePoi] = useState<Poi | null>(null);
	const [datesFor, setDatesFor] = useState<string | null>(null);

	// One state machine per write, each reporting the server's own refusal. The
	// API answers 400 / 403 / 404 for a write it declines where it used to
	// answer `{ok:true}`, so a member pressing an organizer-only control now
	// gets told rather than shown a change that never happened.
	const votePlace = useMutation<[string]>(
		(id) => api(`${base}/pois/${id}/vote`, { method: 'POST' }),
		{ fallback: 'Could not vote on that place.', onSuccess: reload }
	);
	const voteStay = useMutation<[string]>(
		(id) => api(`${base}/stays/${id}/vote`, { method: 'POST' }),
		{
			fallback: 'Could not vote on that stay.',
			onSuccess: reload
		}
	);
	const lockStay = useMutation<[string]>(
		(id) => api(`${base}/stays/${id}/lock`, { method: 'POST' }),
		{
			fallback: 'Could not lock that stay.',
			onSuccess: reload
		}
	);
	const removeStay = useMutation<[string]>(
		(id) => api(`${base}/stays/${id}`, { method: 'DELETE' }),
		{
			fallback: 'Could not remove that stay.',
			onSuccess: reload
		}
	);
	const saveStayDates = useMutation<[string, string | null, string | null]>(
		(id, checkIn, checkOut) =>
			api(`${base}/stays/${id}/dates`, { method: 'PATCH', body: { checkIn, checkOut } }),
		{
			fallback: 'Could not save those dates.',
			onSuccess: () => {
				setDatesFor(null);
				reload();
			}
		}
	);

	const notice =
		votePlace.error || voteStay.error || lockStay.error || removeStay.error || saveStayDates.error;

	if (!data) return error ? <p className="text-warn">{error}</p> : null;

	if (data.cities.length === 0) {
		// A whole blank page, so it gets a panel rather than the in-card
		// `EmptyState` line, which was written to sit inside a box and read as a
		// stray sentence when it was the only thing here.
		return <NoCities isOrganizer={trip.role === 'organizer'} onAddCity={editItinerary} />;
	}

	const stay = isStayView(view);

	// Alphabetical, so the list is a lookup rather than a second rendering of
	// the itinerary order the trip header already shows.
	const cities = [...data.cities].sort((a, b) => a.name.localeCompare(b.name));
	const current = cities.find((c) => c.id === activeCity) ?? cities[0];
	if (!current) return null;

	const staysIn = (cityId: string) => data.stays[cityId] ?? [];
	const stays = staysIn(current.id);
	const places = current.pois.filter((p) => p.kind === view);

	/** `cities.tz` is where the IANA zone lives; Discover joins the trip on it. */
	const tzOf = (cityId: string) => trip.cities.find((c) => c.id === cityId)?.tz ?? '';

	// Same join for the region, which the Discover payload does not carry: the
	// trip already has it on every stop. It reaches the sidebar only when two
	// stops share a name, since that is the only time the name alone fails to
	// identify one, and a state on every row is width this column has not got.
	// Cities saved before the column existed have null and stay bare.
	const ambiguous = new Set(
		cities.filter((c, i) => cities.some((o, j) => i !== j && o.name === c.name)).map((c) => c.id)
	);
	const regionOf = (cityId: string) =>
		ambiguous.has(cityId) ? (trip.cities.find((c) => c.id === cityId)?.region ?? null) : null;

	const rows: CityRow[] = cities.map((c) => ({
		id: c.id,
		name: c.name,
		region: regionOf(c.id),
		// The badge counts what the current view would show, so it never reads as
		// a places count while you are comparing stays.
		badge: stay ? staysIn(c.id).length : c.pois.filter((p) => p.kind === view).length,
		places: c.pois.length,
		stays: staysIn(c.id).length,
		linked: c.pois.reduce((n, p) => n + p.linked, 0)
	}));

	/** Share of the group behind an option, for the bar along the card's edge. */
	const pct = (votes: number) =>
		data.memberCount ? Math.round((votes / data.memberCount) * 100) : 0;

	return (
		<div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[190px_minmax(0,1fr)]">
			<CityList
				trip={trip}
				cities={rows}
				value={current.id}
				onChange={setActiveCity}
				isOrganizer={data.isOrganizer}
				onChanged={() => {
					// The itinerary lives on the trip and the pools live here, so both
					// have to come back after a city is added or deleted.
					reloadTrip();
					reload();
				}}
			/>

			<div className="min-w-0">
				<FormError message={notice} variant="banner" />

				<div className="mb-2.5 flex min-h-phead flex-wrap items-center gap-4">
					<div className="min-w-0 flex-[0_1_auto]">
						<Select
							options={VIEW_OPTIONS}
							value={view}
							onChange={(v) => setView(v as DiscoverView)}
							ariaLabel="Type"
						/>
					</div>

					{/* Lives in the header row rather than on a line below it, so
					    switching view never changes the height above the cards. */}
					{stay && (
						<span className="muted text-[0.85rem] whitespace-nowrap">
							{data.staysVoted[current.id] ?? 0} of {data.memberCount} voted
						</span>
					)}

					<button type="button" className="btn primary ml-auto" onClick={() => setAdding(true)}>
						<PlusIcon />
						{stay ? 'Add a stay' : 'Add a place'}
					</button>
				</div>

				<div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
					{stay ? (
						<>
							{stays.map((o) => (
								<StayCard
									key={o.id}
									stay={o}
									currency={data.currency}
									pct={pct(o.votes)}
									isOrganizer={data.isOrganizer}
									editingDates={datesFor === o.id}
									onToggleDates={() => setDatesFor((v) => (v === o.id ? null : o.id))}
									onVote={() => void voteStay.run(o.id)}
									onLock={() => void lockStay.run(o.id)}
									onRemove={() => void removeStay.run(o.id)}
									onSaveDates={(checkIn, checkOut) =>
										void saveStayDates.run(o.id, checkIn, checkOut)
									}
								/>
							))}
							{stays.length === 0 && (
								<EmptyState
									className="col-span-full"
									message={`No stays proposed for ${current.name} yet.`}
									hint="Add one and let the group vote on it."
									action={
										<button type="button" className="btn" onClick={() => setAdding(true)}>
											Add a stay
										</button>
									}
								/>
							)}
						</>
					) : (
						<>
							{places.map((p) => (
								<PlaceCard
									key={p.id}
									poi={p}
									tz={tzOf(current.id)}
									pct={pct(p.votes)}
									onEdit={() => setEditPoi(p)}
									onVote={() => void votePlace.run(p.id)}
									onRemove={() => setDeletePoi(p)}
								/>
							))}
							{places.length === 0 && (
								<EmptyState
									className="col-span-full"
									message={`Nothing under ${VIEW_LABEL[view]} in ${current.name} yet.`}
									hint="Add one to get started, or switch the type above."
									action={
										<button type="button" className="btn" onClick={() => setAdding(true)}>
											Add a place
										</button>
									}
								/>
							)}
						</>
					)}
				</div>
			</div>

			{adding && (
				<AddDialog
					base={base}
					city={{ id: current.id, name: current.name }}
					tz={tzOf(current.id)}
					currency={data.currency}
					provider={data.provider}
					initialView={view}
					onClose={() => setAdding(false)}
					onAdded={(added) => {
						// Show the list the new thing landed in: adding a restaurant while
						// Attractions is showing would otherwise look like it did nothing.
						setView(added);
						reload();
					}}
				/>
			)}

			{editPoi && (
				<EditPlaceDialog
					base={base}
					poi={editPoi}
					onClose={() => setEditPoi(null)}
					onSaved={() => {
						setEditPoi(null);
						reload();
					}}
				/>
			)}

			<ConfirmDialog
				open={!!deletePoi}
				title="Delete this place?"
				confirmLabel={
					deletePoi && deletePoi.linked > 0
						? `Delete and ${deletePoi.linked} event${deletePoi.linked === 1 ? '' : 's'}`
						: 'Delete'
				}
				busyLabel="Deleting..."
				body={
					deletePoi && (
						<>
							<p className="m-0 mb-2 font-semibold [overflow-wrap:anywhere]">{deletePoi.name}</p>
							{deletePoi.linked > 0 ? (
								<p className="m-0 text-[0.9rem] text-warn">
									{deletePoi.linked} scheduled {deletePoi.linked === 1 ? 'event' : 'events'} on the
									calendar {deletePoi.linked === 1 ? 'is' : 'are'} linked to this place and will be
									deleted too.
								</p>
							) : (
								<p className="muted m-0 text-[0.9rem]">Nothing on the calendar is linked to it.</p>
							)}
						</>
					)
				}
				onCancel={() => setDeletePoi(null)}
				onConfirm={async () => {
					if (!deletePoi) return;
					await api(`${base}/pois/${deletePoi.id}`, { method: 'DELETE' });
					setDeletePoi(null);
					reload();
				}}
			/>
		</div>
	);
}
