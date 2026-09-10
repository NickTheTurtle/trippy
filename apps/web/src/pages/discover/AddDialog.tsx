import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import { parseMoneyToCents } from '../../lib/format';
import Modal, { ModalFooter } from '../../components/ui/Modal';
import { LinkButton } from '../../components/ui/buttons';
import { Field, FieldShell } from '../../components/ui/Field';
import Select from '../../components/ui/Select';
import { currencyOptions } from '../../lib/currencies';
import SearchDropdown from '../../components/ui/SearchDropdown';
import Cover from '../../components/Cover';
import type { PlaceHit, PlaceHitDetails } from '../../lib/api-types';
import { HitSummary, MIN_QUERY, hitKey } from './place-meta';
import { LinkField, NotesField, TypeField } from './place-fields';
import { TYPE_OPTIONS, isStayView, STAY_VIEW, type AddType } from './views';
import { isStayCategory, poiKindFromCategory } from '@trippy/core/types';
import { copy } from '../../copy';

const c = copy.discover.addDialog;

/**
 * How long typing must pause before the search is sent.
 *
 * Every send is a billed provider request, so this is a price as much as a
 * feel. At 350ms a normal typist paid for two or three prefixes of the word
 * they were halfway through writing; 600ms is still under the pause you make
 * when you stop to look at a screen, and it usually buys one search per word
 * instead of three.
 */
const SEARCH_DEBOUNCE_MS = 600;

/**
 * Identifies one search session: everything typed up to the moment a result is
 * picked. Provider suggestions made under a session that ends in a details
 * lookup are not billed, so this token is what makes typing free. `randomUUID`
 * needs a secure context, which the app has, but the fallback keeps a plain-http
 * dev box working rather than throwing halfway through a keystroke.
 */
