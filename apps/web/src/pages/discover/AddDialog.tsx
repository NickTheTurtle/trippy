import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { useMutation } from '../../useMutation';
import { parseMoneyToCents } from '../../format';
import Modal from '../../components/Modal';
import FormError from '../../components/FormError';
import { LinkButton } from '../../components/buttons';
import { Field } from '../../components/Field';
import type { PlaceHit, PlaceHitDetails } from '../../api-types';
import { HitSummary, MIN_QUERY, hitKey } from './place-meta';
import { LinkField, NotesField, TypeField } from './place-fields';
import { VIEW_OPTIONS, isStayView, type DiscoverView } from './views';

/** The activity input, refocused after each add. One dialog, so one fixed id. */
const ACTIVITY_ID = 'discover-add-activity';

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
	currency,
	provider,
	initialView,
	onClose,
	onAdded
}: {
	/** `/trips/:tripId/discover`. */
	base: string;
	city: { id: string; name: string };
	/** The city's IANA zone, for the opening-hours line on a result. */
	tz: string;
	/** Trip home currency, which a nightly price is denominated in. */
	currency: string;
	provider: 'google' | 'osm';
	initialView: DiscoverView;
	onClose: () => void;
	/** Reloads the page data and shows the view the new thing landed in. */
	onAdded: (view: DiscoverView) => void;
}) {
	const [view, setView] = useState<DiscoverView>(initialView);
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
	const providerLabel = provider === 'google' ? 'Google Maps' : 'OpenStreetMap';

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
		timer.current = setTimeout(() => runSearch(value.trim()), 350);
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
		const v = next as DiscoverView;
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
			fallback: 'Could not add that.',
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
			add.setError('Enter the nightly price as a number, or leave it blank.');
			return;
		}
		void add.run(cents);
	}

	const query = name.trim();
	const showList = listOpen && query.length > 0;
	const busy = add.busy || detailLoading;

	return (
		<Modal open title={`Add to ${city.name}`} size="md" onClose={onClose}>
			<form className="mform" onSubmit={submit}>
				<div className="mbody">
					<div className="flex flex-col gap-3">
						<Field
							label="Name"
							hint={`Type to search ${stay ? 'hotels and rentals' : 'places'} in ${city.name}, or just write the name.`}
							autoFocus
							required
							value={name}
							onChange={(e) => onNameChange(e.target.value)}
							inputClassName="w-full"
						/>

						{showList && (
							<div className="rounded-[10px] border border-line bg-surface-2 p-1.5">
								<ul className="m-0 flex list-none flex-col p-0">
									{/* Capped rather than scrolled: `.mbody` is the dialog's one
									    scrolling region, and a second one nested inside it is
									    what makes a modal scroll in two places at once. */}
									{hits.slice(0, 6).map((h) => (
										<li key={hitKey(h)}>
											{/* The whole row is the control: a small "Add" button
											    beside a rich result makes the target far smaller than
											    the thing it acts on. */}
											<button
												type="button"
												onClick={() => pick(h)}
												className="flex w-full cursor-pointer flex-col gap-0.5 rounded-md border-none bg-transparent px-2 py-2 text-left hover:bg-surface"
											>
												<span className="font-medium [overflow-wrap:anywhere]">{h.name}</span>
												{h.address && (
													<span className="muted line-clamp-1 text-[0.8rem]">{h.address}</span>
												)}
											</button>
										</li>
									))}
									{hits.length === 0 && (
										<li className="muted px-2 py-2 text-[0.85rem] [overflow-wrap:anywhere]">
											{query.length < MIN_QUERY
												? 'Keep typing to search.'
												: searching
													? 'Searching...'
													: searched
														? `No ${stay ? 'stays' : 'matches'} for "${query}". Add it by hand instead.`
														: 'Keep typing to search.'}
										</li>
									)}
								</ul>
								{/* The attribution has to sit with the data it describes. */}
								<p className="m-0 px-2 pt-1 text-right text-[0.68rem] text-ink-faint">
									Powered by {providerLabel}
								</p>
							</div>
						)}

						{hit && (
							<div className="rounded-[10px] border border-accent-soft bg-accent-soft/40 px-3 py-2.5">
								<HitSummary hit={hit} tz={tz} loading={detailLoading} />
								{hit.address && (
									<p className="muted m-0 text-[0.85rem] [overflow-wrap:anywhere]">{hit.address}</p>
								)}
								<LinkButton className="mt-1.5" onClick={unpick}>
									Not this one
								</LinkButton>
							</div>
						)}

						{stay ? (
							<Field
								label="Price / night"
								optional
								hint={`Per night, in ${currency}. Leave it blank if it is not priced yet.`}
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
								label="Activity"
								optional
								hint="Name the activity and it becomes the card title, so one place can appear once per thing you will do there."
								value={activity}
								onChange={(e) => setActivity(e.target.value)}
								inputClassName="w-full"
							/>
						)}

						<LinkField value={url} onChange={setUrl} />

						<TypeField options={VIEW_OPTIONS} value={view} onChange={changeView} />

						<NotesField value={notes} onChange={setNotes} />
					</div>
				</div>
				<div className="mfoot">
					<FormError message={add.error} />
					{!add.error && addedCount > 0 && (
						<FormError
							tone="success"
							message={`Added${addedCount > 1 ? ` \u00d7${addedCount}` : ''}. Add another activity for the same place, or close.`}
						/>
					)}
					<button className="btn" type="button" onClick={onClose}>
						Close
					</button>
					{/* Submitting mid-fetch would save the place without its rating or
					    photo, and nothing backfills a rating later. */}
					<button className="btn primary" type="submit" disabled={busy}>
						{detailLoading ? 'Loading...' : stay ? 'Add stay' : 'Add place'}
					</button>
				</div>
			</form>
		</Modal>
	);
}
