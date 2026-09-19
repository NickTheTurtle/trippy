import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useToast } from '../../components/ui/Toast';
import { copy } from '../../copy';
import { MIN_QUERY } from '../discover/place-meta';
import { SEARCH_DEBOUNCE_MS, newSessionToken, withDetails } from '../discover/place-search';
import { poiKindFor } from './shared';
import type { PlaceHit, PlaceHitDetails } from '../../lib/api-types';
import type { Cell, SavedPoi } from './types';
import type { EventType } from '@trippy/core/types';

/**
 * Places the provider search added while a dialog was open.
 *
 * They are real saved places, but the board handed this dialog its list before
 * they existed, so the field would not offer what the reader just created until
 * the whole page reloaded. Kept here instead, and merged in front of the saved
 * list: the newest thing is the thing being looked for.
 */
export function useFoundPlaces() {
	const [found, setFound] = useState<{ places: SavedPoi[]; stays: SavedPoi[] }>({
		places: [],
		stays: []
	});
	const keep = (place: SavedPoi, stay: boolean) =>
		setFound((v) =>
			stay ? { ...v, stays: [place, ...v.stays] } : { ...v, places: [place, ...v.places] }
		);
	return { found, keep };
}

/**
 * The provider search behind the schedule's place field.
 *
 * The field offers what the trip has already saved and keeps a name that
 * matches none of it, but a name kept as typed is only a name: no coordinates,
 * no pin, no travel time. This is the way out of that. Typing in the box
 * searches the provider as well as the shortlist, and the results land under
 * the saved places in the same list, so finding somewhere new is the same
 * gesture as picking somewhere known rather than a second dialog to open.
 *
 * It is not a second Discover search. The debounce, the session token and the
 * details merge are shared with Discover's add popup (`place-search.ts`),
 * because those are the parts that cost money to get wrong, and the request
 * goes to the same endpoint under the same quota.
 *
 * Picking a result creates a real saved place, listed in Discover like any
 * other. That is the honest outcome: the group is not looking up a restaurant
 * in order to forget it, and a calendar-only copy would have been a second
 * Discover with none of its features.
 */
