import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import { parseMoneyToCents } from '../../lib/format';
import Modal from '../../components/ui/Modal';
import FormError from '../../components/ui/FormError';
import { LinkButton } from '../../components/ui/buttons';
import { Field } from '../../components/ui/Field';
import SearchDropdown from '../../components/ui/SearchDropdown';
import type { PlaceHit, PlaceHitDetails } from '../../lib/api-types';
import { HitSummary, MIN_QUERY, hitKey } from './place-meta';
import { LinkField, NotesField, TypeField } from './place-fields';
import { TYPE_OPTIONS, isStayView, type AddType } from './views';
import { copy } from '../../copy';

const c = copy.discover.addDialog;

/** The activity input, refocused after each add. One dialog, so one fixed id. */
const ACTIVITY_ID = 'discover-add-activity';

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
	onClose: () => void;
	/** Reloads the page data and shows the view the new thing landed in. */
	onAdded: (type: AddType) => void;
}) {
	const [view, setView] = useState<AddType>(initialType);
	const [name, setName] = useState('');
	const [activity, setActivity] = useState('');
	const [price, setPrice] = useState('');
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
	/** How many times this place has been added from this popup. */
	const [addedCount, setAddedCount] = useState(0);

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
		const params = new URLSearchParams({
			q,
			cityId: city.id,
			// Stays and places are different searches against different provider
			// filters; one's results never apply to the other.
			kind: stay ? 'stay' : 'place'
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
		setAddedCount(0);
		add.reset();
		clearTimeout(timer.current);
		// Show the progress line from the first keystroke that will actually
		// search rather than once the request is in flight, so it does not only
		// appear after the debounce.
		setSearching(value.trim().length >= MIN_QUERY);
		timer.current = setTimeout(() => runSearch(value.trim()), SEARCH_DEBOUNCE_MS);
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
		setAddedCount(0);
		add.reset();

		if (!h.id || (h.rating !== null && h.photo)) return;
		detailCtl.current?.abort();
		const ctl = new AbortController();
		detailCtl.current = ctl;
		const token = (detailToken.current += 1);
		setDetailLoading(true);
		api<{ details: PlaceHitDetails | null }>(`${base}/details?id=${encodeURIComponent(h.id)}`, {
			signal: ctl.signal
		})
			.then((d) => {
				// Only the newest request may write: an older one landing here would
				// stamp a different place's rating onto the open form.
				if (token !== detailToken.current) return;
				if (!d.details) return;
				const merged = { ...h, ...d.details };
				setHits((xs) => xs.map((x) => (hitKey(x) === hitKey(h) ? merged : x)));
				setHit((v) => (v && hitKey(v) === hitKey(h) ? merged : v));
				setUrl((v) => v || (merged.url ?? ''));
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
			setSearching(false);
		}
		setAddedCount(0);
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
				// A stay is added once. A place can legitimately be added several
				// times, once per activity ("Acropolis" at sunrise and again for the
				// museum), so the popup stays open with the place still filled in and
				// only the activity cleared.
				if (stay) {
					onClose();
					return;
				}
				setAddedCount((n) => n + 1);
				setActivity('');
				// Back to the one field that has to change for the next add. Found by
				// id rather than a ref because the shared `Field` renders the input.
				document.getElementById(ACTIVITY_ID)?.focus();
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
	const busy = add.busy || detailLoading;

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
							<div className="rounded-[10px] border border-accent-soft bg-accent-soft/40 px-3 py-2.5">
								<HitSummary hit={hit} tz={tz} loading={detailLoading} />
								{hit.address && (
									<p className="muted m-0 text-[0.85rem] [overflow-wrap:anywhere]">{hit.address}</p>
								)}
								<LinkButton className="mt-1.5" onClick={unpick}>
									{c.notThisOne}
								</LinkButton>
							</div>
						)}

						{stay ? (
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
						) : (
							<Field
								id={ACTIVITY_ID}
								label={c.activityLabel}
								optional
								value={activity}
								onChange={(e) => setActivity(e.target.value)}
								inputClassName="w-full"
							/>
						)}

						<LinkField value={url} onChange={setUrl} />

						<TypeField options={TYPE_OPTIONS} value={view} onChange={changeView} />

						<NotesField value={notes} onChange={setNotes} />
					</div>
				</div>
				<div className="mfoot">
					<FormError message={add.error} />
					{!add.error && addedCount > 0 && (
						<FormError tone="success" message={c.added(addedCount)} />
					)}
					<button className="btn" type="button" onClick={onClose}>
						{c.close}
					</button>
					{/* Submitting mid-fetch would save the place without its rating or
					    photo, and nothing backfills a rating later. */}
					<button className="btn primary" type="submit" disabled={busy}>
						{detailLoading ? c.busyLabel : c.submit}
					</button>
				</div>
			</form>
		</Modal>
	);
}
