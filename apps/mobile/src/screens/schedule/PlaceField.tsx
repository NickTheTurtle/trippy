import { useEffect, useMemo, useRef, useState } from 'react';
import { copy } from '@trippy/copy';
import { isLocatedType, type EventType } from '@trippy/core/types';
import type { PlaceHit, PlaceHitDetails } from '../../lib/api-types';
import { api } from '../../lib/api';
import { Field, InsetSection, ListRow } from '../../ui';
import { useToast } from '../../ui/Toast';
import { keepsPick, placeLabel, placeOptions, poiKindFor } from './shared';
import type { Cell, SavedPoi } from './types';

const MIN_QUERY = 3;
const SEARCH_DEBOUNCE_MS = 600;

export type PlaceDraft = {
	poi: string;
	place: string;
	spot: SavedPoi | null;
	placeable: boolean;
	field: React.ReactNode;
	retype: (next: EventType) => void;
};

function newSessionToken(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
	return `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function withDetails(hit: PlaceHit, details: PlaceHitDetails): PlaceHit {
	return {
		...hit,
		...details,
		name: details.name ?? hit.name,
		address: details.address ?? hit.address,
		category: details.category || hit.category,
		lat: details.lat ?? hit.lat,
		lng: details.lng ?? hit.lng
	};
}

export function usePlaceField({
	base,
	type: eventType,
	cities,
	cityId,
	saved,
	stays,
	initialPoi = '',
	initialPlace = '',
	readonly = false
}: {
	base: string;
	type: EventType;
	cities: (Cell | null)[];
	cityId: string | null;
	saved: SavedPoi[];
	stays: SavedPoi[];
	initialPoi?: string;
	initialPlace?: string;
	readonly?: boolean;
}): PlaceDraft {
	const [poi, setPoi] = useState(initialPoi);
	const [place, setPlace] = useState(initialPlace);
	const [found, setFound] = useState<{ places: SavedPoi[]; stays: SavedPoi[] }>({
		places: [],
		stays: []
	});
	const [hits, setHits] = useState<PlaceHit[]>([]);
	const [searching, setSearching] = useState(false);
	const [searched, setSearched] = useState(false);
	const [savingHit, setSavingHit] = useState(false);
	const [editing, setEditing] = useState(false);
	const typed = useRef(false);
	const abort = useRef<AbortController | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const session = useRef<string | null>(null);
	const toast = useToast();
	const placeable = isLocatedType(eventType);
	const staying = eventType === 'stay';
	const city = cities.find((c): c is Cell => c?.id === cityId) ?? null;
	const pickable = staying ? [...found.stays, ...stays] : [...found.places, ...saved];
	const spot = placeable ? (pickable.find((p) => p.id === poi) ?? null) : null;

	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
			abort.current?.abort();
		},
		[]
	);

	const options = useMemo(
		() => placeOptions(pickable, cities, cityId, eventType),
		[pickable, cities, cityId, eventType]
	);

	function clearSearch() {
		if (timer.current) clearTimeout(timer.current);
		abort.current?.abort();
		abort.current = null;
		setSearching(false);
		setSearched(false);
		setHits([]);
		session.current = null;
	}

	function onTyped(text: string) {
		setPlace(text);
		setPoi('');
		typed.current = true;
		if (!city || text.trim().length < MIN_QUERY) {
			clearSearch();
			return;
		}
		if (timer.current) clearTimeout(timer.current);
		setSearching(true);
		timer.current = setTimeout(() => {
			abort.current?.abort();
			const ac = new AbortController();
			abort.current = ac;
			const discover = base.replace(/\/schedule$/, '/discover');
			session.current ??= newSessionToken();
			const params = new URLSearchParams({
				q: text.trim(),
				cityId: city.id,
				kind: staying ? 'stay' : 'place',
				token: session.current
			});
			api<{ results: PlaceHit[] }>(`${discover}/search?${params}`, { signal: ac.signal })
				.then((r) => {
					setHits(r.results ?? []);
					setSearched(true);
				})
				.catch(() => {
					if (!ac.signal.aborted) {
						setHits([]);
						setSearched(true);
					}
				})
				.finally(() => {
					if (abort.current === ac) {
						abort.current = null;
						setSearching(false);
					}
				});
		}, SEARCH_DEBOUNCE_MS);
	}

	async function adopt(hit: PlaceHit) {
		if (!city || savingHit) return;
		setPlace(hit.name);
		setPoi('');
		setSavingHit(true);
		try {
			const discover = base.replace(/\/schedule$/, '/discover');
			const spent = session.current;
			session.current = null;
			let full = hit;
			if (hit.id) {
				const params = new URLSearchParams({ id: hit.id });
				if (spent) params.set('token', spent);
				try {
					const detail = await api<{ details: PlaceHitDetails | null }>(
						`${discover}/details?${params}`
					);
					if (detail.details) full = withDetails(hit, detail.details);
				} catch {
					// The suggestion still has a name, so it can still be saved.
				}
			}
			const made = await api<{ id: string }>(`${discover}/${staying ? 'stays' : 'pois'}`, {
				method: 'POST',
				body: staying
					? {
							cityId: city.id,
							name: full.name,
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
							kind: poiKindFor(eventType) ?? undefined,
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
			const savedPlace: SavedPoi = {
				id: made.id,
				name: full.name,
				city_id: city.id,
				lat: full.lat ?? null,
				lng: full.lng ?? null,
				votes: 0,
				kind: staying ? undefined : (poiKindFor(eventType) ?? undefined)
			};
			setFound((old) =>
				staying
					? { ...old, stays: [savedPlace, ...old.stays] }
					: { ...old, places: [savedPlace, ...old.places] }
			);
			setPoi(made.id);
			clearSearch();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : copy.discover.addDialog.fallback);
		} finally {
			setSavingHit(false);
		}
	}

	const retype = (next: EventType) => {
		if (keepsPick(eventType, next, spot)) return;
		setPoi('');
		setPlace('');
		clearSearch();
	};

	const shownOptions =
		typed.current && place.trim()
			? options.filter((o) => o.label.toLowerCase().includes(place.trim().toLowerCase()))
			: options;

	const field = !placeable ? null : (
		<>
			<InsetSection
				footer={
					editing && typed.current && place.trim().length > 0
						? searching || savingHit
							? copy.schedule.placeSearch.searching
							: place.trim().length < MIN_QUERY
								? copy.schedule.placeSearch.keepTyping
								: searched && hits.length === 0
									? copy.schedule.placeSearch.nothingFound
									: copy.schedule.placeSearch.noMatch
						: undefined
				}
			>
				<ListRow
					title={copy.schedule.fields.place}
					value={(spot?.name ?? place.trim()) || copy.common.none}
					accessory={readonly ? 'none' : 'chevron'}
					onPress={readonly ? undefined : () => setEditing((value) => !value)}
					last
				/>
			</InsetSection>
			{readonly || !editing ? null : (
				<InsetSection>
					<Field
						variant="row"
						label={placeLabel(eventType)}
						value={place}
						onChangeText={onTyped}
						editable={!savingHit}
						autoCorrect={false}
					/>
					{shownOptions.slice(0, 5).map((option, index, list) => (
						<ListRow
							key={option.key}
							title={option.label}
							subtitle={option.detail}
							accessory={option.key === poi ? 'checkmark' : 'none'}
							onPress={() => {
								if (savingHit) return;
								setPoi(option.key);
								setPlace(option.label);
								typed.current = false;
								clearSearch();
								setEditing(false);
							}}
							last={!typed.current && hits.length === 0 && index === list.length - 1}
						/>
					))}
					{typed.current
						? hits.slice(0, 5).map((hit, index, list) => (
								<ListRow
									key={`hit:${hit.id ?? ''}:${hit.name}:${index}`}
									title={hit.name}
									subtitle={hit.address}
									accessory="none"
									onPress={() => {
										if (!savingHit) {
											void adopt(hit);
											setEditing(false);
										}
									}}
									last={index === list.length - 1}
								/>
							))
						: null}
				</InsetSection>
			)}
		</>
	);

	return { poi, place, spot, placeable, field, retype };
}
