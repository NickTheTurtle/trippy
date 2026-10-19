import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import Modal, { ModalFooter } from './ui/Modal';
import SearchDropdown from './ui/SearchDropdown';
import { IconButton } from './ui/buttons';
import { CloseIcon } from './ui/icons';
import type { Trip } from '../pages/TripShell';
import { copy } from '../copy';

const c = copy.addCity;

/**
 * One `/citysearch` hit. Mirrors `CitySuggestion` in the geocoder.
 *
 * `region` is optional there and optional here for the same reason: city-states
 * have none, and the server omits the field rather than sending `''`. It is
 * carried on this type (not just rendered from it) because the picked
 * suggestions go into the POST body whole, so a field the type does not know
 * about is a field the client silently drops.
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
 * The most cities one request may add. The server's `MAX_CITIES_PER_ADD`, which
 * cannot be imported here (it lives beside SQLite), so it is repeated: past
 * this the picker stops taking more rather than letting the user build a list
 * the server will refuse whole.
 */
const MAX_PICKED = 20;

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
 * The add-cities dialog.
 *
 * Cities are what every other section is scoped to, so until this existed a
 * freshly created trip was a dead end: Discover told you to add a city and
 * nothing in the app could.
 *
 * Several cities go in at once. Each pick joins a list under the search, in
 * the order picked, and the footer adds the whole list in one request. A trip
 * is usually planned as a route, so one dialog per stop was the wrong unit,
 * and the search box that stayed put after a pick already looked like it took
 * more than one. The request is all or nothing on the server, so a refusal
 * (one of them is already on the trip) leaves the list here intact: the user
 * removes that one and presses Add again, rather than working out which of
 * the rest landed.
 *
 * It adds, and does not list what the trip has. The sidebar behind it already
 * shows every city with its own delete button, so repeating that list here was
 * the same data twice, one of the two copies stale the moment the other
 * changed. The list here is only what is about to be added. Kept out of the
 * Edit trip dialog on purpose, since this takes effect immediately and that
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
	const [picked, setPicked] = useState<Suggestion[]>([]);
	const [busy, setBusy] = useState(false);
	const searchRef = useRef<HTMLDivElement>(null);

	async function add() {
		if (picked.length === 0) return;
		setBusy(true);
		setError('');
		try {
			await api<{ trip: Trip; added: string[] }>(`/trips/${trip.id}/cities`, {
				method: 'POST',
				body: { cities: picked }
			});
			onChanged();
			onClose();
		} catch (err) {
			// The server names the city it refused, so the list stays as it was
			// for that one to be taken out and the rest retried.
			setError(err instanceof ApiError ? err.message : c.addFallback);
		} finally {
			setBusy(false);
		}
	}

	function remove(k: string) {
		setPicked((list) => list.filter((s) => key(s) !== k));
		// The button that had focus is gone with its row; the search box is where
		// the next thing happens, whether that is another pick or Add.
		searchRef.current?.querySelector('input')?.focus();
	}

	const pickedKeys = new Set(picked.map(key));

	return (
		<Modal open title={c.title} subtitle={trip.name} onClose={onClose}>
			<div className="mbody flex flex-col gap-4">
				<div ref={searchRef}>
					<CitySearch
						onPick={(s) => {
							setPicked((list) => [...list, s]);
							// Clicking a row does not take focus from the box, but a tap on a
							// touch screen can; either way the next city is typed here.
							searchRef.current?.querySelector('input')?.focus();
						}}
						// Same rule the server enforces, so a city the trip already has is
						// visibly unavailable instead of failing on Add.
						onTrip={new Set(trip.cities.map(key))}
						picked={pickedKeys}
						full={picked.length >= MAX_PICKED}
					/>
				</div>

				{picked.length > 0 && <PickedList picked={picked} onRemove={remove} />}
			</div>
			<ModalFooter
				onClose={onClose}
				onSubmit={() => void add()}
				busy={busy}
				disabled={picked.length === 0}
				error={error}
				busyLabel={copy.common.adding}
				submitLabel={c.submit(picked.length)}
			/>
		</Modal>
	);
}

/**
 * What the footer will add, in the order it will be added. Laid out like the
 * search row each one came from (name and region, then country and zone), in
 * the tinted card the single pick used to sit in, one ruled row per city so a
 * list of several still reads as one thing about to happen.
 */
