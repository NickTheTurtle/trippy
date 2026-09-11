import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useLiveSection } from '../hooks/useTripEvents';
import { useMutation } from '../hooks/useMutation';
import FlipGrid from '../components/ui/FlipGrid';
import { useTrip } from './TripShell';
import Select from '../components/ui/Select';
import FormError from '../components/ui/FormError';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import EmptyState from '../components/ui/EmptyState';
import type { DiscoverData, Poi, Stay } from '../lib/api-types';
import CityList, { type CityRow } from './discover/CityList';
import PlaceCard from './discover/PlaceCard';
import StayCard from './discover/StayCard';
import AddDialog from './discover/AddDialog';
import EditPlaceDialog from './discover/EditPlaceDialog';
import EditStayDialog from './discover/EditStayDialog';
import NoCities from './discover/NoCities';
import { PlusIcon } from '../components/ui/icons';
import { VIEW_OPTIONS, showsStays, placeKinds, toAddType, ALL_VIEW } from './discover/views';
import type { DiscoverView } from './discover/views';
import { copy } from '../copy';

const cd = copy.discover;

/**
 * Discover: the pool of places and stays a group is choosing between.
 *
 * The page has two axes. Which city you are looking at is the standing choice,
 * so it is the sidebar; what kind of thing you are looking at changes far more
 * often, so it is one dropdown in the header, and it opens on All. Attractions
 * and Food & Drink filter `pois.kind`, Stays reads `lodging_options`, and All
 * shows the lot in one grid: the two tables are a storage detail, and a group
 * weighing up a city wants to see what is in it (see docs/DESIGN.md 2.3).
 *
 * This file is composition only. The search-and-add popup, the two card types
 * and the city sidebar each live in `pages/discover/`.
 */
