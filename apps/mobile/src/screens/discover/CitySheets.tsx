import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { copy } from '@trippy/copy';
import { api, ApiError, isAbort } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import { Field, GroupedRow, InsetSection, ListRow } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { ConfirmSheet } from '../../ui/ConfirmSheet';
import { AppSymbol } from '../../ui/Symbol';
import { color, space, type } from '../../theme';

const MIN_QUERY = 2;

type Suggestion = {
	name: string;
	country: string;
	region?: string | null;
	lat: number;
	lng: number;
	tz: string;
};

export type TripCity = Suggestion & { id: string };

function detail(...parts: (string | null | undefined)[]): string {
	return parts
		.map((p) => p?.trim())
		.filter(Boolean)
		.join(' · ');
}

function cityKey(c: { name: string; country: string; region?: string | null }): string {
	const part = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
	return `${part(c.name)}|${part(c.country)}|${part(c.region)}`;
}

/**
 * The most cities one add can carry. The server refuses more
 * (`MAX_CITIES_PER_ADD` in packages/server), so the sheet stops offering hits
 * at the same count rather than letting the user build a list it will refuse.
 */
const MAX_PICKS = 20;

const cityTz = (c: Suggestion) => c.tz.replace(/_/g, ' ');

/**
 * Search and pick, for both the add and the edit sheet.
 *
 * `clearOnPick` is the add sheet's multi-pick: each pick goes onto a list kept
 * by the sheet, so the field empties and keeps focus for the next city, as the
 * web's search dropdown closes on a pick. The edit sheet replaces one city, so
 * its search stays put and changing your mind is another tap on the hits.
 */
function CitySearch({
	onPick,
	onTrip,
	picked,
	full = false,
	clearOnPick = false
}: {
	onPick: (city: Suggestion) => void;
	onTrip: Set<string>;
	/** Hits already in the add list, shown as picked rather than offered twice. */
	picked?: Set<string>;
	/** The add list is at its cap: hits are shown but cannot be picked. */
	full?: boolean;
	clearOnPick?: boolean;
}) {
	const [query, setQuery] = useState('');
	const [hits, setHits] = useState<Suggestion[]>([]);
	const [searching, setSearching] = useState(false);
	const [searched, setSearched] = useState(false);
	const [searchError, setSearchError] = useState('');
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const inflight = useRef<AbortController | undefined>(undefined);
	const input = useRef<TextInput>(null);

	useEffect(
		() => () => {
			clearTimeout(timer.current);
			inflight.current?.abort();
		},
		[]
	);

	function run(q: string) {
		setSearchError('');
		if (q.length < MIN_QUERY) {
			inflight.current?.abort();
			inflight.current = undefined;
			setHits([]);
			setSearched(false);
			setSearching(false);
			return;
		}
		inflight.current?.abort();
		const ctl = new AbortController();
		inflight.current = ctl;
		setSearching(true);
		api<{ results: Suggestion[] }>(`/citysearch?q=${encodeURIComponent(q)}`, { signal: ctl.signal })
			.then((d) => {
				setHits(d.results ?? []);
				setSearched(true);
				setSearchError('');
			})
			.catch((err) => {
				if (ctl.signal.aborted || isAbort(err)) return;
				setHits([]);
				setSearched(true);
				setSearchError(err instanceof ApiError ? err.message : copy.api.requestFailed);
			})
			.finally(() => {
				if (inflight.current === ctl) {
					inflight.current = undefined;
					setSearching(false);
				}
			});
	}

	function onChange(v: string) {
		setQuery(v);
		clearTimeout(timer.current);
		if (v.trim().length < MIN_QUERY) {
			// Nothing to wait for: an emptied field drops its hits at once, so
			// the picked list under them is not hidden for the debounce.
			run('');
			return;
		}
		setSearching(true);
		timer.current = setTimeout(() => run(v.trim()), 350);
	}

	function pick(hit: Suggestion) {
		onPick(hit);
		if (!clearOnPick) return;
		// A search still waiting to run, or still in flight, belongs to the query
		// just cleared and must not land its hits under an empty field.
		clearTimeout(timer.current);
		setQuery('');
		run('');
		input.current?.focus();
	}

	const message = full
		? copy.mobileDiscover.pickLimit(MAX_PICKS)
		: query.trim().length < MIN_QUERY
			? copy.addCity.searchPlaceholder
			: searching
				? copy.addCity.searching
				: searched && hits.length === 0
					? copy.addCity.noMatches
					: '';

	return (
		<View style={{ gap: space.sm }}>
			<InsetSection error={searchError} footer={message}>
				<Field
					ref={input}
					variant="row"
					label={copy.addCity.searchLabel}
					value={query}
					onChangeText={onChange}
					placeholder={copy.addCity.searchPlaceholder}
					autoCapitalize="words"
					autoCorrect={false}
					returnKeyType="search"
					last
				/>
			</InsetSection>
			{hits.length ? (
				<InsetSection>
					<ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
						{hits.map((hit, index) => {
							const key = cityKey(hit);
							const status = onTrip.has(key)
								? copy.addCity.alreadyAdded
								: picked?.has(key)
									? copy.addCity.picked
									: undefined;
							const disabled = !!status || full;
							return (
								<ListRow
									key={`${hit.name}-${hit.country}-${hit.lat}-${index}`}
									title={hit.name}
									subtitle={detail(hit.region, hit.country)}
									value={status}
									accessory={disabled ? 'none' : 'chevron'}
									onPress={disabled ? undefined : () => pick(hit)}
									accessibilityState={{ disabled }}
									last={index === hits.length - 1}
								/>
							);
						})}
					</ScrollView>
				</InsetSection>
			) : null}
		</View>
	);
}