function newSessionToken(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
	return `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Merges a details response over the result it belongs to.
 *
 * Not a plain spread: a suggestion knows its name and address and the details
 * call may not have answered with either, and `{...hit, ...details}` would
 * write those `undefined`s straight over the good values.
 */
function withDetails(h: PlaceHit, d: PlaceHitDetails): PlaceHit {
	return {
		...h,
		...d,
		name: d.name ?? h.name,
		address: d.address ?? h.address,
		category: d.category || h.category,
		lat: d.lat ?? h.lat,
		lng: d.lng ?? h.lng
	};
}

/**
 * The one way anything gets added on this page.
 *
 * The header used to carry a search box whose dropdown had an "Add manually"
 * escape hatch at the bottom, and that hatch opened a second, near-identical
 * form. Two forms for one intent meant the manual path was a fallback you had
 * to discover, and a found place and a typed place were filled in differently.
 * There is now one popup, and the Name field *is* the search: type and results
 * appear under it, pick one and it fills the name and everything the provider
 * knows, or ignore them and submit what you typed.
 *
 * Type is a field in the form rather than a mode chosen before it opens, so
 * "actually this is a hotel" costs one dropdown instead of closing, switching
 * view and retyping. When it is Stays the lower half swaps: a nightly price
 * replaces the activity, and the submit goes to the stays endpoint.
 */
export default function AddDialog({
	base,
	city,
	tz,
	provider,
	initialType,
	currency,
	currencies,
	onClose,
	onAdded
}: {
	/** `/trips/:tripId/discover`. */
	base: string;
	city: { id: string; name: string };
	/** The city's IANA zone, for the opening-hours line on a result. */
	tz: string;
	provider: 'google' | 'osm';
	initialType: AddType;
	/** The trip's home currency, which a stay's price defaults to. */
	currency: string;
	currencies: string[];
	onClose: () => void;
	/** Reloads the page data and shows the view the new thing landed in. */
	onAdded: (type: AddType) => void;
}) {
	const [view, setView] = useState<AddType>(initialType);
	const [name, setName] = useState('');
	const [activity, setActivity] = useState('');
	const [price, setPrice] = useState('');
	const [cur, setCur] = useState(currency);
	const [url, setUrl] = useState('');
	const [notes, setNotes] = useState('');

	/** The provider result the fields were filled from, if any. */
	const [hit, setHit] = useState<PlaceHit | null>(null);
	const [hits, setHits] = useState<PlaceHit[]>([]);
	const [searching, setSearching] = useState(false);
	const [searched, setSearched] = useState(false);
	/** Closed by picking a result, reopened by typing. */
	const [listOpen, setListOpen] = useState(false);
	/** True while the picked result's ratings, hours and photo are loading. */
	const [detailLoading, setDetailLoading] = useState(false);

	const stay = isStayView(view);
	const providerLabel = provider === 'google' ? c.providerGoogle : c.providerOsm;

	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	/** Lets a new search cancel the one before it. */
	const searchCtl = useRef<AbortController | undefined>(undefined);
	/**
	 * The details request currently allowed to write state. A token as well as
	 * an abort, because the popup can move on to another result (or be closed)
	 * while a slow response is still on its way: without it, that response
	 * cleared the loading flag belonging to a newer request and could overwrite
	 * the newer result's fields.
	 */
	const detailCtl = useRef<AbortController | undefined>(undefined);
	const detailToken = useRef(0);
	/**
	 * The current search session, started by the first search after a pick.
	 * Held until the pick's details call spends it, since a spent token cannot
	 * be reused.
	 */
	const session = useRef<string | undefined>(undefined);
	/**
	 * Whether the member has set the type themselves. Once they have, a picked
	 * result never overrules it: they know a bakery is a breakfast stop.
	 */
	const typeChosen = useRef(false);

	// Nothing in flight may outlive the popup.
	useEffect(
		() => () => {
			clearTimeout(timer.current);
			searchCtl.current?.abort();
			detailCtl.current?.abort();
			detailToken.current += 1;
		},
		[]
	);

	function runSearch(q: string) {
		if (q.length < MIN_QUERY) {
			setHits([]);
			setSearched(false);
			setSearching(false);
			return;
		}
		// Without this a slow early request can land after a later one and
		// replace good results with stale ones: "acr" overwriting "acropolis".
		searchCtl.current?.abort();
		const ctl = new AbortController();
		searchCtl.current = ctl;
		setSearching(true);
		session.current ??= newSessionToken();
		const params = new URLSearchParams({
			q,
			cityId: city.id,
			// Stays and places are different searches against different provider
			// filters; one's results never apply to the other.
			kind: stay ? 'stay' : 'place',
			token: session.current
		});
		api<{ results: PlaceHit[] }>(`${base}/search?${params}`, { signal: ctl.signal })
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
				if (searchCtl.current === ctl) {
					searchCtl.current = undefined;
					setSearching(false);
				}
			});
	}

	function onNameChange(value: string) {
		setName(value);
		setListOpen(true);
		add.reset();
		clearTimeout(timer.current);
		// Show the progress line from the first keystroke that will actually
		// search rather than once the request is in flight, so it does not only
		// appear after the debounce.
		setSearching(value.trim().length >= MIN_QUERY);
		timer.current = setTimeout(() => runSearch(value.trim()), SEARCH_DEBOUNCE_MS);
	}

	/**
	 * Sets the type from what the provider says the place is.
	 *
	 * The type used to be whichever view the popup was opened from and nothing
	 * else, so a ramen bar added from All was filed as an attraction. A member's
	 * own choice still wins, and so does a category we cannot read.
	 */
	function inferType(category: string | null | undefined) {
		const c = (category ?? '').trim();
		if (typeChosen.current || !c) return;
		setView(isStayCategory(c) ? STAY_VIEW : poiKindFromCategory(c));
	}

	/** Fills the form from a result, and fetches what the search left out. */
	function pick(h: PlaceHit) {
		clearTimeout(timer.current);
		searchCtl.current?.abort();
		searchCtl.current = undefined;
		setSearching(false);
		setHit(h);
		setName(h.name);
		setUrl(h.url ?? '');
		setNotes((v) => v || (stay ? '' : (h.address ?? '')));
		setListOpen(false);
		add.reset();
		// A suggestion has no category yet; the details response below carries it.
		inferType(h.category);

		// A pick ends the search session whether or not it needs a lookup: the
		// token is spent by the request below, and the next thing typed is a new
		// search that must start its own.
		const sessionId = session.current;
		session.current = undefined;

		if (!h.id || (h.rating !== null && h.photo)) return;
		detailCtl.current?.abort();
		const ctl = new AbortController();
		detailCtl.current = ctl;
		const token = (detailToken.current += 1);
		setDetailLoading(true);
		const params = new URLSearchParams({ id: h.id });
		if (sessionId) params.set('token', sessionId);
		api<{ details: PlaceHitDetails | null }>(`${base}/details?${params}`, {
			signal: ctl.signal
		})
			.then((d) => {
				// Only the newest request may write: an older one landing here would
				// stamp a different place's rating onto the open form.
				if (token !== detailToken.current) return;
				if (!d.details) return;
				const merged = withDetails(h, d.details);
				setHits((xs) => xs.map((x) => (hitKey(x) === hitKey(h) ? merged : x)));
				setHit((v) => (v && hitKey(v) === hitKey(h) ? merged : v));
				setUrl((v) => v || (merged.url ?? ''));
				// A suggestion arrives without an address, so the notes line that
				// would have been prefilled from one could not be. Fill it now, and
				// only if the field is still untouched.
				setNotes((v) => v || (stay ? '' : (merged.address ?? '')));
				inferType(merged.category);
			})
			.catch(() => {})
			.finally(() => {
				if (token === detailToken.current) setDetailLoading(false);
			});
	}

	/** Detaches the provider data, leaving whatever is typed as a manual entry. */
	function unpick() {
		detailToken.current += 1;
		detailCtl.current?.abort();
		setDetailLoading(false);
		setHit(null);
	}

	function changeView(next: string) {
		const v = next as AddType;
		// Set by hand, so a later result must not quietly change it back.
		typeChosen.current = true;
		if (isStayView(v) !== stay) {
			// A hotel is not a place and a place is not a hotel: the results and
			// anything filled in from them do not survive the switch.
			unpick();
			setHits([]);
			setSearched(false);
			setListOpen(false);
			clearTimeout(timer.current);
			searchCtl.current?.abort();
			searchCtl.current = undefined;
			session.current = undefined;
			setSearching(false);
		}
		setView(v);
	}

	const add = useMutation<[number | null]>(
		async (cents) => {
			if (stay) {
				await api(`${base}/stays`, {
					method: 'POST',
					body: {
						cityId: city.id,
						name: name.trim(),
						priceCents: cents,
						currency: cur,
						// The one free-text line a stay carries.
						notes: notes.trim(),
						url: url.trim(),
						// Carried straight from the result when there was one. A stay
						// typed by hand gets its photo from the backfill on the next load.
						photo: hit?.photo ?? null
					}
				});
				return;
			}
			await api(`${base}/pois`, {
				method: 'POST',
				body: {
					cityId: city.id,
					name: name.trim(),
					activity: activity.trim(),
					// Left to the provider's own word for the venue; the bucket that
					// actually gets filtered on is `kind`, sent right below it.
					category: hit?.category ?? '',
					kind: view,
					notes: notes.trim(),
					url: url.trim(),
					photo: hit?.photo ?? null,
					lat: hit?.lat ?? null,
					lng: hit?.lng ?? null,
					rating: hit?.rating ?? null,
					ratingCount: hit?.ratingCount ?? null,
					priceLevel: hit?.priceLevel ?? null,
					hours: hit?.hours ?? null
				}
			});
		},
		{
			fallback: c.fallback,
			onSuccess: () => {
				onAdded(view);
				onClose();
			}
		}
	);

	function submit(e: FormEvent) {
		e.preventDefault();
		if (!stay) {
			void add.run(null);
			return;
		}
		const cents = parseMoneyToCents(price);
		if (cents === 'bad') {
			add.setError(c.badPrice);
			return;
		}
		void add.run(cents);
	}

	const query = name.trim();

	return (
		<Modal open title={c.title(city.name)} size="md" onClose={onClose}>
			<form className="mform" onSubmit={submit}>
				<div className="mbody">
					<div className="flex flex-col gap-3">
						{/* The Name field *is* the search: the results hang off it as an
						    overlay, so a lookup never moves the fields below it. Capped at
						    six rather than scrolled, as it was in flow; the dropdown only
						    scrolls when the window is too short for six. */}
						<SearchDropdown
							label={c.nameLabel}
							autoFocus
							required
							value={name}
							onChange={onNameChange}
							open={listOpen}
							onOpenChange={setListOpen}
							busy={searching}
							items={hits.slice(0, 6)}
							itemKey={hitKey}
							onPick={pick}
							renderItem={(h) => (
								<>
									<span className="font-medium">{h.name}</span>
									{h.address && (
										<span className="muted line-clamp-1 text-[0.8rem]">{h.address}</span>
									)}
								</>
							)}
							empty={
								query.length < MIN_QUERY
									? c.keepTyping
									: searching
										? c.searching
										: searched
											? c.noMatches(query)
											: c.keepTyping
							}
							footer={
								/* The attribution has to sit with the data it describes. */
								<p className="m-0 px-2 pt-1 text-right text-[0.68rem] text-ink-faint">
									{c.attribution(providerLabel)}
								</p>
							}
						/>

						{hit && (
							/* Confirmation that the right place was picked, and nothing more.
							   This was a tinted panel repeating the address that is already
							   prefilled into Notes below; the picture is the part that
							   actually tells you at a glance whether this is the museum you
							   meant. */
							<div className="flex items-center gap-2.5">
								<div className="w-16 shrink-0 overflow-hidden rounded-lg">
									<Cover photo={hit.photo} seed={hit.name} category={hit.category} height="44px" />
								</div>
								<div className="min-w-0 flex-1">
									<HitSummary hit={hit} tz={tz} loading={detailLoading} />
								</div>
								<LinkButton onClick={unpick}>{c.notThisOne}</LinkButton>
							</div>
						)}

						{stay ? (
							<div className="grid grid-cols-2 gap-3">
								<Field
									label={c.priceLabel}
									optional
									type="number"
									min="0"
									step="1"
									value={price}
									onChange={(e) => setPrice(e.target.value)}
									inputClassName="w-full"
								/>
								<FieldShell label={c.currencyLabel}>
									<Select
										options={currencyOptions(currencies)}
										value={cur}
										onChange={setCur}
										ariaLabel={c.currencyLabel}
									/>
								</FieldShell>
							</div>
						) : (
							<Field
								label={c.activityLabel}
								optional
								value={activity}
								onChange={(e) => setActivity(e.target.value)}
								inputClassName="w-full"
							/>
						)}

						<TypeField options={TYPE_OPTIONS} value={view} onChange={changeView} />

						<LinkField value={url} onChange={setUrl} />

						<NotesField value={notes} onChange={setNotes} />
					</div>
				</div>
				{/* Submitting mid-fetch would save the place without its rating or
				    photo, and nothing backfills a rating later. */}
				<ModalFooter
					error={add.error}
					onClose={onClose}
					busy={detailLoading}
					disabled={add.busy}
					busyLabel={c.busyLabel}
					submitLabel={c.submit}
				/>
			</form>
		</Modal>
	);
}
