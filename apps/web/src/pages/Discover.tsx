import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { useApi } from '../useApi';
import { useTrip } from './TripShell';
import Cover from '../components/Cover';
import Modal from '../components/Modal';
import Select from '../components/Select';
import SectionNav from '../components/SectionNav';

type Poi = {
	id: string;
	name: string;
	category: string;
	notes: string | null;
	url: string | null;
	rating: number | null;
	rating_count: number | null;
	price_level: number | null;
	hours: string | null;
	photo: string | null;
	votes: number;
	you_voted: number;
	voters: string[];
	linked: number;
};
type City = { id: string; name: string; pois: Poi[] };
type Stay = {
	id: string;
	name: string;
	tag: string;
	price_cents: number | null;
	url: string | null;
	locked: number;
	check_in: string | null;
	check_out: string | null;
	votes: number;
	you_voted: number;
};
type Data = {
	cities: City[];
	stays: Record<string, Stay[]>;
	staysVoted: Record<string, number>;
	currency: string;
	memberCount: number;
	isOrganizer: boolean;
	provider: 'google' | 'osm';
};

/** A search result. `id` is the provider's, and only Google results carry one. */
type Hit = {
	id: string | null;
	name: string;
	category: string;
	address: string | null;
	url: string | null;
	lat: number | null;
	lng: number | null;
	rating: number | null;
	ratingCount: number | null;
	priceLevel: number | null;
	hours: string[] | null;
	photo: string | null;
	source: 'google' | 'osm';
};

/** Shortest query worth a billed request. Mirrors MIN_QUERY on the server. */
const MIN_QUERY = 3;

/** Identity for a result across a re-fetch: providers do not give stable ids. */
const hitKey = (h: Hit) => `${h.name}|${h.lat}|${h.lng}`;

const priceStr = (level: number | null | undefined) =>
	level == null ? '' : '$'.repeat(Math.max(1, level));

function todayHours(hours: string[] | null | undefined): string | null {
	if (!hours || hours.length === 0) return null;
	// Google lists Monday-first; JS getDay() is Sunday=0.
	const idx = (new Date().getDay() + 6) % 7;
	// Drop the leading weekday name for a compact chip.
	return (hours[idx] ?? hours[0]).replace(/^[A-Za-z]+:\s*/, '');
}

function parseHours(raw: string | null): string[] | null {
	if (!raw) return null;
	try {
		const v: unknown = JSON.parse(raw);
		return Array.isArray(v) ? v.map(String) : null;
	} catch {
		return null;
	}
}

function nightsLabel(inD: string | null, outD: string | null): string | null {
	if (!inD || !outD) return null;
	const ms = Date.parse(`${outD}T00:00:00Z`) - Date.parse(`${inD}T00:00:00Z`);
	if (!Number.isFinite(ms) || ms <= 0) return null;
	const n = Math.round(ms / 86400000);
	return `${inD.slice(5)} → ${outD.slice(5)} · ${n} night${n === 1 ? '' : 's'}`;
}