/**
 * The add sheet's list, in pick order, each with the iOS edit-mode minus to
 * take it back out. A refused add leaves the list as it was, so the city the
 * server named can be removed here and the rest sent again.
 */
function PickedCities({
	cities,
	onRemove
}: {
	cities: Suggestion[];
	onRemove: (city: Suggestion) => void;
}) {
	if (!cities.length) return null;
	return (
		<InsetSection title={copy.addCity.pickedHeading(cities.length)}>
			{cities.map((city, index) => {
				const label = copy.discover.cityList.cityLabel(city.name, city.region);
				return (
					<GroupedRow
						key={cityKey(city)}
						last={index === cities.length - 1}
						leading={
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={copy.addCity.remove(label)}
								onPress={() => onRemove(city)}
								hitSlop={10}
								style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
							>
								<AppSymbol
									name="minus.circle.fill"
									fallback="remove-circle"
									size={22}
									color={color.dangerInk}
								/>
							</Pressable>
						}
					>
						<Text style={type.body} numberOfLines={1}>
							{city.name}
						</Text>
						<Text style={type.subhead} numberOfLines={1}>
							{detail(city.region, city.country, cityTz(city))}
						</Text>
					</GroupedRow>
				);
			})}
		</InsetSection>
	);
}

export function CitySheet({
	open,
	tripId,
	tripName,
	cities,
	city,
	onClose,
	onSaved
}: {
	open: boolean;
	tripId: string;
	tripName: string;
	cities: TripCity[];
	city?: TripCity | null;
	onClose: () => void;
	/** After a save. An add passes the ids it created, in pick order. */
	onSaved: (added?: string[]) => void;
}) {
	const editing = !!city;
	const [picks, setPicks] = useState<Suggestion[]>([]);
	const [replacement, setReplacement] = useState<Suggestion | null>(null);
	const onTrip = useMemo(
		() => new Set(cities.filter((c) => c.id !== city?.id).map(cityKey)),
		[cities, city]
	);
	const pickedKeys = useMemo(() => new Set(picks.map(cityKey)), [picks]);

	useEffect(() => {
		if (open) {
			setPicks([]);
			setReplacement(null);
			save.reset();
		}
	}, [open]);

	const save = useMutation(
		async () => {
			if (city) {
				if (!replacement) throw new Error(copy.mobileDiscover.editCityFallback);
				await api(`/trips/${tripId}/cities/${city.id}`, { method: 'PATCH', body: replacement });
				return undefined;
			}
			if (!picks.length) throw new Error(copy.addCity.addFallback);
			// One request for the whole list, all or none: a refusal names the
			// city it was about and nothing is added, so the list stays whole.
			const res = await api<{ added?: string[] }>(`/trips/${tripId}/cities`, {
				method: 'POST',
				body: { cities: picks }
			});
			return res.added ?? [];
		},
		{
			fallback: editing ? copy.mobileDiscover.editCityFallback : copy.addCity.addFallback,
			onSuccess: onSaved
		}
	);

	function pick(hit: Suggestion) {
		if (editing) {
			setReplacement(hit);
			return;
		}
		setPicks((list) =>
			list.length >= MAX_PICKS || list.some((c) => cityKey(c) === cityKey(hit))
				? list
				: [...list, hit]
		);
		save.reset();
	}

	function remove(target: Suggestion) {
		setPicks((list) => list.filter((c) => cityKey(c) !== cityKey(target)));
		save.reset();
	}

	return (
		<Sheet
			open={open}
			title={editing ? copy.mobileDiscover.editCityTitle : copy.addCity.title}
			subtitle={tripName}
			onClose={onClose}
			onPrimary={() => void save.run()}
			primaryLabel={editing ? copy.common.save : copy.addCity.submit(picks.length)}
			primaryBusyLabel={editing ? copy.common.saving : copy.common.adding}
			primaryBusy={save.busy}
			primaryDisabled={editing ? !replacement : picks.length === 0}
			error={save.error}
		>
			{editing ? (
				<>
					<CitySearch onPick={pick} onTrip={onTrip} />
					{replacement ? (
						<InsetSection>
							<ListRow
								title={replacement.name}
								subtitle={detail(replacement.region, replacement.country, cityTz(replacement))}
								accessory="checkmark"
								last
							/>
						</InsetSection>
					) : null}
				</>
			) : (
				<>
					<CitySearch
						onPick={pick}
						onTrip={onTrip}
						picked={pickedKeys}
						full={picks.length >= MAX_PICKS}
						clearOnPick
					/>
					<PickedCities cities={picks} onRemove={remove} />
				</>
			)}
		</Sheet>
	);
}

export function DeleteCitySheet({
	city,
	count,
	busy,
	error,
	onCancel,
	onConfirm
}: {
	city: { name: string; region?: string | null } | null;
	count: number;
	busy: boolean;
	error: string;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	return (
		<ConfirmSheet
			open={!!city}
			title={
				city
					? copy.common.deleteTitle(copy.discover.cityList.cityLabel(city.name, city.region))
					: ''
			}
			message={city ? copy.mobileDiscover.deleteCityMessage(count) : undefined}
			confirmLabel={copy.common.delete}
			busyLabel={copy.common.deleting}
			busy={busy}
			error={error}
			onCancel={onCancel}
			onConfirm={onConfirm}
		/>
	);
}
