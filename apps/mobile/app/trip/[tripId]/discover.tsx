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
	EmptyState,
	FormError,
	InsetSection,
	ListRow,
	Loading,
	Screen,
	SectionHeader
} from '../../../src/ui';
import { SegmentedControl } from '../../../src/ui/controls';
import { color, radius, space, type } from '../../../src/theme';
import { AppSymbol } from '../../../src/ui/Symbol';
import { Sheet } from '../../../src/ui/Sheet';
import { useTripHeaderAction } from '../../../src/ui/TripHeaderAction';
import { useSheetHandoff } from '../../../src/ui/useSheetHandoff';
import { Cover } from '../../../src/ui/Cover';
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
import { lazyTab } from '../../../src/ui/nativeTabs';

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
type VotedStay = Stay & { voteBusy?: boolean; voteLocked?: boolean };

type GridItem =
	{ key: string; votes: number; stay: VotedStay } | { key: string; votes: number; poi: VotedPoi };

export default lazyTab(Discover);

function Discover() {
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
	const canAddDiscover = !!data && !!current;
	const addDiscoverAction = useCallback(() => setAdding(true), []);
	useTripHeaderAction(canAddDiscover ? addDiscoverAction : null);
	useEffect(() => {
		if (!canAddDiscover && adding) setAdding(false);
	}, [adding, canAddDiscover]);

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
					<EmptyState
						symbol={{ name: 'mappin.and.ellipse', fallback: 'location-outline' }}
						title={copy.discover.noCities.heading}
						message={copy.discover.noCities.body}
						hint={isOrganizer ? undefined : copy.discover.noCities.memberNote}
						action={
							isOrganizer ? (
								<Button label={copy.discover.noCities.cta} onPress={() => setCitySheet('add')} />
							) : undefined
						}
					/>
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
					items={FILTERS.map((f) => ({
						key: f.key,
						label: f.key === 'food' ? copy.mobileDiscover.shortTypes.food : f.label
					}))}
					active={filter}
					onPick={(key) => setFilter(key as Filter)}
				/>

				{items.length === 0 ? (
					<EmptyState graphic message={copy.common.nothingAdded} />
				) : (
					<View style={{ gap: 7 }}>
						<SectionHeader>
							{copy.discover.cityList.cityLabel(
								current.name,
								ambiguous.has(current.id) ? current.region : null
							)}
						</SectionHeader>
						<View style={{ gap: space.md }}>
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
					</View>
				)}
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
	const handoff = useSheetHandoff({
		add: onAdd,
		edit: onEdit,
		delete: onDelete
	});
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
			<Sheet
				open={open}
				title={copy.discover.cityList.navLabel}
				onClose={() => setOpen(false)}
				onDismiss={handoff.flush}
			>
				<InsetSection>
					{rows.map((row, index) => (
						<ListRow
							key={row.id}
							title={row.name}
							subtitle={row.region ?? null}
							value={row.badge ? String(row.badge) : undefined}
							accessory={row.id === active ? 'checkmark' : 'none'}
							accessibilityState={{ selected: row.id === active }}
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
								onPress={() => handoff.queue('add', () => setOpen(false))}
							/>
							<ListRow
								title={copy.mobileDiscover.editCityButton}
								symbol={{ name: 'pencil', fallback: 'create-outline' }}
								onPress={() => handoff.queue('edit', () => setOpen(false))}
							/>
							{canDelete ? (
								<ListRow
									title={copy.common.delete}
									tone="destructive"
									symbol={{ name: 'trash', fallback: 'trash-outline' }}
									accessory="none"
									onPress={() => handoff.queue('delete', () => setOpen(false))}
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

/**
 * One discovered place, drawn as web's PlaceCard: cover, name and meta are one
 * button that opens the editor, and the footer (vote, open, edit) sits beside
 * it rather than inside, because on iOS a Pressable folds its children into one
 * accessibility element and the footer controls would vanish into it.
 */
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
	const hrs = todayHours(parseHours(poi.hours), tz);
	return (
		<View style={cardStyle}>
			<Pressable
				accessibilityRole="button"
				onPress={onEdit}
				accessibilityLabel={copy.common.editLabel(poi.name)}
			>
				<Cover photo={poi.photo} seed={poi.name} category={poi.category} height={COVER_HEIGHT} />
				<View style={cardBody}>
					<Text style={cardTitle} numberOfLines={2}>
						{poi.name}
					</Text>
					<PlaceMeta poi={poi} hours={hrs} />
				</View>
			</Pressable>
			<CardFooter
				votes={poi.votes}
				mine={poi.you_voted === 1}
				busy={!!poi.voteBusy}
				name={poi.name}
				url={poi.url}
				onVote={onVote}
				onEdit={onEdit}
			/>
			<VoteRule pct={pct} />
		</View>
	);
}

/** Same family as the place card; a stay's meta is its tag and nightly price. */
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
	return (
		<View style={cardStyle}>
			<Pressable
				accessibilityRole="button"
				onPress={onEdit}
				accessibilityLabel={copy.common.editLabel(stay.name)}
			>
				<Cover photo={stay.photo} seed={stay.name} category="stay" height={COVER_HEIGHT} />
				<View style={cardBody}>
					<Text style={cardTitle} numberOfLines={2}>
						{stay.name}
					</Text>
					<Text style={metaText}>
						{stay.tag ? `${stay.tag} · ` : ''}
						{formatPerNight(stay.price_cents, stay.currency || currency)}
					</Text>
				</View>
			</Pressable>
			<CardFooter
				votes={stay.votes}
				mine={stay.you_voted === 1}
				busy={!!stay.voteBusy}
				locked={!!stay.voteLocked}
				name={stay.name}
				url={stay.url}
				onVote={onVote}
				onEdit={onEdit}
			/>
			<VoteRule pct={pct} />
		</View>
	);
}

/** Web's cover height (components/Cover.tsx defaults to 128px). */
const COVER_HEIGHT = 128;

// White surface, no border: on the grouped page colour the card needs no
// outline to read as a card, which is the iOS way. Radius 16 matches web's
// `--radius-lg` card corner; the overflow clip carries it to the cover and the
// vote rule.
const cardStyle = {
	backgroundColor: color.surface,
	borderRadius: radius.lg,
	overflow: 'hidden'
} as const;
// Web: px-4 pt-3.5 on the body, mt-1.5 mb-2.5 around the meta line.
const cardBody = { paddingHorizontal: space.lg, paddingTop: 14, paddingBottom: 10, gap: 6 };
// Web sets card names in the sans at text-lead semibold, not the serif, so the
// native card does too.
const cardTitle = type.head;
const metaText = type.footnote;

/** Rating, price band, today's hours and notes: web's MetaBits plus notes. */
function PlaceMeta({ poi, hours }: { poi: VotedPoi; hours: string | null }) {
	const price = poi.price_level != null ? '$'.repeat(Math.max(1, poi.price_level)) : null;
	if (!poi.rating && !price && !hours && !poi.notes) return null;
	return (
		<View
			style={{
				flexDirection: 'row',
				flexWrap: 'wrap',
				alignItems: 'center',
				columnGap: space.sm,
				rowGap: 2
			}}
		>
			{poi.rating ? (
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
					<AppSymbol name="star.fill" fallback="star" size={11} color={color.warn} />
					<Text style={{ ...metaText, color: color.warn, fontWeight: '600' }}>
						{poi.rating.toFixed(1)}
						{poi.rating_count ? (
							<Text style={{ color: color.inkSoft, fontWeight: '400' }}>
								{` (${poi.rating_count})`}
							</Text>
						) : null}
					</Text>
				</View>
			) : null}
			{price ? (
				<Text style={{ ...metaText, color: color.accentInk, fontWeight: '600' }}>{price}</Text>
			) : null}
			{hours ? <Text style={metaText}>{hours}</Text> : null}
			{/* Notes are multi-line; keep the author's breaks but clamp like web. */}
			{poi.notes ? (
				<Text style={{ ...metaText, maxWidth: '100%' }} numberOfLines={2}>
					{poi.notes}
				</Text>
			) : null}
		</View>
	);
}

/**
 * Web's card-controls footer: the vote pill and the open link on the left, the
 * edit pencil in the far corner. The pencil repeats what pressing the card
 * does, so the card has a control that looks like one.
 */
function CardFooter({
	votes,
	mine,
	busy,
	locked = false,
	name,
	url,
	onVote,
	onEdit
}: {
	votes: number;
	mine: boolean;
	busy: boolean;
	locked?: boolean;
	name: string;
	url: string | null | undefined;
	onVote: () => void;
	onEdit: () => void;
}) {
	// Re-checked here, as web's OpenLink does: older rows predate the write-path check.
	const href = url ? safeExternalUrl(url) : null;
	return (
		<View
			style={{
				flexDirection: 'row',
				alignItems: 'center',
				gap: 6,
				paddingHorizontal: space.lg,
				paddingTop: 10,
				paddingBottom: 14
			}}
		>
			<VotePill
				count={votes}
				mine={mine}
				busy={busy}
				locked={locked}
				label={copy.discover.card.voteLabel(mine, name)}
				onPress={onVote}
			/>
			{href ? (
				<FooterButton
					label={copy.mobileDiscover.openLabel(name)}
					symbol="safari"
					fallback="compass-outline"
					onPress={() => void Linking.openURL(href)}
				/>
			) : null}
			<FooterButton
				label={copy.common.editLabel(name)}
				symbol="pencil"
				fallback="pencil-outline"
				onPress={onEdit}
				style={{ marginLeft: 'auto' }}
			/>
		</View>
	);
}

// Web's `btn small`: 32 high, radius 10, a 1px line border on the surface. The
// hit slop brings the 32pt control up to a 44pt target, as web's `::after` does.
const FOOTER_HEIGHT = 32;
const footerHitSlop = { top: 6, bottom: 6 };
const footerButton = {
	flexDirection: 'row',
	alignItems: 'center',
	justifyContent: 'center',
	height: FOOTER_HEIGHT,
	borderRadius: radius.button,
	borderWidth: 1
} as const;

/**
 * Web's VotePill: a caret and the count as one toggle, filled in accent once
 * you have voted. While a vote is in flight the pill already shows where it
 * will land, so busy only refuses a second press (which would undo the first)
 * and does not dim it, as on web.
 */
function VotePill({
	count,
	mine,
	busy,
	locked,
	label,
	onPress
}: {
	count: number;
	mine: boolean;
	busy: boolean;
	/** Held by a vote on another stay in this city, so a press would be ignored. */
	locked: boolean;
	label: string;
	onPress: () => void;
}) {
	const ink = mine ? '#fff' : color.ink;
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityState={{ selected: mine, busy, disabled: locked }}
			disabled={busy || locked}
			onPress={onPress}
			hitSlop={footerHitSlop}
			style={({ pressed }) => [
				footerButton,
				{
					gap: 6,
					paddingHorizontal: 11,
					borderColor: mine ? color.accent : color.line,
					backgroundColor: mine ? color.accent : color.surface,
					opacity: locked ? 0.45 : pressed ? 0.7 : 1
				}
			]}
		>
			<AppSymbol name="arrowtriangle.up.fill" fallback="caret-up" size={10} color={ink} />
			<Text
				style={{
					...type.footnote,
					color: ink,
					fontWeight: '600',
					fontVariant: ['tabular-nums']
				}}
			>
				{count}
			</Text>
		</Pressable>
	);
}

function FooterButton({
	label,
	symbol,
	fallback,
	onPress,
	style
}: {
	label: string;
	symbol: string;
	fallback: 'compass-outline' | 'pencil-outline';
	onPress: () => void;
	style?: { marginLeft?: 'auto' };
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			onPress={onPress}
			hitSlop={footerHitSlop}
			style={({ pressed }) => [
				footerButton,
				{
					// Web's icon `btn small` is its padding plus a 1em glyph wide.
					width: 36,
					borderColor: color.line,
					backgroundColor: pressed ? color.surface2 : color.surface
				},
				style
			]}
		>
			<AppSymbol name={symbol} fallback={fallback} size={14} color={color.ink} />
		</Pressable>
	);
}

/**
 * Share of the group behind this option, flush with the card's bottom edge
 * (web's h-1 rule). The card clips it to the corner radius.
 */
function VoteRule({ pct }: { pct: number }) {
	return (
		<View
			style={{ height: 4, backgroundColor: color.surface2 }}
			accessibilityElementsHidden
			importantForAccessibility="no-hide-descendants"
		>
			<View
				style={{
					height: 4,
					width: `${Math.min(100, Math.max(0, pct))}%`,
					backgroundColor: color.accent
				}}
			/>
		</View>
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