export default function Discover() {
	const { trip, editItinerary } = useTrip();
	const base = `/trips/${trip.id}/discover`;
	const { data, error, reload } = useApi<Data>(base);

	const [activeCity, setActiveCity] = useState('');
	const [tab, setTab] = useState('places');
	const [notice, setNotice] = useState('');

	/** The place queued for deletion, held while the confirmation modal is open. */
	const [confirmDelete, setConfirmDelete] = useState<Poi | null>(null);
	const [editPoi, setEditPoi] = useState<Poi | null>(null);
	const [showManual, setShowManual] = useState(false);
	const [showAddStay, setShowAddStay] = useState(false);
	const [datesFor, setDatesFor] = useState<string | null>(null);

	// --- Search state -------------------------------------------------------
	const [query, setQuery] = useState('');
	const [hits, setHits] = useState<Hit[]>([]);
	const [searching, setSearching] = useState(false);
	const [searched, setSearched] = useState(false);
	const [focused, setFocused] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	/** How many times each result has been added this search: one place can be
	    added repeatedly, once per activity, so a tick alone would understate it. */
	const [added, setAdded] = useState<Map<string, number>>(new Map());
	/** The search result whose add popup is open, per kind. */
	const [detailHit, setDetailHit] = useState<Hit | null>(null);
	const [stayHit, setStayHit] = useState<Hit | null>(null);
	/** True while the clicked result's ratings, hours and photo are being fetched. */
	const [detailLoading, setDetailLoading] = useState(false);

	const searchEl = useRef<HTMLDivElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	/** Lets a new search cancel the one before it. */
	const inflight = useRef<AbortController | undefined>(undefined);

	/** Stays and places are different searches; one's results never apply to the other. */
	const searchKind: 'place' | 'stay' = tab === 'stays' ? 'stay' : 'place';

	const clearSearch = useCallback(() => {
		clearTimeout(timer.current);
		inflight.current?.abort();
		inflight.current = undefined;
		setQuery('');
		setHits([]);
		setAdded(new Map());
		setSearched(false);
		setSearching(false);
	}, []);

	// Switching section must not leave hotel results hanging over the places pool.
	useEffect(() => clearSearch(), [searchKind, clearSearch]);

	const cities = data?.cities ?? [];
	const current = cities.find((c) => c.id === activeCity) ?? cities[0] ?? null;

	// A modal is a layer above the dropdown, not a click elsewhere on the page.
	const modalOpen =
		!!detailHit || !!stayHit || showManual || showAddStay || !!editPoi || !!confirmDelete;
	/**
	 * Open once the field is engaged, not only once there are results: "add
	 * manually" is the answer to "the place I want is not findable", and you often
	 * know that before you type. An empty query shows the footer alone.
	 */
	const showResults = (searched || focused) && !dismissed;

	// Results hang over the page as a dropdown, so they need the dismissal
	// affordances any popup has: click away, or press Escape.
	useEffect(() => {
		if (!showResults) return;
		const onPointerDown = (e: PointerEvent) => {
			// Clicking inside the add popup must not dismiss the results behind it;
			// otherwise adding one place closes the list, and adding the same place a
			// second time for a different activity means retyping the search.
			if (modalOpen) return;
			if (!searchEl.current?.contains(e.target as Node)) setDismissed(true);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			// Modals own Escape while one is open; a dialog handles it natively.
			if (e.key === 'Escape' && !modalOpen) setDismissed(true);
		};
		window.addEventListener('pointerdown', onPointerDown);
		window.addEventListener('keydown', onKeyDown);
		return () => {
			window.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('keydown', onKeyDown);
		};
	}, [showResults, modalOpen]);

	function runSearch(q: string, cityId: string) {
		if (q.length < MIN_QUERY) {
			setHits([]);
			setSearched(false);
			setSearching(false);
			return;
		}
		// Without this a slow early request can land after a later one and replace
		// good results with stale ones: "acr" overwriting "acropolis".
		inflight.current?.abort();
		const ctl = new AbortController();
		inflight.current = ctl;
		setSearching(true);
		const params = new URLSearchParams({ q, cityId, kind: searchKind });
		api<{ results: Hit[] }>(`${base}/search?${params}`, { signal: ctl.signal })
			.then((d) => {
				setHits(d.results ?? []);
				setSearched(true);
			})
			.catch(() => {
				if (ctl.signal.aborted) return;
				setHits([]);
				setSearched(true);
			})
			.finally(() => {
				if (inflight.current === ctl) {
					inflight.current = undefined;
					setSearching(false);
				}
			});
	}

	function onQueryChange(value: string) {
		setQuery(value);
		setAdded(new Map());
		setDismissed(false);
		clearTimeout(timer.current);
		// Show the progress bar from the first keystroke that will actually search,
		// not once the request is in flight; otherwise it only appears after the
		// 350ms debounce.
		setSearching(value.trim().length >= MIN_QUERY);
		const cityId = current?.id;
		if (!cityId) return;
		timer.current = setTimeout(() => runSearch(value.trim(), cityId), 350);
	}

	/**
	 * Opens the add popup and fetches the fields the search deliberately skipped.
	 * The result is merged back into the row too, so a place looked at once keeps
	 * its rating in the list.
	 */
	function openHit(h: Hit) {
		if (searchKind === 'stay') setStayHit(h);
		else setDetailHit(h);
		if (!h.id || h.rating !== null || h.photo) return;
		setDetailLoading(true);
		api<{ details: Partial<Hit> | null }>(`${base}/details?id=${encodeURIComponent(h.id)}`)
			.then((d) => {
				if (!d.details) return;
				const merged = { ...h, ...d.details };
				setHits((xs) => xs.map((x) => (hitKey(x) === hitKey(h) ? merged : x)));
				// Only if the popup is still showing this place: the user may have
				// closed it or clicked another result while the request was in flight.
				setDetailHit((v) => (v && hitKey(v) === hitKey(h) ? merged : v));
				setStayHit((v) => (v && hitKey(v) === hitKey(h) ? merged : v));
			})
			.catch(() => {})
			.finally(() => setDetailLoading(false));
	}

	async function act(fn: () => Promise<unknown>) {
		setNotice('');
		try {
			await fn();
			reload();
		} catch (err) {
			setNotice(err instanceof ApiError ? err.message : 'Something went wrong.');
		}
	}

	if (!data) return error ? <p className="text-warn">{error}</p> : null;

	if (cities.length === 0) {
		// This used to be the sentence alone, which pointed at something the app
		// had no way to do.
		return (
			<div className="flex flex-col items-start gap-3">
				<p className="muted m-0">
					{trip.role === 'organizer'
						? 'Places are collected per city, so add the first stop to start.'
						: 'The organizer has not added any cities yet.'}
				</p>
				{trip.role === 'organizer' && (
					<button type="button" className="btn primary" onClick={editItinerary}>
						Add a city
					</button>
				)}
			</div>
		);
	}
	if (!current) return null;

	const stays = data.stays[current.id] ?? [];
	const staysVoted = data.staysVoted[current.id] ?? 0;
	const providerLabel = data.provider === 'google' ? 'Google Maps' : 'OpenStreetMap';

	/** The city pill counts whatever section you are in, so it never reads as a
	    places count while you are comparing stays. */
	const cityCount = (c: City) =>
		tab === 'places' ? c.pois.length : (data.stays[c.id] ?? []).length;

	/** Share of the group behind an option, for the vote bar. */
	const pct = (votes: number) =>
		data.memberCount ? Math.round((votes / data.memberCount) * 100) : 0;

	const money = (cents: number | null) =>
		cents === null
			? 'Price TBD'
			: // Non-breaking spaces so the price and its unit wrap as one chunk rather
				// than leaving "night" stranded on its own line in a narrow card.
				new Intl.NumberFormat(undefined, {
					style: 'currency',
					currency: data.currency
				}).format(cents / 100) + '\u00a0/\u00a0night';

	async function addFromHit(h: Hit, activity: string, notes: string) {
		if (!current) return;
		await api(`${base}/pois`, {
			method: 'POST',
			body: {
				cityId: current.id,
				name: h.name,
				activity,
				category: h.category,
				notes,
				url: h.url,
				photo: h.photo,
				lat: h.lat,
				lng: h.lng,
				rating: h.rating,
				ratingCount: h.ratingCount,
				priceLevel: h.priceLevel,
				hours: h.hours
			}
		});
	}

	return (
		<div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[190px_minmax(0,1fr)]">
			<SectionNav
				items={[
					{ id: 'places', label: 'Places', badge: current.pois.length || null },
					{ id: 'stays', label: 'Stays', badge: stays.length || null }
				]}
				value={tab}
				onChange={setTab}
				ariaLabel="Discover sections"
			/>

			<div className="min-w-0">
				{notice && (
					<p
						role="alert"
						className="mb-4 rounded-sm bg-danger-soft px-3.5 py-2.5 text-[0.9rem] text-danger-ink"
					>
						{notice}
					</p>
				)}

				<div className="mb-2.5 flex min-h-phead flex-wrap items-center justify-between gap-4">
					{/* A dropdown rather than a row of pills: the pill row grew with the
					    trip, wrapping to a second line on a five-city itinerary and moving
					    the cards down with it. A dropdown is one fixed-height control
					    whatever the itinerary. */}
					<div className="cityselect min-w-0 flex-[0_1_auto]">
						<Select
							options={cities.map((c) => ({
								value: c.id,
								label: `${c.name} · ${cityCount(c)}`
							}))}
							value={current.id}
							onChange={setActiveCity}
							ariaLabel="City"
						/>
					</div>

					{/* Lives in the header row rather than a line below it, so switching
					    section never changes the height above the cards. */}
					{tab === 'stays' && (
						<span className="muted text-[0.85rem] whitespace-nowrap">
							{staysVoted} of {data.memberCount} voted
						</span>
					)}

					<div ref={searchEl} className="relative ml-auto min-w-0 max-w-[420px] flex-[1_1_240px]">
						<div className="relative min-w-0">
							<input
								value={query}
								onChange={(e) => onQueryChange(e.target.value)}
								onFocus={() => {
									setDismissed(false);
									setFocused(true);
								}}
								placeholder="Search…"
								aria-label={
									searchKind === 'stay'
										? `Search hotels and rentals in ${current.name}`
										: `Search places in ${current.name}`
								}
								className="w-full rounded-full border border-line bg-surface py-1.5 pr-8 pl-3 text-[0.88rem] text-ink"
							/>
							{query && (
								<button
									type="button"
									onClick={clearSearch}
									aria-label="Clear search"
									className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-full border-none bg-transparent text-[1.05rem] leading-none text-ink-faint hover:bg-surface-2 hover:text-ink"
								>
									×
								</button>
							)}
							<div
								className={`progress pointer-events-none absolute right-3 bottom-px left-3 h-0.5 overflow-hidden rounded-full ${searching ? 'on' : ''}`}
								role="progressbar"
								aria-label="Searching"
								aria-busy={searching}
							>
								<span />
							</div>
						</div>

						{/* An anchored dropdown rather than an in-flow list: results are a
						    transient overlay, so finding a place must not push the pool of
						    places you already have off the screen. */}
						{showResults && (
							<div className="absolute top-[calc(100%+6px)] right-0 left-0 z-40 max-h-[min(60vh,380px)] overflow-y-auto overscroll-contain rounded-[10px] border border-line bg-surface shadow-lg">
								<ul className="m-0 flex list-none flex-col p-0">
									{hits.map((h) => {
										const key = hitKey(h);
										const n = added.get(key) ?? 0;
										const hrs = todayHours(h.hours);
										return (
											<li key={key}>
												{/* The whole row is the control; a small "Add" button next
												    to a rich result made the click target far smaller than
												    the thing it acted on. */}
												<button
													type="button"
													onClick={() => openHit(h)}
													className="group flex w-full cursor-pointer items-center justify-between gap-3 border-0 border-b border-line bg-transparent px-2.5 py-2.5 text-left hover:bg-surface-2"
												>
													<span className="flex min-w-0 flex-col gap-1">
														<strong className="[overflow-wrap:anywhere]">{h.name}</strong>
														<span className="flex flex-wrap items-center gap-1.5">
															{h.rating && (
																<span className="text-[0.8rem] font-semibold whitespace-nowrap text-warn">
																	★ {h.rating.toFixed(1)}
																	{h.ratingCount ? (
																		<span className="muted">&nbsp;({h.ratingCount})</span>
																	) : null}
																</span>
															)}
															{h.priceLevel != null && (
																<span className="text-[0.8rem] font-semibold whitespace-nowrap text-accent-ink">
																	{priceStr(h.priceLevel)}
																</span>
															)}
															{hrs && (
																<span className="muted text-[0.8rem] whitespace-nowrap">{hrs}</span>
															)}
														</span>
														{h.address && (
															<span className="muted line-clamp-1 text-[0.8rem]">{h.address}</span>
														)}
													</span>
													{n > 0 && (
														/* Affordance only; the row is the button. */
														<span
															aria-hidden="true"
															className="flex-none text-[0.8rem] font-semibold whitespace-nowrap text-ink-faint group-hover:text-accent-ink"
														>
															{n > 1 ? `Added ×${n}` : 'Added ✓'}
														</span>
													)}
												</button>
											</li>
										);
									})}

									{/* Two empty states, not three: with an empty field the footer
									    already says what to do, so a line telling you to search the
									    box you just clicked is noise. */}
									{hits.length === 0 && query.trim().length > 0 && (
										<li className="muted border-b border-line px-2.5 py-2.5 text-[0.85rem] [overflow-wrap:anywhere]">
											{query.trim().length < MIN_QUERY
												? 'Keep typing…'
												: searching
													? 'Searching…'
													: `No ${searchKind === 'stay' ? 'stays' : 'matches'} for “${query}”.`}
										</li>
									)}

									{/* Sticky footer, set apart from the results by its own tint: it
									    is the escape hatch, not another result. It also carries the
									    provider attribution, which has to sit next to the data. */}
									<li className="sticky bottom-0 z-1 flex flex-col items-end gap-0.5 bg-surface-2 px-2.5 py-2">
										<button
											className="btn small"
											type="button"
											onClick={() => {
												if (searchKind === 'stay') setShowAddStay(true);
												else setShowManual(true);
											}}
										>
											Add manually
										</button>
										<span className="text-[0.68rem] whitespace-nowrap text-ink-faint">
											Powered by {providerLabel}
										</span>
									</li>
								</ul>
							</div>
						)}
					</div>
				</div>

				<div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
					{tab === 'places' ? (
						<>
							{current.pois.map((p) => (
								<PlaceCard
									key={p.id}
									poi={p}
									pct={pct(p.votes)}
									onEdit={() => setEditPoi(p)}
									onVote={() => act(() => api(`${base}/pois/${p.id}/vote`, { method: 'POST' }))}
									onRemove={() => setConfirmDelete(p)}
								/>
							))}
							{current.pois.length === 0 && (
								<p className="muted col-span-full">
									No places in {current.name} yet. Add one to get started.
								</p>
							)}
						</>
					) : (
						<>
							{stays.map((o) => (
								<StayCard
									key={o.id}
									stay={o}
									pct={pct(o.votes)}
									money={money}
									isOrganizer={data.isOrganizer}
									editingDates={datesFor === o.id}
									onToggleDates={() => setDatesFor((v) => (v === o.id ? null : o.id))}
									onVote={() => act(() => api(`${base}/stays/${o.id}/vote`, { method: 'POST' }))}
									onLock={() => act(() => api(`${base}/stays/${o.id}/lock`, { method: 'POST' }))}
									onRemove={() => act(() => api(`${base}/stays/${o.id}`, { method: 'DELETE' }))}
									onSaveDates={async (checkIn, checkOut) => {
										await act(() =>
											api(`${base}/stays/${o.id}/dates`, {
												method: 'PATCH',
												body: { checkIn, checkOut }
											})
										);
										setDatesFor(null);
									}}
								/>
							))}
							{stays.length === 0 && (
								<p className="muted col-span-full">
									No stays proposed for {current.name} yet. Add one and let the group vote.
								</p>
							)}
						</>
					)}
				</div>
			</div>

			{detailHit && (
				<AddFromHit
					hit={detailHit}
					loading={detailLoading}
					onClose={() => setDetailHit(null)}
					onSubmit={async (activity, notes) => {
						const key = hitKey(detailHit);
						await addFromHit(detailHit, activity, notes);
						setAdded((m) => new Map(m).set(key, (m.get(key) ?? 0) + 1));
						setDetailHit(null);
						reload();
					}}
				/>
			)}

			{showManual && (
				<ManualPlace
					cityName={current.name}
					initialName={query}
					onClose={() => setShowManual(false)}
					onSubmit={async (v) => {
						await api(`${base}/pois`, {
							method: 'POST',
							body: { cityId: current.id, category: '', ...v }
						});
						setShowManual(false);
						reload();
					}}
				/>
			)}

			{editPoi && (
				<EditPlace
					poi={editPoi}
					onClose={() => setEditPoi(null)}
					onSubmit={async (v) => {
						await api(`${base}/pois/${editPoi.id}`, {
							method: 'PATCH',
							body: v
						});
						setEditPoi(null);
						reload();
					}}
				/>
			)}

			{(showAddStay || stayHit) && (
				<AddStay
					hit={stayHit}
					cityName={current.name}
					loading={detailLoading}
					onClose={() => {
						setShowAddStay(false);
						setStayHit(null);
					}}
					onSubmit={async (v) => {
						await api(`${base}/stays`, {
							method: 'POST',
							body: { cityId: current.id, ...v }
						});
						setShowAddStay(false);
						setStayHit(null);
						reload();
					}}
				/>
			)}

			{confirmDelete && (
				<ConfirmDelete
					poi={confirmDelete}
					onClose={() => setConfirmDelete(null)}
					onConfirm={async () => {
						await act(() => api(`${base}/pois/${confirmDelete.id}`, { method: 'DELETE' }));
						setConfirmDelete(null);
					}}
				/>
			)}
		</div>
	);
}

