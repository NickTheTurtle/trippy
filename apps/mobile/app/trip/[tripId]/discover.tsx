import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, RefreshControl, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { formatPerNight } from '@trippy/copy/format';
import { localDayMinutes } from '@trippy/core/tz';
import { safeExternalUrl } from '@trippy/core/validate';
import type { Poi, Stay, DiscoverData } from '../../../src/lib/api-types';
import { api } from '../../../src/lib/api';
import { useTripId } from '../../../src/trip-id';
import { useApi } from '../../../src/hooks/useApi';
import { useMutation } from '../../../src/hooks/useMutation';
import { useLiveSection } from '../../../src/hooks/useTripEvents';
import { useToast } from '../../../src/ui/Toast';
import {
	Button,
	Card,
	EmptyState,
	FormError,
	InsetSection,
	ListRow,
	Loading,
	Screen
} from '../../../src/ui';
import { SegmentedControl } from '../../../src/ui/controls';
import { color, radius, space, type } from '../../../src/theme';
import { AppSymbol } from '../../../src/ui/Symbol';
import { Sheet } from '../../../src/ui/Sheet';
import { useTripHeaderAction } from '../../../src/ui/TripHeaderAction';
import { CoverImage } from '../../../src/screens/discover/CoverImage';
import {
	CitySheet,
	DeleteCitySheet,
	type TripCity
} from '../../../src/screens/discover/CitySheets';
import {
	AddDiscoverSheet,
	EditPlaceSheet,
	EditStaySheet
} from '../../../src/screens/discover/PlaceSheets';
import { useDiscoverVotes } from '../../../src/screens/discover/useDiscoverVotes';

type TripData = {
	trip: {
		id: string;
		name: string;
		role: string;
		home_currency: string;
		cities: TripCity[];
	};
};

const ALL = 'all';
const STAY = 'stay';
const FILTERS = [
	{ key: ALL, label: copy.discover.types.all },
	{ key: 'attraction', label: copy.discover.types.attraction },
	{ key: 'food', label: copy.discover.types.food },
	{ key: STAY, label: copy.discover.types.stay }
] as const;
type Filter = (typeof FILTERS)[number]['key'];

type VotedPoi = Poi & { voteBusy?: boolean };
type VotedStay = Stay & { voteBusy?: boolean };

type GridItem =
	{ key: string; votes: number; stay: VotedStay } | { key: string; votes: number; poi: VotedPoi };