export default function Discover() {
	const { trip, addCity, reloadTrip } = useTrip();
	const base = `/trips/${trip.id}/discover`;
	const { data, error, reload } = useApi<DiscoverData>(base);
	// Places, stays and their votes, plus the cities the sidebar lists.
	useLiveSection(['pois', 'lodging', 'schedule', 'members', 'trip'], reload);

	const [activeCity, setActiveCity] = useState('');
	const [view, setView] = useState<DiscoverView>(ALL_VIEW);
	const [adding, setAdding] = useState(false);
	const [editPoi, setEditPoi] = useState<Poi | null>(null);
	const [editStay, setEditStay] = useState<Stay | null>(null);
	const [deletePoi, setDeletePoi] = useState<Poi | null>(null);
	const [deleteStay, setDeleteStay] = useState<Stay | null>(null);

	// One state machine per write, each reporting the server's own refusal. The
	// API answers 400 / 403 / 404 for a write it declines where it used to
	// answer `{ok:true}`, so a member pressing an organizer-only control now
	// gets told rather than shown a change that never happened.
	const votePlace = useMutation<[string]>(
		(id) => api(`${base}/pois/${id}/vote`, { method: 'POST' }),
		{ fallback: cd.errors.votePlace, onSuccess: reload }
	);
	const voteStay = useMutation<[string]>(
		(id) => api(`${base}/stays/${id}/vote`, { method: 'POST' }),
		{
			fallback: cd.errors.voteStay,
			onSuccess: reload
		}
	);
	const removeStay = useMutation<[string]>(
		(id) => api(`${base}/stays/${id}`, { method: 'DELETE' }),
		{
			fallback: cd.errors.removeStay,
			onSuccess: reload
		}
	);

	const notice = votePlace.error || voteStay.error || removeStay.error;

	if (!data) return error ? <FormError message={error} variant="banner" /> : null;

	if (data.cities.length === 0) {
		return <NoCities isOrganizer={trip.role === 'organizer'} onAddCity={() => addCity(reload)} />;
	}

	const withStays = showsStays(view);
	const kinds = placeKinds(view);

	// Alphabetical, so the list is a lookup rather than a second rendering of
	// the itinerary order the trip header already shows.
	const cities = [...data.cities].sort((a, b) => a.name.localeCompare(b.name));
	const current = cities.find((c) => c.id === activeCity) ?? cities[0];
	if (!current) return null;

	const staysIn = (cityId: string) => (withStays ? (data.stays[cityId] ?? []) : []);
	const placesIn = (city: (typeof cities)[number]) =>
		city.pois.filter((p) => kinds.includes(p.kind));
	const stays = staysIn(current.id);
	const places = placesIn(current);

	/* One grid ordered by votes, whatever the filter says.
	 *
	 * The server already returns each pool in vote order, but the grid drew all
	 * the stays and then all the places, so under All a stay nobody wanted still
	 * sat above the most popular thing in the city. That made the ordering look
	 * arbitrary exactly where it matters most: All is the view you use to see
	 * what the group actually wants.
	 *
	 * The sort is stable and the pools go in server order, so ties keep the
	 * meaning they already had: stays ahead of places, and a locked stay ahead
	 * of the rest of the stays. */
	const items: (
		| { key: string; votes: number; stay: (typeof stays)[number] }
		| { key: string; votes: number; poi: (typeof places)[number] }
	)[] = [
		...stays.map((o) => ({ key: `stay:${o.id}`, votes: o.votes, stay: o })),
		...places.map((p) => ({ key: `poi:${p.id}`, votes: p.votes, poi: p }))
	].sort((a, b) => b.votes - a.votes);

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
		badge: placesIn(c).length + staysIn(c.id).length,
		items: c.pois.length + (data.stays[c.id]?.length ?? 0),
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
				onAddCity={() => addCity(reload)}
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
							ariaLabel={cd.header.typeAriaLabel}
						/>
					</div>

					<button type="button" className="btn primary ml-auto" onClick={() => setAdding(true)}>
						<PlusIcon />
						{cd.header.add}
					</button>
				</div>

				{stays.length + places.length === 0 ? (
					// The grid is skipped entirely rather than emptied: a centred panel
					// inside a column track would sit under the first column instead of
					// under the whole area it is standing in for.
					<div className="card px-5 py-5">
						<EmptyState graphic message={copy.common.nothingAdded} />
					</div>
				) : (
					<FlipGrid
						signature={items.map((i) => `${i.key}:${i.votes}`).join(',')}
						className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4"
					>
						{items.map((it) =>
							'stay' in it ? (
								<StayCard
									key={it.key}
									flipKey={it.key}
									stay={it.stay}
									currency={data.currency}
									pct={pct(it.stay.votes)}
									onEdit={() => setEditStay(it.stay)}
									onVote={() => void voteStay.run(it.stay.id)}
									onRemove={() => setDeleteStay(it.stay)}
								/>
							) : (
								<PlaceCard
									key={it.key}
									flipKey={it.key}
									poi={it.poi}
									tz={tzOf(current.id)}
									pct={pct(it.poi.votes)}
									onEdit={() => setEditPoi(it.poi)}
									onVote={() => void votePlace.run(it.poi.id)}
									onRemove={() => setDeletePoi(it.poi)}
								/>
							)
						)}
					</FlipGrid>
				)}
			</div>

			{adding && (
				<AddDialog
					base={base}
					city={{ id: current.id, name: current.name }}
					tz={tzOf(current.id)}
					provider={data.provider}
					initialType={toAddType(view)}
					currency={data.currency}
					currencies={data.currencies}
					onClose={() => setAdding(false)}
					onAdded={(added) => {
						// Show the list the new thing landed in: adding a restaurant while
						// only Attractions is showing would otherwise look like it did
						// nothing. All already shows it, so All is left alone.
						setView((v) => (v === ALL_VIEW ? v : added));
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

			{editStay && (
				<EditStayDialog
					base={base}
					stay={editStay}
					currency={data.currency}
					currencies={data.currencies}
					onClose={() => setEditStay(null)}
					onSaved={() => {
						setEditStay(null);
						reload();
					}}
				/>
			)}

			<ConfirmDialog
				open={!!deletePoi}
				title={deletePoi ? cd.deletePlace.title(deletePoi.name) : ''}
				confirmLabel={
					deletePoi && deletePoi.linked > 0
						? cd.deletePlace.confirmLabel(deletePoi.linked)
						: copy.common.delete
				}
				busyLabel={copy.common.deleting}
				onCancel={() => setDeletePoi(null)}
				onConfirm={async () => {
					if (!deletePoi) return;
					await api(`${base}/pois/${deletePoi.id}`, { method: 'DELETE' });
					setDeletePoi(null);
					reload();
				}}
			/>
			<ConfirmDialog
				open={!!deleteStay}
				title={deleteStay ? cd.deleteStay.title(deleteStay.name) : ''}
				busyLabel={copy.common.deleting}
				onCancel={() => setDeleteStay(null)}
				onConfirm={async () => {
					if (!deleteStay) return;
					await removeStay.run(deleteStay.id);
					setDeleteStay(null);
				}}
			/>
		</div>
	);
}