// --- Cards ------------------------------------------------------------------

const CARD = 'card opt flex flex-col overflow-hidden';
const VOTEBAR = 'h-1.5 overflow-hidden rounded-full bg-surface-2';

function VoteBar({ pct }: { pct: number }) {
	return (
		<div className={VOTEBAR}>
			<div className="h-full bg-accent" style={{ width: `${pct}%` }} />
		</div>
	);
}

function PlaceCard({
	poi: p,
	pct,
	onEdit,
	onVote,
	onRemove
}: {
	poi: Poi;
	pct: number;
	onEdit: () => void;
	onVote: () => void;
	onRemove: () => void;
}) {
	const hrs = todayHours(parseHours(p.hours));
	return (
		<article className={`${CARD} group/card`}>
			{/* The cover, title and meta are one control: clicking the place is how
			    you edit it. Vote, Open and Remove stay outside it so the card never
			    nests one interactive element inside another. */}
			<button
				type="button"
				onClick={onEdit}
				className="group flex min-w-0 flex-auto cursor-pointer flex-col p-0 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
			>
				<Cover photo={p.photo} seed={p.name} category={p.category} />
				<span className="flex min-w-0 flex-auto flex-col px-4 pt-3.5">
					<span className="line-clamp-2 text-base font-semibold [overflow-wrap:anywhere] group-hover:underline">
						{p.name}
					</span>
					{/* Absorbs the slack so everything below aligns across cards. */}
					<span className="muted mt-1.5 mb-2.5 flex min-w-0 flex-auto flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[0.85rem]">
						{p.rating && (
							<span className="font-semibold whitespace-nowrap text-warn">
								★ {p.rating.toFixed(1)}
								{p.rating_count ? <span className="muted">&nbsp;({p.rating_count})</span> : null}
							</span>
						)}
						{p.price_level != null && (
							<span className="font-semibold whitespace-nowrap text-accent-ink">
								{priceStr(p.price_level)}
							</span>
						)}
						{hrs && <span className="whitespace-nowrap">{hrs}</span>}
						{/* Notes are a multi-line field, so honour the breaks the author
						    typed, still clamped so cards stay the same height. */}
						{p.notes && (
							<span className="line-clamp-2 [overflow-wrap:anywhere] whitespace-pre-line">
								{p.notes}
							</span>
						)}
					</span>
				</span>
			</button>

			<div className="flex flex-none flex-col px-4 pt-2.5 pb-4">
				{p.linked > 0 && (
					<p className="mb-2.5 text-[0.8rem] [overflow-wrap:anywhere] text-accent-ink">
						🗓 On the calendar ×{p.linked}
					</p>
				)}
				<VoteBar pct={pct} />
				<div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[0.85rem]">
					<span className="muted">
						{p.votes} {p.votes === 1 ? 'vote' : 'votes'}
					</span>
					<div className="flex flex-wrap items-center gap-1.5">
						{p.url && (
							<a className="btn small" href={p.url} target="_blank" rel="noopener">
								Open
								<span className="sr-only"> {p.name} (opens in a new tab)</span>
							</a>
						)}
						<button
							className={p.you_voted ? 'btn small primary' : 'btn small'}
							onClick={onVote}
							aria-label={`${p.you_voted ? 'Remove your vote from' : 'Vote for'} ${p.name}`}
						>
							{p.you_voted ? 'Voted' : 'Vote'}
						</button>
					</div>
				</div>
				{/* Removing a place is the rarest thing anyone does here and there is
				    one card per place, so a permanent red link on all fourteen was the
				    loudest thing on the page. It keeps its space so the grid does not
				    shift, stays reachable by keyboard, and is always shown where there
				    is no hover to reveal it. */}
				<div className="mt-3 flex flex-wrap items-center gap-3.5 border-t border-line pt-3 opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 [@media(hover:none)]:opacity-100">
					<button className="link danger" onClick={onRemove} aria-label={`Remove ${p.name}`}>
						Remove
					</button>
				</div>
			</div>
		</article>
	);
}

