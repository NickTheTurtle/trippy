import { useMemo, useState } from 'react';
import { Linking, Pressable, RefreshControl, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { formatPerNight } from '@trippy/copy/format';
import type { DiscoverData, Poi, Stay } from '../../../src/lib/api-types';
import { api } from '../../../src/lib/api';
import { useTripId } from '../../../src/trip-id';
import { useApi } from '../../../src/hooks/useApi';
import { useMutation } from '../../../src/hooks/useMutation';
import { Card, EmptyState, FormError, Head, Loading, Screen } from '../../../src/ui';
import { AddPlace } from '../../../src/screens/AddPlace';
import { color, radius, space, type } from '../../../src/theme';

/**
 * The mobile Discover tab.
 *
 * The web page shows one city at a time with a sidebar of cities and a map
 * beside the list. Neither fits a phone, so the sidebar becomes a row of chips
 * and the map is left out: a map that is a quarter of the screen under a list
 * is worse than no map, and the schedule redesign is where trip mapping is
 * going to be settled anyway.
 */
const KINDS = [
	{ key: 'all', label: copy.discover.types.all },
	{ key: 'attraction', label: copy.discover.types.attraction },
	{ key: 'food', label: copy.discover.types.food },
	{ key: 'stay', label: copy.discover.types.stay }
] as const;

type Kind = (typeof KINDS)[number]['key'];

export default function Discover() {
	const tripId = useTripId();
	const { data, error, loading, reload } = useApi<DiscoverData>(`/trips/${tripId}/discover`);

	const [cityId, setCityId] = useState<string | null>(null);
	const [kind, setKind] = useState<Kind>('all');
	const [adding, setAdding] = useState(false);

	const city = useMemo(() => {
		if (!data?.cities.length) return null;
		return data.cities.find((c) => c.id === cityId) ?? data.cities[0];
	}, [data, cityId]);

	const vote = useMutation((path: string) => api(path, { method: 'POST' }), {
		fallback: copy.discover.errors.votePlace,
		onSuccess: reload
	});

	if (loading && !data) return <Loading />;

	if (data && data.cities.length === 0) {
		return (
			<Screen>
				<Card>
					<Head>{copy.discover.noCities.heading}</Head>
					<Text style={{ ...type.small, marginTop: space.sm }}>{copy.discover.noCities.body}</Text>
					<Text style={{ ...type.faint, marginTop: space.sm }}>
						{copy.discover.noCities.memberNote}
					</Text>
				</Card>
			</Screen>
		);
	}

	const stays = city ? (data?.stays[city.id] ?? []) : [];
	const places = city?.pois ?? [];
	const shown = kind === 'all' || kind === 'stay' ? places : places.filter((p) => p.kind === kind);
	const showStays = kind === 'all' || kind === 'stay';
	const showPlaces = kind !== 'stay';

	return (
		<>
			<Screen refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}>
				{error ? <FormError message={error} /> : null}
				<FormError message={vote.error} />

				{data && data.cities.length > 1 ? (
					<Chips
						items={data.cities.map((c) => ({ key: c.id, label: c.name }))}
						active={city?.id ?? ''}
						onPick={setCityId}
					/>
				) : null}

				<Chips
					items={KINDS.map((k) => ({ key: k.key, label: k.label }))}
					active={kind}
					onPick={(k) => setKind(k as Kind)}
				/>

				{showPlaces ? (
					<Card>
						<Head
							action={
								<Pressable onPress={() => setAdding(true)} hitSlop={8}>
									<Text style={{ ...type.body, color: color.accent, fontWeight: '600' }}>
										+ {copy.discover.header.add}
									</Text>
								</Pressable>
							}
						>
							{city?.name ?? ''}
						</Head>
						{shown.length === 0 ? (
							<EmptyState message="Nothing added yet" />
						) : (
							<View style={{ marginTop: space.sm }}>
								{shown.map((p) => (
									<PlaceRow
										key={p.id}
										poi={p}
										onVote={() => void vote.run(`/trips/${tripId}/discover/pois/${p.id}/vote`)}
									/>
								))}
							</View>
						)}
					</Card>
				) : null}

				{showStays && city ? (
					<Card>
						<Head>{copy.discover.types.stay}</Head>
						{stays.length === 0 ? (
							<EmptyState message="Nothing added yet" />
						) : (
							<View style={{ marginTop: space.sm }}>
								{stays.map((s) => (
									<StayRow
										key={s.id}
										stay={s}
										currency={data?.currency ?? 'USD'}
										onVote={() => void vote.run(`/trips/${tripId}/discover/stays/${s.id}/vote`)}
									/>
								))}
							</View>
						)}
					</Card>
				) : null}
			</Screen>

			{city ? (
				<AddPlace
					open={adding}
					tripId={tripId}
					city={{ id: city.id, name: city.name }}
					stay={kind === 'stay'}
					onClose={() => setAdding(false)}
					onAdded={() => {
						setAdding(false);
						reload();
					}}
				/>
			) : null}
		</>
	);
}

