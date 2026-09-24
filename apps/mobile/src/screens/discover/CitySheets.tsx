import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { copy } from '@trippy/copy';
import { api, ApiError, isAbort } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import { FormError } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { SheetFooter } from '../../ui/SheetFooter';
import { ConfirmSheet } from '../../ui/ConfirmSheet';
import { color, fieldLabel, radius, space, type } from '../../theme';

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

function CitySearch({
	picked,
	onPick,
	onTrip
}: {
	picked: Suggestion | null;
	onPick: (city: Suggestion) => void;
	onTrip: Set<string>;
}) {
	const [query, setQuery] = useState('');
	const [hits, setHits] = useState<Suggestion[]>([]);
	const [searching, setSearching] = useState(false);
	const [searched, setSearched] = useState(false);
	const [searchError, setSearchError] = useState('');
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const inflight = useRef<AbortController | undefined>(undefined);

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
		setSearching(v.trim().length >= MIN_QUERY);
		timer.current = setTimeout(() => run(v.trim()), 350);
	}

	const message =
		query.trim().length < MIN_QUERY
			? copy.addCity.searchPlaceholder
			: searching
				? copy.addCity.searching
				: searchError || (searched && hits.length === 0 ? copy.addCity.noMatches : '');

	return (
		<View style={{ gap: space.sm }}>
			<Text style={fieldLabel}>{copy.addCity.searchLabel}</Text>
			<TextInput
				accessibilityLabel={copy.addCity.searchLabel}
				value={query}
				onChangeText={onChange}
				placeholder={copy.addCity.searchPlaceholder}
				autoCapitalize="words"
				style={{
					height: 44,
					paddingHorizontal: space.md,
					borderRadius: radius.md,
					borderWidth: 1,
					borderColor: color.line,
					backgroundColor: color.surface,
					color: color.ink
				}}
			/>
			{message ? (
				<Text style={searchError ? { ...type.small, color: color.dangerInk } : type.faint}>
					{message}
				</Text>
			) : null}
			{hits.length ? (
				<View
					style={{
						borderWidth: 1,
						borderColor: color.line,
						borderRadius: radius.md,
						maxHeight: 240
					}}
				>
					<ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
						{hits.map((hit, index) => {
							const disabled = onTrip.has(cityKey(hit));
							return (
								<Pressable
									key={`${hit.name}-${hit.country}-${hit.lat}-${index}`}
									disabled={disabled}
									onPress={() => onPick(hit)}
									style={({ pressed }) => ({
										padding: space.md,
										borderTopWidth: index === 0 ? 0 : 1,
										borderTopColor: color.line,
										backgroundColor: pressed ? color.surface2 : color.surface,
										opacity: disabled ? 0.45 : 1
									})}
								>
									<Text style={type.body}>{hit.name}</Text>
									<Text style={type.faint}>{detail(hit.region, hit.country)}</Text>
									{disabled ? <Text style={type.faint}>{copy.addCity.alreadyAdded}</Text> : null}
								</Pressable>
							);
						})}
					</ScrollView>
				</View>
			) : null}
			{picked ? (
				<View
					style={{ backgroundColor: color.accentSoft, borderRadius: radius.md, padding: space.md }}
				>
					<Text style={type.body}>{picked.name}</Text>
					<Text style={type.faint}>
						{detail(picked.region, picked.country, picked.tz.replace(/_/g, ' '))}
					</Text>
				</View>
			) : null}
		</View>
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
	onSaved: () => void;
}) {
	const [picked, setPicked] = useState<Suggestion | null>(null);
	const onTrip = useMemo(
		() => new Set(cities.filter((c) => c.id !== city?.id).map(cityKey)),
		[cities, city]
	);

	useEffect(() => {
		if (open) {
			setPicked(null);
			save.reset();
		}
	}, [open]);

	const save = useMutation(
		async () => {
			if (!picked) throw new Error(copy.addCity.addFallback);
			await api(`/trips/${tripId}/cities${city ? `/${city.id}` : ''}`, {
				method: city ? 'PATCH' : 'POST',
				body: picked
			});
		},
		{ fallback: copy.addCity.addFallback, onSuccess: onSaved }
	);

	return (
		<Sheet
			open={open}
			title={city ? copy.mobileDiscover.editCityTitle : copy.addCity.title}
			subtitle={tripName}
			onClose={onClose}
		>
			<CitySearch picked={picked} onPick={setPicked} onTrip={onTrip} />
			<FormError message={save.error} />
			<SheetFooter
				primaryLabel={copy.common.save}
				primaryBusyLabel={copy.common.saving}
				primaryBusy={save.busy}
				primaryDisabled={!picked}
				onPrimary={() => void save.run()}
			/>
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