function StayCard({
	stay: o,
	pct,
	money,
	isOrganizer,
	editingDates,
	onToggleDates,
	onVote,
	onLock,
	onRemove,
	onSaveDates
}: {
	stay: Stay;
	pct: number;
	money: (cents: number | null) => string;
	isOrganizer: boolean;
	editingDates: boolean;
	onToggleDates: () => void;
	onVote: () => void;
	onLock: () => void;
	onRemove: () => void;
	onSaveDates: (checkIn: string | null, checkOut: string | null) => void;
}) {
	const [checkIn, setCheckIn] = useState(o.check_in ?? '');
	const [checkOut, setCheckOut] = useState(o.check_out ?? '');
	const nights = nightsLabel(o.check_in, o.check_out);

	const ring = o.locked
		? 'border-accent shadow-[0_0_0_1px_var(--color-accent)]'
		: o.you_voted
			? 'border-accent-soft'
			: '';

	return (
		<article className={`${CARD} ${ring}`}>
			<Cover photo={null} seed={o.name} category="stay" />
			<div className="flex min-w-0 flex-auto flex-col px-4 pt-3.5 pb-4">
				<div className="flex items-start justify-between gap-2">
					<h4 className="m-0 line-clamp-2 min-w-0 text-base [overflow-wrap:anywhere]">{o.name}</h4>
					{o.locked ? <span className="chip accent flex-none">Locked</span> : null}
				</div>
				<p className="muted mt-1.5 mb-2.5 flex-auto text-[0.85rem]">
					{o.tag ? `${o.tag} · ` : ''}
					{money(o.price_cents)}
				</p>
				{nights && <p className="mb-2.5 text-[0.8rem] text-accent-ink">🛏 {nights}</p>}

				<VoteBar pct={pct} />
				<div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[0.85rem]">
					<span className="muted">
						{o.votes} {o.votes === 1 ? 'vote' : 'votes'}
					</span>
					<div className="flex flex-wrap items-center gap-1.5">
						{o.url && (
							<a className="btn small" href={o.url} target="_blank" rel="noopener">
								Open
								<span className="sr-only"> {o.name} (opens in a new tab)</span>
							</a>
						)}
						<button
							className={o.you_voted ? 'btn small primary' : 'btn small'}
							onClick={onVote}
							aria-label={`${o.you_voted ? 'Remove your vote from' : 'Vote for'} ${o.name}`}
						>
							{o.you_voted ? 'Voted' : 'Vote'}
						</button>
					</div>
				</div>

				<div className="mt-3 flex flex-wrap items-center gap-3.5 border-t border-line pt-3">
					<button className="link" aria-expanded={editingDates} onClick={onToggleDates}>
						{editingDates ? 'Cancel' : 'Edit dates'}
					</button>
					{isOrganizer && (
						<button
							className="link"
							onClick={onLock}
							aria-label={`${o.locked ? 'Unlock' : 'Lock as choice'}: ${o.name}`}
						>
							{o.locked ? 'Unlock' : 'Lock as choice'}
						</button>
					)}
					<button className="link danger" onClick={onRemove} aria-label={`Remove ${o.name}`}>
						Remove
					</button>
				</div>

				{editingDates && (
					<div className="mt-3 flex flex-wrap items-end gap-2">
						<label className="flex min-w-0 flex-col gap-1 text-[0.75rem] text-ink-faint">
							<span>In</span>
							<input
								type="date"
								value={checkIn}
								onChange={(e) => setCheckIn(e.target.value)}
								className="input compact max-w-full"
							/>
						</label>
						<label className="flex min-w-0 flex-col gap-1 text-[0.75rem] text-ink-faint">
							<span>Out</span>
							<input
								type="date"
								value={checkOut}
								onChange={(e) => setCheckOut(e.target.value)}
								className="input compact max-w-full"
							/>
						</label>
						<button
							className="btn small primary"
							onClick={() => onSaveDates(checkIn || null, checkOut || null)}
						>
							Save
						</button>
					</div>
				)}
			</div>
		</article>
	);
}

