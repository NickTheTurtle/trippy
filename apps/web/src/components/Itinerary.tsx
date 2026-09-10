import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import Modal from './ui/Modal';
import { LinkButton } from './ui/buttons';
import SearchDropdown from './ui/SearchDropdown';
import type { Trip, TripCity } from '../pages/TripShell';

/**
 * One `/citysearch` hit. Mirrors `CitySuggestion` in the geocoder.
 *
 * `region` is optional there and optional here for the same reason: city-states
 * have none, and the server omits the field rather than sending `''`. It is
 * carried on this type (not just rendered from it) because `pick` spreads the
 * whole suggestion into the POST body, so a field the type does not know about
 * is a field the client silently drops.
 */
type Suggestion = {
	name: string;
	country: string;
	region?: string;
	lat: number;
	lng: number;
	tz: string;
};

const MIN_QUERY = 2;

/**
 * Joins the parts of a city's secondary line, dropping the ones it has not got.
 *
 * The separator lives between surviving parts only: a city with no region reads
 * exactly as it did before this existed, with no leading comma, doubled dot or
 * trailing gap. Blank-but-present is treated as absent too, since a stored ''
 * and a missing column should look the same on screen.
 */
function detail(...parts: (string | null | undefined)[]): string {
	return parts
		.map((p) => p?.trim())
		.filter(Boolean)
		.join(' · ');
}

/**
 * The itinerary editor.
 *
 * Cities are what every other section is scoped to, so until this existed a
 * freshly created trip was a dead end: Discover told you to add a city and
 * nothing in the app could. Kept out of the Edit trip dialog on purpose, since
 * these controls take effect immediately and that form saves on submit; putting
 * both in one place makes it impossible to tell which is which.
 */
export default function Itinerary({
	trip,
	onClose,
	onChanged
}: {
	trip: Trip;
	onClose: () => void;
	onChanged: () => void;
}) {
	const [error, setError] = useState('');

	async function call(path: string, method: string, body?: unknown, fallback?: string) {
		setError('');
		try {
			await api(path, { method, body });
			onChanged();
			return true;
		} catch (err) {
			setError(err instanceof ApiError ? err.message : (fallback ?? 'Could not save that.'));
			return false;
		}
	}

	return (
		<Modal
			open
			title="Itinerary"
			subtitle={trip.name}
			// Focus stays on the close button so opening this list editor never
			// sends a stray keystroke into the city search box.
			autoFocusField={false}
			onClose={onClose}
		>
			<div className="mbody flex flex-col gap-4">
				{error && (
					<p role="alert" className="m-0 text-[0.88rem] text-warn">
						{error}
					</p>
				)}

				{trip.cities.length === 0 ? (
					<p className="muted m-0 text-[0.88rem]">No cities yet. Add your first stop below.</p>
				) : (
					<ul className="m-0 flex list-none flex-col gap-2 p-0">
						{trip.cities.map((city) => (
							<CityRow
								key={city.id}
								city={city}
								canRemove={trip.cities.length > 1}
								onRemove={() => call(`/trips/${trip.id}/cities/${city.id}`, 'DELETE')}
							/>
						))}
					</ul>
				)}

				<AddCity
					onAdd={(v) => call(`/trips/${trip.id}/cities`, 'POST', v, 'Could not add that city.')}
				/>
			</div>
			<div className="mfoot">
				<button className="btn" type="button" onClick={onClose}>
					Done
				</button>
			</div>
		</Modal>
	);
}

/** One city in the itinerary. Dates live on the trip, not on the city row. */
function CityRow({
	city,
	canRemove,
	onRemove
}: {
	city: TripCity;
	canRemove: boolean;
	onRemove: () => void;
}) {
	return (
		<li className="flex flex-wrap items-end gap-2.5 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
			<span className="flex min-w-0 flex-[1_1_140px] flex-col">
				{/* The region rides with the name rather than joining the line below
				    it: this column is about 190px, and region · country · zone on one
				    line ellipsised the zone away on every row. Beside the name is
				    also where it does its job, since the name is the ambiguous part.
				    Nothing is rendered at all when there is no region. */}
				<span className="flex items-baseline gap-1.5">
					<span className="truncate font-medium">{city.name}</span>
					{city.region && (
						<span className="muted min-w-0 truncate text-[0.78rem]">{city.region}</span>
					)}
				</span>
				<span className="muted truncate text-[0.78rem]">
					{detail(city.country, city.tz.replace(/_/g, ' '))}
				</span>
			</span>
			<LinkButton
				danger
				onClick={onRemove}
				disabled={!canRemove}
				aria-label={`Remove ${city.name}`}
				// Disabled rather than hidden on the last city: the button vanishing
				// as you delete down to one looks like a bug, and the title says why.
				title={canRemove ? undefined : 'A trip needs at least one city'}
				className="mb-1.5 disabled:cursor-not-allowed disabled:opacity-50"
			>
				Remove
			</LinkButton>
		</li>
	);
}

