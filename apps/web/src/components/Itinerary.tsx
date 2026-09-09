import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import Modal from './Modal';
import { Field, FieldShell } from './Field';
import { LinkButton } from './buttons';
import type { Trip, TripCity } from '../pages/TripShell';

type Suggestion = { name: string; country: string; lat: number; lng: number; tz: string };

const MIN_QUERY = 2;

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
			// A list editor over rows that already exist: its first field is a
			// saved arrival date, so autofocusing it would put a stray keystroke on
			// real data. Focus stays on the close button, as it did before.
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
					<p className="muted m-0 text-[0.88rem]">
						This trip has no cities yet. Everything else in the app hangs off one, so start here.
					</p>
				) : (
					<ul className="m-0 flex list-none flex-col gap-2 p-0">
						{trip.cities.map((city) => (
							<CityRow
								key={city.id}
								city={city}
								canRemove={trip.cities.length > 1}
								onSave={(v) => call(`/trips/${trip.id}/cities/${city.id}`, 'PATCH', v)}
								onRemove={() => call(`/trips/${trip.id}/cities/${city.id}`, 'DELETE')}
							/>
						))}
					</ul>
				)}

				<AddCity
					trip={trip}
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

/**
 * One city. The dates are editable in place and save on blur rather than behind
 * a Save button: a row with its own button reads as a separate form, and there
 * would be one per city.
 */
function CityRow({
	city,
	canRemove,
	onSave,
	onRemove
}: {
	city: TripCity;
	canRemove: boolean;
	onSave: (v: Record<string, unknown>) => Promise<boolean>;
	onRemove: () => void;
}) {
	const [arrive, setArrive] = useState(city.arrive);
	const [depart, setDepart] = useState(city.depart);
	const [busy, setBusy] = useState(false);

	async function commit(next: { arrive: string; depart: string }) {
		if (next.arrive === city.arrive && next.depart === city.depart) return;
		setBusy(true);
		const okay = await onSave({ ...city, ...next });
		if (!okay) {
			// The server refused, so the row must not keep showing a value the trip
			// does not have.
			setArrive(city.arrive);
			setDepart(city.depart);
		}
		setBusy(false);
	}

	return (
		<li className="flex flex-wrap items-end gap-2.5 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
			<span className="flex min-w-0 flex-[1_1_140px] flex-col">
				<span className="truncate font-medium">{city.name}</span>
				<span className="muted truncate text-[0.78rem]">
					{city.country}
					{city.country && ' · '}
					{city.tz.replace(/_/g, ' ')}
				</span>
			</span>
			<Field
				label="Arrive"
				className="flex-[0_1_140px]"
				type="date"
				inputClassName="compact"
				disabled={busy}
				value={arrive}
				onChange={(e) => setArrive(e.target.value)}
				onBlur={() => commit({ arrive, depart })}
			/>
			<Field
				label="Depart"
				className="flex-[0_1_140px]"
				type="date"
				inputClassName="compact"
				disabled={busy}
				value={depart}
				onChange={(e) => setDepart(e.target.value)}
				onBlur={() => commit({ arrive, depart })}
			/>
			<LinkButton
				danger
				onClick={onRemove}
				disabled={!canRemove || busy}
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
 * Search, pick, set dates, add.
 *
 * The search is the geocoder behind `/citysearch`, which returns the country,
 * the coordinates and the IANA zone with the name, so the organizer never types
 * a time zone. That endpoint existed and had no caller before this.
 *
 * Exported so Discover's own "Add city" popup is the same control rather than a
 * second copy of it. (Additive: nothing else about this component changed.)
 */
export function AddCity({
	trip,
	onAdd
}: {
	trip: Trip;
	onAdd: (v: Record<string, unknown>) => Promise<boolean>;
}) {
	const [query, setQuery] = useState('');
	const [hits, setHits] = useState<Suggestion[]>([]);
	const [searching, setSearching] = useState(false);
	const [picked, setPicked] = useState<Suggestion | null>(null);
	const [arrive, setArrive] = useState('');
	const [depart, setDepart] = useState('');
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
		clearTimeout(timer.current);
		setSearching(v.trim().length >= MIN_QUERY);
		timer.current = setTimeout(() => run(v.trim()), 350);
	}

	function pick(s: Suggestion) {
		setPicked(s);
		setQuery('');
		setHits([]);
		// Default to the day after the last city leaves, or to the trip's own
		// start: the common case is appending the next stop, and typing the same
		// date twice is what an itinerary editor should save you from. A brand new
		// trip has free-text dates and no parsed start, hence today.
		const last = trip.cities[trip.cities.length - 1];
		const from = last ? nextDay(last.depart) : (trip.start_date ?? today());
		setArrive(from);
		setDepart(last ? from : (trip.end_date ?? from));
	}

	async function add() {
		if (!picked) return;
		setBusy(true);
		const okay = await onAdd({ ...picked, arrive, depart });
		setBusy(false);
		if (okay) {
			setPicked(null);
			setArrive('');
			setDepart('');
		}
	}

	if (picked) {
		return (
			<div className="flex flex-col gap-2.5 rounded-[10px] border border-accent-soft bg-accent-soft/40 px-3 py-3">
				<div className="flex flex-wrap items-end gap-2.5">
					<span className="flex min-w-0 flex-[1_1_140px] flex-col">
						<span className="truncate font-medium">{picked.name}</span>
						<span className="muted truncate text-[0.78rem]">
							{picked.country}
							{picked.country && ' · '}
							{picked.tz.replace(/_/g, ' ')}
						</span>
					</span>
					<Field
						label="Arrive"
						className="flex-[0_1_140px]"
						type="date"
						inputClassName="compact"
						value={arrive}
						onChange={(e) => setArrive(e.target.value)}
					/>
					<Field
						label="Depart"
						className="flex-[0_1_140px]"
						type="date"
						inputClassName="compact"
						value={depart}
						onChange={(e) => setDepart(e.target.value)}
					/>
				</div>
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
		<div className="flex flex-col gap-1.5">
			<FieldShell label="Add a city">
				<input
					className="input"
					value={query}
					onChange={(e) => onQuery(e.target.value)}
					// Format is not the issue here; what the box wants is not obvious
					// from "Add a city" alone, so the placeholder carries an example.
					placeholder="Kyoto, Lisbon, Cusco..."
					aria-label="Add a city"
				/>
			</FieldShell>
			{searching && <p className="muted m-0 text-[0.8rem]">Searching...</p>}
			{!searching && hits.length > 0 && (
				<ul className="m-0 flex max-h-56 list-none flex-col gap-0.5 overflow-y-auto p-0">
					{hits.map((s) => (
						<li key={`${s.name}|${s.country}|${s.lat}`}>
							<button
								type="button"
								onClick={() => pick(s)}
								className="flex w-full cursor-pointer items-baseline gap-2 rounded-sm border-none bg-transparent px-2 py-1.5 text-left hover:bg-surface-2"
							>
								<span className="min-w-0 truncate font-medium">{s.name}</span>
								<span className="muted min-w-0 truncate text-[0.8rem]">{s.country}</span>
							</button>
						</li>
					))}
				</ul>
			)}
			{!searching && query.trim().length >= MIN_QUERY && hits.length === 0 && (
				<p className="muted m-0 text-[0.8rem]">No cities matched that.</p>
			)}
		</div>
	);
}

/** Next calendar day, in the same YYYY-MM-DD form, via UTC so it cannot shift. */
function nextDay(date: string): string {
	const d = new Date(`${date}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return date;
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}

/** Today where the organizer is, not in UTC, since it seeds a date they read. */
function today(): string {
	const d = new Date();
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}