// --- Dialogs ----------------------------------------------------------------

function Optional() {
	return <span className="muted">(optional)</span>;
}

/** The rating, price band and today's hours for a search result. */
function HitSummary({ hit: h, loading }: { hit: Hit; loading: boolean }) {
	const hrs = todayHours(h.hours);
	if (loading) {
		// Holds the summary line's height so the fields below do not jump down
		// when the ratings arrive.
		return <p aria-hidden="true" className="mb-1 h-[1.2em] w-36 rounded-sm bg-line opacity-50" />;
	}
	if (!h.rating && h.priceLevel == null && !hrs) return null;
	return (
		<p className="muted mb-1 flex flex-wrap items-center gap-1.5">
			{h.rating && (
				<span className="text-[0.8rem] font-semibold whitespace-nowrap text-warn">
					★ {h.rating.toFixed(1)}
					{h.ratingCount ? <span className="muted">&nbsp;({h.ratingCount})</span> : null}
				</span>
			)}
			{h.priceLevel != null && (
				<span className="text-[0.8rem] font-semibold whitespace-nowrap text-accent-ink">
					{priceStr(h.priceLevel)}
				</span>
			)}
			{hrs && <span className="text-[0.8rem] whitespace-nowrap">{hrs}</span>}
		</p>
	);
}