export function usePlaceSearch({
	base,
	city,
	type
}: {
	/** The schedule's own base, `/trips/:tripId/schedule`. */
	base: string;
	/** The day's city. The search is biased to it, so without one there is none. */
	city: Cell | null;
	/** The block's type, which decides whether this is looking for a stay. */
	type: EventType;
}) {
	const discover = base.replace(/\/schedule$/, '/discover');
	const stay = type === 'stay';

	const [hits, setHits] = useState<PlaceHit[]>([]);
	const [searching, setSearching] = useState(false);
	const [searched, setSearched] = useState(false);

	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	/** Lets a new search cancel the one before it. */
	const ctl = useRef<AbortController | undefined>(undefined);
	/** Held until a pick spends it on a details lookup, which is what makes typing free. */
	const session = useRef<string | undefined>(undefined);

	// Nothing in flight may outlive the dialog.
	useEffect(
		() => () => {
			clearTimeout(timer.current);
			ctl.current?.abort();
		},
		[]
	);

	function stop() {
		clearTimeout(timer.current);
		ctl.current?.abort();
		ctl.current = undefined;
		setSearching(false);
	}

	/** Drops the results and the session with them. */
	function clear() {
		stop();
		setHits([]);
		setSearched(false);
		session.current = undefined;
	}

	/* Stays and places are different searches against different provider
	   filters, so one's results never apply to the other: switching the block's
	   type throws away what was found under the old one. */
	const wasStay = useRef(stay);
	useEffect(() => {
		if (wasStay.current === stay) return;
		wasStay.current = stay;
		clear();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [stay]);

	function run(q: string) {
		if (!city || q.length < MIN_QUERY) {
			clear();
			return;
		}
		// Without this a slow early request can land after a later one and
		// replace good results with stale ones: "acr" overwriting "acropolis".
		ctl.current?.abort();
		const own = new AbortController();
		ctl.current = own;
		setSearching(true);
		session.current ??= newSessionToken();
		const params = new URLSearchParams({
			q,
			cityId: city.id,
			kind: stay ? 'stay' : 'place',
			token: session.current
		});
		api<{ results: PlaceHit[] }>(`${discover}/search?${params}`, { signal: own.signal })
			.then((d) => {
				setHits(d.results ?? []);
				setSearched(true);
			})
			.catch(() => {
				if (own.signal.aborted) return;
				setHits([]);
				setSearched(true);
			})
			.finally(() => {
				if (ctl.current !== own) return;
				ctl.current = undefined;
				setSearching(false);
			});
	}

	/** Call on every keystroke. Sends at most one request per pause in typing. */
	function query(raw: string) {
		const q = raw.trim();
		clearTimeout(timer.current);
		if (!city || q.length < MIN_QUERY) {
			// Not "no matches": nothing was asked, so there is nothing to report.
			stop();
			setHits([]);
			setSearched(false);
			return;
		}
		// Shown from the first keystroke that will actually search, rather than
		// once the request is in flight, so the line does not only appear after
		// the debounce has already passed.
		setSearching(true);
		timer.current = setTimeout(() => run(q), SEARCH_DEBOUNCE_MS);
	}

	/**
	 * Turns a result into a saved place the block can point at.
	 *
	 * The details lookup is not optional here. A Google suggestion carries a
	 * name and an address and nothing else, and coordinates are the entire
	 * reason for searching from the calendar: without them the new place is no
	 * better than the name that was typed. It also spends the session token,
	 * which is what keeps everything typed up to this point unbilled.
	 *
	 * The new place is filed as the kind of thing the block is using it for. A
	 * restaurant found from a Food & Drinks block is food; the same restaurant
	 * found from an Activity block is an attraction, because that is what the
	 * group is doing there, and it is also the only bucket the block's own
	 * picker offers.
	 */
	async function adopt(hit: PlaceHit): Promise<SavedPoi> {
		if (!city) throw new Error('No city to add to.');
		stop();

		const spent = session.current;
		session.current = undefined;

		let full = hit;
		if (hit.id) {
			const params = new URLSearchParams({ id: hit.id });
			if (spent) params.set('token', spent);
			try {
				const d = await api<{ details: PlaceHitDetails | null }>(`${discover}/details?${params}`);
				if (d.details) full = withDetails(hit, d.details);
			} catch {
				// A lookup that failed costs the extras, not the place: the name and
				// whatever the suggestion already carried are still worth saving.
			}
		}

		const made = await api<{ id: string }>(`${discover}/${stay ? 'stays' : 'pois'}`, {
			method: 'POST',
			body: stay
				? {
						cityId: city.id,
						name: full.name,
						// Blank: the server falls back to the trip's home currency, and a
						// stay found this way has no price until somebody types one.
						currency: '',
						url: full.url ?? '',
						photo: full.photo ?? null,
						lat: full.lat ?? null,
						lng: full.lng ?? null
					}
				: {
						cityId: city.id,
						name: full.name,
						activity: '',
						category: full.category ?? '',
						kind: poiKindFor(type) ?? undefined,
						notes: full.address ?? '',
						url: full.url ?? '',
						photo: full.photo ?? null,
						lat: full.lat ?? null,
						lng: full.lng ?? null,
						rating: full.rating ?? null,
						ratingCount: full.ratingCount ?? null,
						priceLevel: full.priceLevel ?? null,
						hours: full.hours ?? null
					}
		});

		clear();
		return {
			id: made.id,
			name: full.name,
			city_id: city.id,
			lat: full.lat ?? null,
			lng: full.lng ?? null,
			votes: 0,
			kind: stay ? undefined : (poiKindFor(type) ?? undefined)
		};
	}

	return { hits, searching, searched, query, clear, adopt, enabled: !!city };
}

/**
 * The whole of the place field's search, as the two event dialogs need it.
 *
 * They ask the same question of the same board and differ only in what they do
 * with the answer, so the search, the results, the save and the toast that
 * reports a failed save live here rather than twice over in two forms that
 * would drift.
 */
export function usePlaceLookup({
	base,
	city,
	type,
	provider,
	onPicked
}: {
	base: string;
	city: Cell | null;
	type: EventType;
	/** Who is answering, for the attribution line. Absent until the board has loaded. */
	provider?: 'google' | 'osm';
	/** The saved place a result became, ready for the field to point at. */
	onPicked: (place: SavedPoi, stay: boolean) => void;
}) {
	const search = usePlaceSearch({ base, city, type });
	const { found, keep } = useFoundPlaces();
	const [adopting, setAdopting] = useState(false);
	const toast = useToast();
	const stay = type === 'stay';

	async function pickHit(hit: PlaceHit) {
		setAdopting(true);
		try {
			const made = await search.adopt(hit);
			keep(made, stay);
			onPicked(made, stay);
		} catch (e) {
			// The name the result put in the box stays behind, so a failed save
			// leaves the block named rather than empty.
			toast.error(e instanceof Error ? e.message : 'Could not save that place.');
		} finally {
			setAdopting(false);
		}
	}

	return {
		found,
		/** Call with every keystroke in the field. */
		onTyped: search.query,
		/** Spread onto `PlaceField`. */
		fieldProps: {
			hits: search.hits,
			searching: search.searching,
			searched: search.searched,
			busy: adopting,
			onPickHit: search.enabled ? pickHit : undefined,
			attribution: provider
				? copy.discover.addDialog.attribution(
						provider === 'google'
							? copy.discover.addDialog.providerGoogle
							: copy.discover.addDialog.providerOsm
					)
				: undefined
		}
	};
}
