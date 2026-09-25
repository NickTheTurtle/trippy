import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { copy } from '@trippy/copy';
import { api, ApiError, isAbort } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import { Field, InsetSection, ListRow } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { ConfirmSheet } from '../../ui/ConfirmSheet';
import { space } from '../../theme';

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
	onTrip,
	formError
}: {
	picked: Suggestion | null;
	onPick: (city: Suggestion) => void;
	onTrip: Set<string>;
	formError?: string;
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
			<InsetSection
				error={formError || searchError}
				footer={formError || searchError ? undefined : message}
			>
				<Field
					variant="row"
					label={copy.addCity.searchLabel}
					value={query}
					onChangeText={onChange}
					placeholder={copy.addCity.searchPlaceholder}
					autoCapitalize="words"
					last
				/>
			</InsetSection>
			{hits.length ? (
				<InsetSection>
					<ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
						{hits.map((hit, index) => {
							const disabled = onTrip.has(cityKey(hit));
							return (
								<ListRow
									key={`${hit.name}-${hit.country}-${hit.lat}-${index}`}
									title={hit.name}
									subtitle={detail(hit.region, hit.country)}
									value={disabled ? copy.addCity.alreadyAdded : undefined}
									accessory={disabled ? 'none' : 'chevron'}
									onPress={disabled ? undefined : () => onPick(hit)}
									last={index === hits.length - 1}
								/>
							);
						})}
					</ScrollView>
				</InsetSection>
			) : null}
			{picked ? (
				<InsetSection>
					<ListRow
						title={picked.name}
						subtitle={detail(picked.region, picked.country, picked.tz.replace(/_/g, ' '))}
						accessory="checkmark"
						last
					/>
				</InsetSection>
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
			onPrimary={() => void save.run()}
			primaryLabel={copy.common.save}
			primaryBusyLabel={copy.common.saving}
			primaryBusy={save.busy}
			primaryDisabled={!picked}
		>
			<CitySearch picked={picked} onPick={setPicked} onTrip={onTrip} formError={save.error} />
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
