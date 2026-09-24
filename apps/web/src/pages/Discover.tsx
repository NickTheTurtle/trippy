import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { useLiveSection } from '../hooks/useTripEvents';
import FlipGrid from '../components/ui/FlipGrid';
import { useTrip } from './TripShell';
import Select from '../components/ui/Select';
import LoadError from '../components/ui/LoadError';
import Loading from '../components/ui/Loading';
import { useToast } from '../components/ui/Toast';
import EmptyState from '../components/ui/EmptyState';
import type { DiscoverData, Poi, Stay } from '../lib/api-types';
import CityList, { type CityRow } from './discover/CityList';
import PlaceCard from './discover/PlaceCard';
import StayCard from './discover/StayCard';
import AddDialog from './discover/AddDialog';
import { useVotes } from './discover/useVotes';
import EditPlaceDialog from './discover/EditPlaceDialog';
import EditStayDialog from './discover/EditStayDialog';
import NoCities from './discover/NoCities';
import Pills from '../components/ui/Pills';
import { useNarrowLayout } from '../hooks/useMediaQuery';
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
	const toast = useToast();
	// Places, stays and their votes, plus the cities the sidebar lists.
	useLiveSection(['pois', 'lodging', 'schedule', 'members', 'trip'], reload);

	const [activeCity, setActiveCity] = useState('');
	const [view, setView] = useState<DiscoverView>(ALL_VIEW);
	const [adding, setAdding] = useState(false);
	const [editPoi, setEditPoi] = useState<Poi | null>(null);
	const [editStay, setEditStay] = useState<Stay | null>(null);
	const narrow = useNarrowLayout();

	// One state machine per write, each reporting the server's own refusal. The
	// API answers 400 / 403 / 404 for a write it declines where it used to
	// answer `{ok:true}`, so a member pressing an organizer-only control now
	// gets told rather than shown a change that never happened.
	const votes = useVotes({ base, data, reload, onError: toast.error });
	/**
	 * A delete from an edit dialog's confirmation. It throws on a refusal so the
	 * confirmation stays open and says why, and on a 404 (somebody else deleted
	 * it first) it resyncs the grid before throwing, so the card that is no
	 * longer there does not stay drawn behind the message.
	 */
	const deleteRow = async (path: string) => {
		try {
			await api(path, { method: 'DELETE' });
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) reload();
			throw err;
		}
		reload();
	};

	/* Three states before there is a page: still loading, failed, or here. The
	   reason for a failure goes to the corner and the page keeps a line saying
	   it is not there; a popup over a blank screen explains itself and leaves
	   nothing. The first fetch says it is loading rather than flashing blank. */
	if (!data) return error ? <LoadError message={error} onRetry={reload} /> : <Loading />;

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

	const staysIn = (cityId: string) =>
		withStays ? (data.stays[cityId] ?? []).map((s) => votes.stay(cityId, s)) : [];
	const placesIn = (city: (typeof cities)[number]) =>
		city.pois.filter((p) => kinds.includes(p.kind));
	const stays = staysIn(current.id);
	const places = placesIn(current).map(votes.place);

	/* One grid ordered by votes, whatever the filter says.
	 *
	 * The server already returns each pool in vote order, but the grid drew all
	 * the stays and then all the places, so under All a stay nobody wanted still
	 * sat above the most popular thing in the city. That made the ordering look
	 * arbitrary exactly where it matters most: All is the view you use to see
	 * what the group actually wants.
	 *
	 * The sort is stable and the pools go in server order, so ties keep the
	 * meaning they already had: stays ahead of places. */
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
		badge: placesIn(c).length + staysIn(c.id).length
	}));

	/** Share of the group behind an option, for the bar along the card's edge. */
	const pct = (votes: number) =>
		data.memberCount ? Math.round((votes / data.memberCount) * 100) : 0;

	const addButton = (
		<button type="button" className="btn primary ml-auto" onClick={() => setAdding(true)}>
			<PlusIcon />
			{cd.header.add}
		</button>
	);

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
				action={addButton}
			/>

			<div className="min-w-0">
				<div className={`mb-4 flex flex-wrap items-center gap-4 ${narrow ? '' : 'min-h-phead'}`}>
					{/* Four types, and on a phone a dropdown is a tap to open, a tap to
					    choose and a menu over the grid you are filtering. Laid out as
					    pills they are one tap and they never cover the thing they
					    change. The desktop keeps the Select, where the header row has
					    other work to do and the menu is not in the way. */}
					{narrow ? (
						<Pills
							items={VIEW_OPTIONS}
							value={view}
							onChange={setView}
							ariaLabel={cd.header.typeAriaLabel}
						/>
					) : (
						<div className="min-w-0 flex-[0_1_auto]">
							<Select
								options={VIEW_OPTIONS}
								value={view}
								onChange={(v) => setView(v as DiscoverView)}
								ariaLabel={cd.header.typeAriaLabel}
							/>
						</div>
					)}

					{!narrow && addButton}
				</div>

				{stays.length + places.length === 0 ? (
					// The grid is skipped entirely rather than emptied: a centred panel
					// inside a column track would sit under the first column instead of
					// under the whole area it is standing in for. The card carries no
					// padding of its own, because the empty state is the whole panel and
					// brings its own; padding here made this card taller than the same
					// panel on Expenses.
					<div className="card">
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
									voteBusy={it.stay.voteBusy}
									onEdit={() => setEditStay(it.stay)}
									onVote={() => votes.toggleStay(current.id, it.stay)}
								/>
							) : (
								<PlaceCard
									key={it.key}
									flipKey={it.key}
									poi={it.poi}
									tz={tzOf(current.id)}
									pct={pct(it.poi.votes)}
									voteBusy={it.poi.voteBusy}
									onEdit={() => setEditPoi(it.poi)}
									onVote={() => votes.togglePlace(it.poi)}
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
					onDelete={async () => {
						await deleteRow(`${base}/pois/${editPoi.id}`);
						setEditPoi(null);
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
					onDelete={async () => {
						// Thrown, not caught: a failed delete keeps the confirmation open
						// with the refusal on it, as the place and city deletes do. This
						// went through a mutation whose `run` never throws, so a refused
						// delete closed the dialog as though it had worked.
						await deleteRow(`${base}/stays/${editStay.id}`);
						setEditStay(null);
					}}
				/>
			)}
		</div>
	);
}