function Chips({
	items,
	active,
	onPick
}: {
	items: { key: string; label: string }[];
	active: string;
	onPick: (key: string) => void;
}) {
	return (
		<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
			{items.map((it) => {
				const on = it.key === active;
				return (
					<Pressable
						key={it.key}
						onPress={() => onPick(it.key)}
						style={({ pressed }) => ({
							paddingHorizontal: space.md,
							paddingVertical: 6,
							borderRadius: 999,
							borderWidth: 1,
							borderColor: on ? color.accent : color.line,
							backgroundColor: on ? color.accentSoft : color.surface,
							opacity: pressed ? 0.7 : 1
						})}
					>
						<Text
							style={{
								...type.small,
								color: on ? color.accentInk : color.inkSoft,
								fontWeight: on ? '600' : '400'
							}}
						>
							{it.label}
						</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

function VoteButton({
	count,
	mine,
	label,
	onPress
}: {
	count: number;
	mine: boolean;
	label: string;
	onPress: () => void;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			onPress={onPress}
			hitSlop={6}
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
				opacity: pressed ? 0.7 : 1
			})}
		>
			<Text style={{ fontSize: 13, color: mine ? color.accentInk : color.inkFaint }}>♥</Text>
			<Text style={{ ...type.small, color: mine ? color.accentInk : color.inkSoft }}>{count}</Text>
		</Pressable>
	);
}

function PlaceRow({ poi, onVote }: { poi: Poi; onVote: () => void }) {
	return (
		<View style={rowStyle}>
			<View style={{ flex: 1, gap: 2 }}>
				<Text style={type.body}>{poi.name}</Text>
				{poi.category ? <Text style={type.faint}>{poi.category}</Text> : null}
				{poi.linked > 0 ? (
					<Text style={type.faint}>{copy.discover.placeCard.onCalendar(poi.linked)}</Text>
				) : null}
			</View>
			<VoteButton
				count={poi.votes}
				mine={poi.you_voted === 1}
				label={copy.discover.card.voteLabel(poi.you_voted === 1, poi.name)}
				onPress={onVote}
			/>
		</View>
	);
}

function StayRow({ stay, currency, onVote }: { stay: Stay; currency: string; onVote: () => void }) {
	return (
		<View style={rowStyle}>
			<View style={{ flex: 1, gap: 2 }}>
				<Pressable disabled={!stay.url} onPress={() => stay.url && void Linking.openURL(stay.url)}>
					<Text style={{ ...type.body, color: stay.url ? color.accentInk : color.ink }}>
						{stay.name}
					</Text>
				</Pressable>
				<Text style={type.faint}>
					{formatPerNight(stay.price_cents, stay.currency || currency)}
				</Text>
				{stay.tag ? <Text style={type.faint}>{stay.tag}</Text> : null}
			</View>
			<VoteButton
				count={stay.votes}
				mine={stay.you_voted === 1}
				label={copy.discover.card.voteLabel(stay.you_voted === 1, stay.name)}
				onPress={onVote}
			/>
		</View>
	);
}

const rowStyle = {
	flexDirection: 'row' as const,
	alignItems: 'center' as const,
	gap: space.md,
	paddingVertical: space.sm,
	borderTopWidth: 1,
	borderTopColor: color.line
};