function useSubmit(run: () => Promise<void>) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState('');
	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setErr('');
		try {
			await run();
		} catch (ex) {
			setErr(ex instanceof ApiError ? ex.message : 'Could not save that.');
		} finally {
			setBusy(false);
		}
	};
	return { submit, busy, err };
}

function FootError({ message }: { message: string }) {
	if (!message) return null;
	return (
		<p role="alert" className="mfoot-note m-0 text-[0.86rem] text-danger-ink">
			{message}
		</p>
	);
}

function AddFromHit({
	hit: h,
	loading,
	onClose,
	onSubmit
}: {
	hit: Hit;
	loading: boolean;
	onClose: () => void;
	onSubmit: (activity: string, notes: string) => Promise<void>;
}) {
	const [activity, setActivity] = useState('');
	const [notes, setNotes] = useState(h.address ?? '');
	const { submit, busy, err } = useSubmit(() => onSubmit(activity.trim(), notes.trim()));

	return (
		<Modal open title={`Add ${h.name}`} size="md" onClose={onClose}>
			<form className="mform" onSubmit={submit}>
				<div className="mbody">
					<HitSummary hit={h} loading={loading} />
					{h.address && (
						<p className="muted mb-3.5 text-[0.85rem] [overflow-wrap:anywhere]">{h.address}</p>
					)}
					<div className="flex flex-col gap-3">
						<label className="field">
							<span>
								Activity <Optional />
							</span>
							<input
								autoFocus
								value={activity}
								onChange={(e) => setActivity(e.target.value)}
								className="input w-full"
							/>
						</label>
						<span className="muted text-[0.75rem] leading-snug">
							Name the activity and it becomes the card title, so one place can appear once per
							thing you will do there.
						</span>
						<label className="field">
							<span>
								Notes <Optional />
							</span>
							<textarea
								rows={3}
								value={notes}
								onChange={(e) => setNotes(e.target.value)}
								className="input w-full resize-y leading-relaxed"
							/>
						</label>
					</div>
				</div>
				<div className="mfoot">
					<FootError message={err} />
					<button className="btn" type="button" onClick={onClose}>
						Cancel
					</button>
					{/* Submitting mid-fetch would save the place without its rating or
					    photo, and nothing backfills a rating later. */}
					<button className="btn primary" type="submit" disabled={loading || busy}>
						{loading ? 'Loading…' : 'Add place'}
					</button>
				</div>
			</form>
		</Modal>
	);
}