export default function Discover() {
	const tripId = useTripId();
	const toast = useToast();
	const { data, error, loading, reload } = useApi<DiscoverData>(`/trips/${tripId}/discover`);
	const { data: tripData, reload: reloadTrip } = useApi<TripData>(`/trips/${tripId}`);
	useLiveSection(['pois', 'lodging', 'schedule', 'members', 'trip'], () => {
		reload();
		reloadTrip();
	});

	const [cityId, setCityId] = useState<string | null>(null);
	const [filter, setFilter] = useState<Filter>(ALL);
	const [adding, setAdding] = useState(false);
	const [citySheet, setCitySheet] = useState<'add' | TripCity | null>(null);
	const [deleteCity, setDeleteCity] = useState<TripCity | null>(null);
	const [editPoi, setEditPoi] = useState<Poi | null>(null);
	const [editStay, setEditStay] = useState<Stay | null>(null);
	useTripHeaderAction(useCallback(() => setAdding(true), []));

	const base = `/trips/${tripId}/discover`;
	const trip = tripData?.trip;
	const isOrganizer = data?.isOrganizer ?? trip?.role === 'organizer';

	const votes = useDiscoverVotes({ base, data, reload, onError: toast.error });

	const cities = useMemo(() => {
		const byTrip = trip?.cities ?? [];
		const discoverCities = data?.cities ?? [];
		return [...discoverCities]
			.map((c) => {
				const full = byTrip.find((t) => t.id === c.id);
				return {
					...c,
					country: full?.country ?? '',
					region: full?.region ?? null,
					tz: full?.tz ?? '',
					lat: full?.lat ?? c.lat ?? 0,
					lng: full?.lng ?? c.lng ?? 0
				} satisfies TripCity & typeof c;
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [data?.cities, trip?.cities]);

	const current = useMemo(() => {
		if (!cities.length) return null;
		return cities.find((c) => c.id === cityId) ?? cities[0];
	}, [cities, cityId]);

	const ambiguous = useMemo(
		() =>
			new Set(
				cities
					.filter((c, i) => cities.some((o, j) => i !== j && o.name === c.name))
					.map((c) => c.id)
			),
		[cities]
	);

	const deleteCityMutation = useMutation(
		async () => {
			if (!deleteCity) return;
			await api(`/trips/${tripId}/cities/${deleteCity.id}`, { method: 'DELETE' });
		},
		{
			fallback: copy.addCity.addFallback,
			onSuccess: () => {
				const deletedId = deleteCity?.id;
				if (deletedId && deletedId === current?.id) {
					setCityId(cities.find((city) => city.id !== deletedId)?.id ?? null);
				}
				setDeleteCity(null);
				reload();
				reloadTrip();
			}
		}
	);

	useEffect(() => {
		if (deleteCity) deleteCityMutation.reset();
	}, [deleteCity]);

	if (loading && !data) return <Loading />;

	if (data && data.cities.length === 0) {
		return (
			<>
				<Screen>
					<FormError message={error ?? ''} />
					<InsetSection title={copy.discover.noCities.heading}>
						<View style={{ padding: space.md, gap: space.md }}>
							<Text style={type.small}>{copy.discover.noCities.body}</Text>
							{isOrganizer ? (
								<Button label={copy.discover.noCities.cta} onPress={() => setCitySheet('add')} />
							) : (
								<Text style={type.faint}>{copy.discover.noCities.memberNote}</Text>
							)}
						</View>
					</InsetSection>
				</Screen>
				{trip && citySheet === 'add' ? (
					<CitySheet
						open
						tripId={tripId}
						tripName={trip.name}
						cities={trip.cities}
						onClose={() => setCitySheet(null)}
						onSaved={() => {
							setCitySheet(null);
							reload();
							reloadTrip();
						}}
					/>
				) : null}
			</>
		);
	}

	if (!data || !current) {
		return (
			<Screen>
				<FormError message={error ?? copy.api.loadFailed} />
				<Button label={copy.api.retry} onPress={reload} />
			</Screen>
		);
	}

	const showStays = filter === ALL || filter === STAY;
	const showPlaces = filter === ALL || filter === 'attraction' || filter === 'food';
	const cityStays = showStays
		? (data.stays[current.id] ?? []).map((stay) => votes.stay(current.id, stay))
		: [];
	const cityPlaces = showPlaces
		? current.pois.filter((poi) => filter === ALL || poi.kind === filter).map(votes.place)
		: [];
	const items: GridItem[] = [
		...cityStays.map((stay) => ({ key: `stay:${stay.id}`, votes: stay.votes, stay })),
		...cityPlaces.map((poi) => ({ key: `poi:${poi.id}`, votes: poi.votes, poi }))
	].sort((a, b) => b.votes - a.votes);

	const rows = cities.map((city) => {
		const places =
			filter === STAY ? 0 : city.pois.filter((poi) => filter === ALL || poi.kind === filter).length;
		const stays = showStays ? (data.stays[city.id]?.length ?? 0) : 0;
		return { city, badge: places + stays };
	});

	return (
		<>
			<Screen refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}>
				{error ? <FormError message={error} /> : null}

				<CityStrip
					rows={rows.map(({ city, badge }) => ({
						id: city.id,
						name: city.name,
						region: ambiguous.has(city.id) ? city.region : null,
						badge
					}))}
					active={current.id}
					isOrganizer={isOrganizer}
					canDelete={cities.length > 1}
					onPick={setCityId}
					onAdd={() => setCitySheet('add')}
					onEdit={() => setCitySheet(current)}
					onDelete={() => setDeleteCity(current)}
				/>

				<SegmentedControl
					items={FILTERS.map((f) => ({ key: f.key, label: f.key === 'food' ? 'Food' : f.label }))}
					active={filter}
					onPick={(key) => setFilter(key as Filter)}
				/>

				<InsetSection
					title={copy.discover.cityList.cityLabel(
						current.name,
						ambiguous.has(current.id) ? current.region : null
					)}
				>
					{items.length === 0 ? (
						<EmptyState message={copy.common.nothingAdded} />
					) : (
						<View style={{ gap: space.md, padding: space.md }}>
							{items.map((item) =>
								'stay' in item ? (
									<StayCard
										key={item.key}
										stay={item.stay}
										currency={data.currency}
										pct={pct(item.stay.votes, data.memberCount)}
										onEdit={() => setEditStay(item.stay)}
										onVote={() => votes.toggleStay(current.id, item.stay)}
									/>
								) : (
									<PlaceCard
										key={item.key}
										poi={item.poi}
										tz={current.tz}
										pct={pct(item.poi.votes, data.memberCount)}
										onEdit={() => setEditPoi(item.poi)}
										onVote={() => votes.togglePlace(item.poi)}
									/>
								)
							)}
						</View>
					)}
				</InsetSection>
			</Screen>

			{trip && citySheet !== null ? (
				<CitySheet
					open
					tripId={tripId}
					tripName={trip.name}
					cities={trip.cities}
					city={citySheet !== 'add' ? citySheet : null}
					onClose={() => setCitySheet(null)}
					onSaved={() => {
						setCitySheet(null);
						reload();
						reloadTrip();
					}}
				/>
			) : null}
			{deleteCity ? (
				<DeleteCitySheet
					city={deleteCity}
					count={linkedForCity(data, deleteCity.id)}
					busy={deleteCityMutation.busy}
					error={deleteCityMutation.error}
					onCancel={() => setDeleteCity(null)}
					onConfirm={() => void deleteCityMutation.run()}
				/>
			) : null}
			{adding ? (
				<AddDiscoverSheet
					open
					base={base}
					city={{ id: current.id, name: current.name }}
					provider={data.provider}
					initialType={filter === STAY ? STAY : filter === 'food' ? 'food' : 'attraction'}
					currency={data.currency}
					currencies={data.currencies}
					onClose={() => setAdding(false)}
					onAdded={(type) => {
						setAdding(false);
						setFilter((currentFilter) => (currentFilter === ALL ? currentFilter : type));
						reload();
					}}
				/>
			) : null}
			{editPoi ? (
				<EditPlaceSheet
					open
					base={base}
					poi={editPoi}
					onClose={() => setEditPoi(null)}
					onSaved={() => {
						setEditPoi(null);
						reload();
					}}
					onDeleted={() => {
						setEditPoi(null);
						reload();
					}}
				/>
			) : null}
			{editStay ? (
				<EditStaySheet
					open
					base={base}
					stay={editStay}
					currency={data.currency}
					currencies={data.currencies}
					onClose={() => setEditStay(null)}
					onSaved={() => {
						setEditStay(null);
						reload();
					}}
					onDeleted={() => {
						setEditStay(null);
						reload();
					}}
				/>
			) : null}
		</>
	);
}

function CityStrip({
	rows,
	active,
	isOrganizer,
	canDelete,
	onPick,
	onAdd,
	onEdit,
	onDelete
}: {
	rows: { id: string; name: string; region?: string | null; badge: number }[];
	active: string;
	isOrganizer: boolean;
	canDelete: boolean;
	onPick: (id: string) => void;
	onAdd: () => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const [open, setOpen] = useState(false);
	const current = rows.find((row) => row.id === active) ?? rows[0];
	return (
		<>
			<InsetSection>
				<ListRow
					title={current?.name ?? copy.discover.cityList.navLabel}
					subtitle={current?.region ?? null}
					value={current?.badge ? String(current.badge) : undefined}
					symbol={{ name: 'mappin.and.ellipse', fallback: 'location-outline' }}
					onPress={() => setOpen(true)}
					last
				/>
			</InsetSection>
			<Sheet open={open} title={copy.discover.cityList.navLabel} onClose={() => setOpen(false)}>
				<InsetSection>
					{rows.map((row, index) => (
						<ListRow
							key={row.id}
							title={row.name}
							subtitle={row.region ?? null}
							value={row.badge ? String(row.badge) : undefined}
							accessory={row.id === active ? 'checkmark' : 'none'}
							onPress={() => {
								onPick(row.id);
								setOpen(false);
							}}
							last={index === rows.length - 1 && !isOrganizer}
						/>
					))}
					{isOrganizer ? (
						<>
							<ListRow
								title={copy.discover.cityList.addCity}
								symbol={{ name: 'plus', fallback: 'add' }}
								onPress={() => {
									setOpen(false);
									onAdd();
								}}
							/>
							<ListRow
								title={copy.mobileDiscover.editCityButton}
								symbol={{ name: 'pencil', fallback: 'create-outline' }}
								onPress={() => {
									setOpen(false);
									onEdit();
								}}
							/>
							{canDelete ? (
								<ListRow
									title={copy.common.delete}
									tone="destructive"
									symbol={{ name: 'trash', fallback: 'trash-outline' }}
									accessory="none"
									onPress={() => {
										setOpen(false);
										onDelete();
									}}
									last
								/>
							) : null}
						</>
					) : null}
				</InsetSection>
			</Sheet>
		</>
	);
}

function PlaceCard({
	poi,
	tz,
	pct,
	onEdit,
	onVote
}: {
	poi: VotedPoi;
	tz: string;
	pct: number;
	onEdit: () => void;
	onVote: () => void;
}) {
	const href = poi.url ? safeExternalUrl(poi.url) : null;
	const hrs = todayHours(parseHours(poi.hours), tz);
	return (
		<Card style={{ padding: 0, overflow: 'hidden' }}>
			<Pressable onPress={onEdit} accessibilityLabel={copy.common.editLabel(poi.name)}>
				<CoverImage photo={poi.photo} seed={poi.name} category={poi.category} flush />
				<View style={{ padding: space.md, gap: space.sm }}>
					<Text style={{ ...type.body, fontWeight: '600' }}>{poi.name}</Text>
					<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
						{poi.rating ? (
							<View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
								<AppSymbol name="star.fill" fallback="star" size={13} color={color.warn} />
								<Text style={{ ...type.small, color: color.warn }}>
									{poi.rating.toFixed(1)}
									{poi.rating_count ? ` (${poi.rating_count})` : ''}
								</Text>
							</View>
						) : null}
						{poi.price_level != null ? (
							<Text style={{ ...type.small, color: color.accentInk }}>
								{'$'.repeat(Math.max(1, poi.price_level))}
							</Text>
						) : null}
						{hrs ? <Text style={type.small}>{hrs}</Text> : null}
					</View>
					{poi.notes ? <Text style={type.faint}>{poi.notes}</Text> : null}
				</View>
			</Pressable>
			<View
				style={{
					flexDirection: 'row',
					alignItems: 'center',
					gap: space.sm,
					paddingHorizontal: space.md,
					paddingBottom: space.md
				}}
			>
				<VoteButton
					count={poi.votes}
					mine={poi.you_voted === 1}
					busy={!!poi.voteBusy}
					label={copy.discover.card.voteLabel(poi.you_voted === 1, poi.name)}
					onPress={onVote}
				/>
				{href ? (
					<Pressable onPress={() => void Linking.openURL(href)}>
						<Text style={{ ...type.small, color: color.accent }}>
							{copy.mobileDiscover.openLink}
						</Text>
					</Pressable>
				) : null}
			</View>
			<VoteRule pct={pct} />
		</Card>
	);
}

function StayCard({
	stay,
	currency,
	pct,
	onEdit,
	onVote
}: {
	stay: VotedStay;
	currency: string;
	pct: number;
	onEdit: () => void;
	onVote: () => void;
}) {
	const href = stay.url ? safeExternalUrl(stay.url) : null;
	return (
		<Card style={{ padding: 0, overflow: 'hidden' }}>
			<Pressable onPress={onEdit} accessibilityLabel={copy.common.editLabel(stay.name)}>
				<CoverImage photo={stay.photo} seed={stay.name} category="stay" flush />
				<View style={{ padding: space.md, gap: space.sm }}>
					<Text style={{ ...type.body, fontWeight: '600' }}>{stay.name}</Text>
					<Text style={type.faint}>
						{stay.tag ? `${stay.tag} · ` : ''}
						{formatPerNight(stay.price_cents, stay.currency || currency)}
					</Text>
				</View>
			</Pressable>
			<View
				style={{
					flexDirection: 'row',
					alignItems: 'center',
					gap: space.sm,
					paddingHorizontal: space.md,
					paddingBottom: space.md
				}}
			>
				<VoteButton
					count={stay.votes}
					mine={stay.you_voted === 1}
					busy={!!stay.voteBusy}
					label={copy.discover.card.voteLabel(stay.you_voted === 1, stay.name)}
					onPress={onVote}
				/>
				{href ? (
					<Pressable onPress={() => void Linking.openURL(href)}>
						<Text style={{ ...type.small, color: color.accent }}>
							{copy.mobileDiscover.openLink}
						</Text>
					</Pressable>
				) : null}
			</View>
			<VoteRule pct={pct} />
		</Card>
	);
}

function VoteButton({
	count,
	mine,
	busy,
	label,
	onPress
}: {
	count: number;
	mine: boolean;
	busy: boolean;
	label: string;
	onPress: () => void;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			disabled={busy}
			onPress={onPress}
			style={({ pressed }) => ({
				flexDirection: 'row',
				alignItems: 'center',
				gap: 4,
				paddingHorizontal: 10,
				height: 30,
				borderRadius: radius.md,
				borderWidth: 1,
				borderColor: mine ? color.accent : color.line,
				backgroundColor: mine ? color.accentSoft : color.surface,
				opacity: busy ? 0.45 : pressed ? 0.7 : 1
			})}
		>
			<AppSymbol
				name={mine ? 'heart.fill' : 'heart'}
				fallback={mine ? 'heart' : 'heart-outline'}
				size={13}
				color={mine ? color.accentInk : color.inkFaint}
			/>
			<Text style={{ ...type.small, color: mine ? color.accentInk : color.inkSoft }}>{count}</Text>
		</Pressable>
	);
}

function VoteRule({ pct }: { pct: number }) {
	return (
		<View
			style={{
				height: 3,
				width: `${Math.min(100, Math.max(0, pct))}%`,
				backgroundColor: color.accent,
				borderRadius: 2
			}}
		/>
	);
}

function linkedForCity(data: DiscoverData, cityId: string): number {
	const placeLinked =
		data.cities
			.find((city) => city.id === cityId)
			?.pois.reduce((sum, poi) => sum + poi.linked, 0) ?? 0;
	const stayLinked = (data.stays[cityId] ?? []).reduce((sum, stay) => sum + stay.linked, 0);
	return placeLinked + stayLinked;
}

function pct(votes: number, total: number): number {
	return total ? Math.round((votes / total) * 100) : 0;
}

function parseHours(raw: string | null): string[] | null {
	if (!raw) return null;
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value) ? value.map(String) : null;
	} catch {
		return null;
	}
}

function todayHours(hours: string[] | null | undefined, tz: string): string | null {
	if (!hours || hours.length === 0 || !tz) return null;
	const { day } = localDayMinutes(tz);
	if (!day) return null;
	const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
	if (Number.isNaN(weekday)) return null;
	const idx = (weekday + 6) % 7;
	return (hours[idx] ?? hours[0]).replace(/^[A-Za-z]+:\s*/, '');
}
