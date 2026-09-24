import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { isLocatedType, type EventType } from '@trippy/core/types';
import type { PlaceHit } from '../../lib/api-types';
import { api } from '../../lib/api';
import { Field } from '../../ui';
import { color, radius, space, type } from '../../theme';
import { keepsPick, placeLabel, placeOptions, poiKindFor } from './shared';
import type { Cell, SavedPoi } from './types';

const MIN_QUERY = 3;
const DEBOUNCE_MS = 350;

export type PlaceDraft = {
	poi: string;
	place: string;
	spot: SavedPoi | null;
	placeable: boolean;
	field: React.ReactNode;
	retype: (next: EventType) => void;
};

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
	const typed = useRef(false);
	const abort = useRef<AbortController | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
			const params = new URLSearchParams({
				q: text.trim(),
				cityId: city.id,
				kind: staying ? 'stay' : 'place'
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
		}, DEBOUNCE_MS);
	}

	async function adopt(hit: PlaceHit) {
		if (!city) return;
		setPlace(hit.name);
		setPoi('');
		setSavingHit(true);
		try {
			const discover = base.replace(/\/schedule$/, '/discover');
			const made = await api<{ id: string }>(`${discover}/${staying ? 'stays' : 'pois'}`, {
				method: 'POST',
				body: staying
					? {
							cityId: city.id,
							name: hit.name,
							currency: '',
							url: hit.url ?? '',
							photo: hit.photo ?? null,
							lat: hit.lat ?? null,
							lng: hit.lng ?? null
						}
					: {
							cityId: city.id,
							name: hit.name,
							activity: '',
							category: hit.category ?? '',
							kind: poiKindFor(eventType) ?? undefined,
							notes: hit.address ?? '',
							url: hit.url ?? '',
							photo: hit.photo ?? null,
							lat: hit.lat ?? null,
							lng: hit.lng ?? null,
							rating: hit.rating ?? null,
							ratingCount: hit.ratingCount ?? null,
							priceLevel: hit.priceLevel ?? null,
							hours: hit.hours ?? null
						}
			});
			const savedPlace: SavedPoi = {
				id: made.id,
				name: hit.name,
				city_id: city.id,
				lat: hit.lat ?? null,
				lng: hit.lng ?? null,
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
		<View style={{ gap: space.sm }}>
			<Field
				label={placeLabel(eventType)}
				value={place}
				onChangeText={onTyped}
				editable={!readonly && !savingHit}
				autoCorrect={false}
			/>
			{readonly ? null : (
				<View style={{ borderWidth: 1, borderColor: color.line, borderRadius: radius.md }}>
					{shownOptions.slice(0, 5).map((option, index) => (
						<Pressable
							key={option.key}
							onPress={() => {
								setPoi(option.key);
								setPlace(option.label);
								typed.current = false;
								clearSearch();
							}}
							style={({ pressed }) => ({
								paddingHorizontal: space.md,
								paddingVertical: space.sm,
								borderTopWidth: index === 0 ? 0 : 1,
								borderTopColor: color.line,
								backgroundColor: pressed ? color.surface2 : color.surface
							})}
						>
							<Text style={type.body}>{option.label}</Text>
							{option.detail ? <Text style={type.faint}>{option.detail}</Text> : null}
						</Pressable>
					))}
					{typed.current &&
						hits.slice(0, 5).map((hit, index) => (
							<Pressable
								key={`hit:${hit.id ?? ''}:${hit.name}:${index}`}
								onPress={() => void adopt(hit)}
								style={({ pressed }) => ({
									paddingHorizontal: space.md,
									paddingVertical: space.sm,
									borderTopWidth: 1,
									borderTopColor: color.line,
									backgroundColor: pressed ? color.surface2 : color.surface
								})}
							>
								<Text style={type.body}>{hit.name}</Text>
								{hit.address ? <Text style={type.faint}>{hit.address}</Text> : null}
							</Pressable>
						))}
				</View>
			)}
			{typed.current && place.trim().length > 0 ? (
				<Text style={type.faint}>
					{searching || savingHit
						? copy.schedule.placeSearch.searching
						: place.trim().length < MIN_QUERY
							? copy.schedule.placeSearch.keepTyping
							: searched && hits.length === 0
								? copy.schedule.placeSearch.nothingFound
								: copy.schedule.placeSearch.noMatch}
				</Text>
			) : null}
		</View>
	);

	return { poi, place, spot, placeable, field, retype };
}