function ManualPlace({
	cityName,
	initialName,
	onClose,
	onSubmit
}: {
	cityName: string;
	initialName: string;
	onClose: () => void;
	onSubmit: (v: { name: string; activity: string; url: string; notes: string }) => Promise<void>;
}) {
	const [name, setName] = useState(initialName);
	const [activity, setActivity] = useState('');
	const [url, setUrl] = useState('');
	const [notes, setNotes] = useState('');
	const { submit, busy, err } = useSubmit(() =>
		onSubmit({
			name: name.trim(),
			activity: activity.trim(),
			url: url.trim(),
			notes: notes.trim()
		})
	);

	return (
		<Modal open title={`Add a place in ${cityName}`} size="md" onClose={onClose}>
			<form className="mform" onSubmit={submit}>
				<div className="mbody">
					<div className="flex flex-col gap-3">
						<label className="field">
							<span>Place in {cityName}</span>
							<input
								autoFocus
								required
								value={name}
								onChange={(e) => setName(e.target.value)}
								className="input w-full"
							/>
						</label>
						<div className="flex flex-wrap gap-2.5">
							<label className="field flex-[1_1_180px]">
								<span>
									Activity <Optional />
								</span>
								<input
									value={activity}
									onChange={(e) => setActivity(e.target.value)}
									className="input w-full"
								/>
							</label>
							<label className="field flex-[1_1_180px]">
								<span>
									Link <Optional />
								</span>
								<input
									type="url"
									placeholder="https://"
									value={url}
									onChange={(e) => setUrl(e.target.value)}
									className="input w-full"
								/>
							</label>
						</div>
						<label className="field">
							<span>
								Notes <Optional />
							</span>
							<textarea
								rows={3}
								value={notes}
								onChange={(e) => setNotes(e.target.value)}
								className="input w-full resize-y leading-relaxed"
							/>
						</label>
					</div>
				</div>
				<div className="mfoot">
					<FootError message={err} />
					<button className="btn" type="button" onClick={onClose}>
						Cancel
					</button>
					<button className="btn primary" type="submit" disabled={busy}>
						Add place
					</button>
				</div>
			</form>
		</Modal>
	);
}

function EditPlace({
	poi: p,
	onClose,
	onSubmit
}: {
	poi: Poi;
	onClose: () => void;
	onSubmit: (v: { name: string; notes: string; url: string }) => Promise<void>;
}) {
	const [name, setName] = useState(p.name);
	const [notes, setNotes] = useState(p.notes ?? '');
	const [url, setUrl] = useState(p.url ?? '');
	const { submit, busy, err } = useSubmit(() =>
		onSubmit({ name: name.trim(), notes: notes.trim(), url: url.trim() })
	);

	return (
		<Modal open title="Edit place" size="md" onClose={onClose}>
			<form className="mform" onSubmit={submit}>
				<div className="mbody">
					<div className="flex flex-col gap-3">
						<label className="field">
							<span>Name</span>
							<input
								autoFocus
								required
								value={name}
								onChange={(e) => setName(e.target.value)}
								className="input w-full"
							/>
						</label>
						<label className="field">
							<span>
								Notes <Optional />
							</span>
							<textarea
								rows={3}
								value={notes}
								onChange={(e) => setNotes(e.target.value)}
								className="input w-full resize-y leading-relaxed"
							/>
						</label>
						<label className="field">
							<span>
								Link <Optional />
							</span>
							<input
								type="url"
								placeholder="https://"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								className="input w-full"
							/>
						</label>
					</div>
					{/* Read-only, so it sits after the fields: the count answers "is this
					    popular?", which the card already told you. The names answer "whose
					    evening am I cancelling?", which is why you opened this. Plain prose
					    rather than avatar chips: with a dozen voters the initials repeat
					    and become noise, and there is room here for real names. */}
					<p className="mt-3.5 border-t border-line pt-3.5 text-[0.85rem] leading-normal">
						<span className="font-semibold">{p.votes === 1 ? '1 vote' : `${p.votes} votes`}</span>
						<span className="muted">
							{p.voters.length ? `: ${p.voters.join(', ')}` : ', nobody yet'}
						</span>
					</p>
				</div>
				<div className="mfoot">
					<FootError message={err} />
					<button className="btn" type="button" onClick={onClose}>
						Cancel
					</button>
					<button className="btn primary" type="submit" disabled={busy}>
						Save
					</button>
				</div>
			</form>
		</Modal>
	);
}

