import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import Modal, { ModalFooter } from './ui/Modal';
import SearchDropdown from './ui/SearchDropdown';
import type { Trip } from '../pages/TripShell';
import { copy } from '../copy';

const c = copy.addCity;

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

/** A city's identity for comparison: name, country and region, folded. */
function key(c: { name: string; country: string; region?: string | null }): string {
	const part = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
	return `${part(c.name)}|${part(c.country)}|${part(c.region)}`;
}

/**
 * The add-city dialog.
 *
 * Cities are what every other section is scoped to, so until this existed a
 * freshly created trip was a dead end: Discover told you to add a city and
 * nothing in the app could.
 *
 * It adds, and does not list. The sidebar behind it already shows every city
 * with its own delete button, so repeating that list here was the same data
 * twice, one of the two copies stale the moment the other changed. Kept out of
 * the Edit trip dialog on purpose, since this takes effect immediately and that
 * form saves on submit; putting both in one place makes it impossible to tell
 * which is which.
 */
export default function AddCityDialog({
	trip,
	onClose,
	onChanged
}: {
	trip: Trip;
	onClose: () => void;
	onChanged: () => void;
}) {
	const [error, setError] = useState('');
	const [picked, setPicked] = useState<Suggestion | null>(null);
	const [busy, setBusy] = useState(false);

	async function add() {
		if (!picked) return;
		setBusy(true);
		setError('');
		try {
			await api(`/trips/${trip.id}/cities`, { method: 'POST', body: picked });
			onChanged();
			onClose();
		} catch (err) {
			setError(err instanceof ApiError ? err.message : c.addFallback);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal open title={c.title} subtitle={trip.name} onClose={onClose}>
			<div className="mbody flex flex-col gap-4">
				{/* The search stays put once a city is chosen, so changing your mind
				    is another search rather than a button to undo the last one. */}
				<CitySearch
					picked={picked}
					onPick={setPicked}
					// Same rule the server enforces, so a city the trip already has is
					// visibly unavailable instead of failing on Add.
					onTrip={new Set(trip.cities.map(key))}
				/>
			</div>
			<ModalFooter
				onClose={onClose}
				onSubmit={() => void add()}
				busy={busy}
				disabled={!picked}
				error={error}
				busyLabel={copy.common.adding}
				submitLabel={copy.common.add}
			/>
		</Modal>
	);
}

/**
 * Search and pick. Adding is the dialog's job, in its footer, because a form
 * with its own submit inside a modal that has one too leaves two buttons doing
 * the same thing and no way to tell which is the real one.
 *
 * The search is the geocoder behind `/citysearch`, which returns the country,
 * the coordinates and the IANA zone with the name, so the organizer never types
 * a time zone.
 */
function CitySearch({
	picked,
	onPick,
	onTrip
}: {
	picked: Suggestion | null;
	onPick: (v: Suggestion) => void;
	onTrip: Set<string>;
}) {
	const [query, setQuery] = useState('');
	const [hits, setHits] = useState<Suggestion[]>([]);
	const [searching, setSearching] = useState(false);
	/** Whether the results overlay is showing. Closed by picking, reopened by typing. */
	const [open, setOpen] = useState(false);
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
		onPick(s);
		setQuery('');
		setHits([]);
		setOpen(false);
	}

	return (
		<>
			<SearchDropdown
				// The dialog's title already says "Add city", so the field is named for
				// what it holds rather than repeating the action. The placeholder does
				// the rest: what the box wants is examples, not a format.
				label={c.searchLabel}
				placeholder={c.searchPlaceholder}
				value={query}
				onChange={onQuery}
				open={open}
				onOpenChange={setOpen}
				busy={searching}
				// The results overlay rather than pushing the dialog's own controls
				// down, which is what typing here used to do on every keystroke.
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
						{onTrip.has(key(s)) && (
							<span className="muted ml-auto shrink-0 text-[0.75rem]">{c.alreadyAdded}</span>
						)}
					</span>
				)}
				itemDisabled={(s) => onTrip.has(key(s))}
				// Nothing to say yet on one letter, so the popup stays shut until the
				// query is long enough to have searched.
				empty={query.trim().length < MIN_QUERY ? null : searching ? c.searching : c.noMatches}
			/>

			{picked && (
				<div className="flex min-w-0 flex-col rounded-md border border-accent-soft bg-accent-soft/40 px-3 py-2.5">
					{/* Laid out like the search result it came from, so what you are
					    about to add reads the same as the row you picked. */}
					<span className="flex items-baseline gap-1.5">
						<span className="truncate font-medium">{picked.name}</span>
						{picked.region && (
							<span className="muted min-w-0 truncate text-[0.78rem]">{picked.region}</span>
						)}
					</span>
					<span className="muted truncate text-[0.78rem]">
						{detail(picked.country, picked.tz.replace(/_/g, ' '))}
					</span>
				</div>
			)}
		</>
	);
}