function PickedList({
	picked,
	onRemove
}: {
	picked: Suggestion[];
	onRemove: (key: string) => void;
}) {
	const names = picked.map((s) => s.name.trim().toLowerCase());
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-1.5">
			{/* A label in the field labels' own style rather than a heading, which
			    would draw in the display face and outweigh the dialog's title. */}
			<p id={headingId} className="flabel m-0">
				{c.pickedHeading(picked.length)}
			</p>
			<ul className="m-0 flex min-w-0 list-none flex-col divide-y divide-accent-soft rounded-md border border-accent-soft bg-accent-soft/40 p-0">
				{picked.map((s, i) => {
					// Two Nashvilles in one list need different names on their remove
					// buttons; one Kyoto does not need its prefecture read out.
					const label =
						names.indexOf(names[i]) !== names.lastIndexOf(names[i]) && s.region
							? `${s.name}, ${s.region}`
							: s.name;
					return (
						<li key={key(s)} className="flex min-w-0 items-center gap-2 py-1.5 pr-1.5 pl-3">
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="flex min-w-0 items-baseline gap-1.5">
									<span className="truncate font-medium">{s.name}</span>
									{s.region && <span className="muted min-w-0 truncate text-meta">{s.region}</span>}
								</span>
								<span className="muted truncate text-meta">
									{detail(s.country, s.tz.replace(/_/g, ' '))}
								</span>
							</span>
							<IconButton label={c.remove(label)} onClick={() => onRemove(key(s))}>
								<CloseIcon />
							</IconButton>
						</li>
					);
				})}
			</ul>
		</section>
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
 *
 * A pick empties the box and leaves the caret in it, so the next city is typed
 * straight after the last one is chosen.
 */
function CitySearch({
	onPick,
	onTrip,
	picked,
	full
}: {
	onPick: (v: Suggestion) => void;
	/** Identity keys of the cities the trip already has. */
	onTrip: Set<string>;
	/** Identity keys of the cities already in the list to add. */
	picked: Set<string>;
	/** The list is at the most one request may add; nothing more can be picked. */
	full: boolean;
}) {
	const [query, setQuery] = useState('');
	const [hits, setHits] = useState<Suggestion[]>([]);
	const [searching, setSearching] = useState(false);
	/** Why the last search failed. Not the same thing as it finding nothing. */
	const [searchError, setSearchError] = useState('');
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
		setSearchError('');
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
			.catch((err) => {
				if (ctl.signal.aborted) return;
				setHits([]);
				// The geocoder's own refusal (a rate limit, a provider that is down)
				// or the client's "could not reach the server", in place of the
				// results. "No cities matched" is kept for a search that worked.
				setSearchError(err instanceof ApiError ? err.message : copy.api.requestFailed);
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
		// A search still pending for the old query has nothing left to answer.
		clearTimeout(timer.current);
		inflight.current?.abort();
		inflight.current = undefined;
		setSearching(false);
		setQuery('');
		setHits([]);
		setOpen(false);
	}

	return (
		<SearchDropdown
			// The dialog's title already says "Add cities", so the field is named
			// for what it holds rather than repeating the action. The placeholder
			// does the rest: what the box wants is examples, not a format.
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
			// row itself rather than only on the list after the pick: choosing
			// between two Springfields is the moment it is needed. It joins the
			// country through `detail`, so a city-state with no region renders as
			// the country alone, exactly as every row did before.
			renderItem={(s) => {
				// On the trip outranks in the list: the list could drop it again, the
				// trip will not.
				const tag = onTrip.has(key(s)) ? c.alreadyAdded : picked.has(key(s)) ? c.picked : '';
				return (
					<span className="flex items-baseline gap-2">
						<span className="min-w-0 truncate font-medium">{s.name}</span>
						<span className="muted min-w-0 truncate text-meta">{detail(s.region, s.country)}</span>
						{tag && <span className="muted ml-auto shrink-0 text-micro">{tag}</span>}
					</span>
				);
			}}
			// Both are refused by the server (the whole request with them), so
			// neither can be picked. A full list takes nothing more, unlabelled:
			// the count above the list already says why.
			itemDisabled={(s) => full || onTrip.has(key(s)) || picked.has(key(s))}
			// Nothing to say yet on one letter, so the popup stays shut until the
			// query is long enough to have searched.
			empty={
				query.trim().length < MIN_QUERY
					? null
					: searching
						? c.searching
						: searchError || c.noMatches
			}
		/>
	);
}