function AddStay({
	hit: h,
	cityName,
	loading,
	onClose,
	onSubmit
}: {
	hit: Hit | null;
	cityName: string;
	loading: boolean;
	onClose: () => void;
	onSubmit: (v: {
		name: string;
		tag: string;
		price: string;
		url: string;
		checkIn: string;
		checkOut: string;
	}) => Promise<void>;
}) {
	const [name, setName] = useState(h?.name ?? '');
	const [price, setPrice] = useState('');
	const [tag, setTag] = useState('');
	const [checkIn, setCheckIn] = useState('');
	const [checkOut, setCheckOut] = useState('');
	const [url, setUrl] = useState(h?.url ?? '');
	const { submit, busy, err } = useSubmit(() =>
		onSubmit({
			name: name.trim(),
			tag: tag.trim(),
			price,
			url: url.trim(),
			checkIn,
			checkOut
		})
	);

	// A prefilled name is already right; the price is the one thing the search
	// cannot tell us, so that is where the cursor goes.
	const focusPrice = !!h;

	return (
		<Modal
			open
			title={h ? `Add ${h.name}` : `Add a stay in ${cityName}`}
			size="md"
			onClose={onClose}
		>
			<form className="mform" onSubmit={submit}>
				<div className="mbody">
					{h && (
						<>
							<HitSummary hit={h} loading={loading} />
							{h.address && (
								<p className="muted mb-3.5 text-[0.85rem] [overflow-wrap:anywhere]">{h.address}</p>
							)}
						</>
					)}
					<div className="flex flex-col gap-3">
						<div className="flex flex-wrap gap-2.5">
							<label className="field flex-[1_1_180px]">
								{/* Prefilled from the result but still editable: "Athens Plaka
								    Acropolis Suites" is what Google calls it, not what the group
								    will call it in a vote. */}
								<span>Name</span>
								<input
									autoFocus={!focusPrice}
									required
									value={name}
									onChange={(e) => setName(e.target.value)}
									className="input w-full"
								/>
							</label>
							{/* Wide enough that the label stays on one line: a wrapped label
							    makes this input sit a line lower than the one beside it. */}
							<label className="field flex-[0_1_186px]">
								<span>
									Price / night <Optional />
								</span>
								<input
									autoFocus={focusPrice}
									type="number"
									min="0"
									step="1"
									value={price}
									onChange={(e) => setPrice(e.target.value)}
									className="input w-full"
								/>
							</label>
						</div>
						<div className="flex flex-wrap gap-2.5">
							<label className="field flex-[1_1_180px]">
								<span>
									Tag <Optional />
								</span>
								<input
									value={tag}
									onChange={(e) => setTag(e.target.value)}
									className="input w-full"
								/>
							</label>
							<label className="field flex-[0_1_145px]">
								<span>
									Check in <Optional />
								</span>
								<input
									type="date"
									value={checkIn}
									onChange={(e) => setCheckIn(e.target.value)}
									className="input w-full"
								/>
							</label>
							<label className="field flex-[0_1_145px]">
								<span>
									Check out <Optional />
								</span>
								<input
									type="date"
									value={checkOut}
									onChange={(e) => setCheckOut(e.target.value)}
									className="input w-full"
								/>
							</label>
						</div>
						<label className="field">
							<span>
								Link <Optional />
							</span>
							<input
								type="url"
								placeholder="https://"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								className="input w-full"
							/>
						</label>
					</div>
				</div>
				<div className="mfoot">
					<FootError message={err} />
					<button className="btn" type="button" onClick={onClose}>
						Cancel
					</button>
					<button className="btn primary" type="submit" disabled={loading || busy}>
						{loading ? 'Loading…' : 'Add stay'}
					</button>
				</div>
			</form>
		</Modal>
	);
}

function ConfirmDelete({
	poi: p,
	onClose,
	onConfirm
}: {
	poi: Poi;
	onClose: () => void;
	onConfirm: () => Promise<void>;
}) {
	const { submit, busy } = useSubmit(onConfirm);
	return (
		<Modal open title="Delete this place?" size="sm" onClose={onClose}>
			<form className="mform" onSubmit={submit}>
				<div className="mbody">
					<p className="m-0 mb-2 font-semibold [overflow-wrap:anywhere]">{p.name}</p>
					{p.linked > 0 ? (
						<p role="alert" className="m-0 mb-2 text-[0.9rem] text-warn">
							{p.linked} scheduled {p.linked === 1 ? 'event' : 'events'} on the calendar{' '}
							{p.linked === 1 ? 'is' : 'are'} linked to this place and will be deleted too.
						</p>
					) : (
						<p className="muted m-0 mb-2 text-[0.9rem]">Nothing on the calendar is linked to it.</p>
					)}
					<p className="muted m-0 text-[0.9rem]">This cannot be undone.</p>
				</div>
				<div className="mfoot">
					<button className="btn" type="button" onClick={onClose}>
						Cancel
					</button>
					<button className="btn danger solid" type="submit" disabled={busy}>
						Delete
						{p.linked > 0 ? ` and ${p.linked} event${p.linked === 1 ? '' : 's'}` : ''}
					</button>
				</div>
			</form>
		</Modal>
	);
}