/**
 * Search, pick, add.
 *
 * The search is the geocoder behind `/citysearch`, which returns the country,
 * the coordinates and the IANA zone with the name, so the organizer never types
 * a time zone.
 */
function AddCity({ onAdd }: { onAdd: (v: Record<string, unknown>) => Promise<boolean> }) {
	const [query, setQuery] = useState('');
	const [hits, setHits] = useState<Suggestion[]>([]);
	const [searching, setSearching] = useState(false);
	const [picked, setPicked] = useState<Suggestion | null>(null);
	/** Whether the results overlay is showing. Closed by picking, reopened by typing. */
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const inflight = useRef<AbortController>(undefined);

	// Closing the dialog mid-search must not leave a request that resolves into
	// a component that is no longer mounted.
	useEffect(
		() => () => {
			clearTimeout(timer.current);
			inflight.current?.abort();
			inflight.current = undefined;
		},
		[]
	);

	function run(q: string) {
		if (q.length < MIN_QUERY) {
			setHits([]);
			setSearching(false);
			return;
		}
		// A slow early request must not land after a later one and replace good
		// results with stale ones.
		inflight.current?.abort();
		const ctl = new AbortController();
		inflight.current = ctl;
		api<{ results: Suggestion[] }>(`/citysearch?q=${encodeURIComponent(q)}`, { signal: ctl.signal })
			.then((d) => setHits(d.results ?? []))
			.catch(() => {
				if (!ctl.signal.aborted) setHits([]);
			})
			.finally(() => {
				if (inflight.current === ctl) {
					inflight.current = undefined;
					setSearching(false);
				}
			});
	}

	function onQuery(v: string) {
		setQuery(v);
		setOpen(true);
		clearTimeout(timer.current);
		setSearching(v.trim().length >= MIN_QUERY);
		timer.current = setTimeout(() => run(v.trim()), 350);
	}

	function pick(s: Suggestion) {
		setPicked(s);
		setQuery('');
		setHits([]);
		setOpen(false);
	}

	async function add() {
		if (!picked) return;
		setBusy(true);
		const okay = await onAdd(picked);
		setBusy(false);
		if (okay) {
			setPicked(null);
		}
	}

	if (picked) {
		return (
			<div className="flex flex-col gap-2.5 rounded-[10px] border border-accent-soft bg-accent-soft/40 px-3 py-3">
				<span className="flex min-w-0 flex-col">
					{/* Laid out like the saved rows below, so the card you confirm
					    reads the same as the row it becomes. */}
					<span className="flex items-baseline gap-1.5">
						<span className="truncate font-medium">{picked.name}</span>
						{picked.region && (
							<span className="muted min-w-0 truncate text-[0.78rem]">{picked.region}</span>
						)}
					</span>
					<span className="muted truncate text-[0.78rem]">
						{detail(picked.country, picked.tz.replace(/_/g, ' '))}
					</span>
				</span>
				<div className="flex gap-2">
					<button className="btn small primary" type="button" disabled={busy} onClick={add}>
						{busy ? 'Adding...' : `Add ${picked.name}`}
					</button>
					<button className="btn small" type="button" onClick={() => setPicked(null)}>
						Cancel
					</button>
				</div>
			</div>
		);
	}

	return (
		<SearchDropdown
			label="Add a city"
			// Format is not the issue here; what the box wants is not obvious from
			// "Add a city" alone, so the placeholder carries an example.
			placeholder="Kyoto, Lisbon, Cusco..."
			ariaLabel="Add a city"
			value={query}
			onChange={onQuery}
			open={open}
			onOpenChange={setOpen}
			busy={searching}
			// The results overlay the rows below rather than pushing them down the
			// dialog, which is what typing here used to do on every keystroke.
			items={hits.slice(0, 6)}
			itemKey={(s) => `${s.name}|${s.country}|${s.lat}`}
			onPick={pick}
			// The region is what tells two same-named hits apart, so it goes on the
			// row itself rather than only on the card after the pick: choosing
			// between two Springfields is the moment it is needed. It joins the
			// country through `detail`, so a city-state with no region renders as
			// the country alone, exactly as every row did before.
			renderItem={(s) => (
				<span className="flex items-baseline gap-2">
					<span className="min-w-0 truncate font-medium">{s.name}</span>
					<span className="muted min-w-0 truncate text-[0.8rem]">
						{detail(s.region, s.country)}
					</span>
				</span>
			)}
			// Nothing to say yet on one letter, so the popup stays shut until the
			// query is long enough to have searched.
			empty={
				query.trim().length < MIN_QUERY
					? null
					: searching
						? 'Searching...'
						: 'No cities matched that.'
			}
		/>
	);
}
