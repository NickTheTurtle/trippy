import { useState } from 'react';
import { Platform, Pressable, RefreshControl, Text, View } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';
import { copy } from '@trippy/copy';
import { formatDayRangeShort } from '@trippy/copy/format';
import { useAuth } from '../src/auth';
import { useApi } from '../src/hooks/useApi';
import { EmptyState, FormError, InsetGroupedList, ListRow, Loading, Screen } from '../src/ui';
import { AppSymbol } from '../src/ui/Symbol';
import { AccountMenu } from '../src/ui/AccountMenu';
import { NewTrip } from '../src/screens/NewTrip';
import { color, headerEdge, space, type } from '../src/theme';

type City = { id: string; name: string; photo: string | null };
type Trip = {
	id: string;
	name: string;
	dates: string;
	cover: string;
	role: string;
	cities: City[];
	memberCount: number;
	startDate?: string;
	endDate?: string;
};

export default function Trips() {
	const { user, loading: authLoading } = useAuth();
	const { data, error, loading, reload } = useApi<{ trips: Trip[] }>(user ? '/trips' : null);
	const [creating, setCreating] = useState(false);

	if (authLoading) return <Loading />;
	if (!user) return <Redirect href={{ pathname: '/login', params: { next: '/trips' } }} />;

	const trips = data?.trips ?? [];

	return (
		<>
			<Stack.Screen
				options={{
					title: Platform.OS === 'web' ? '' : copy.trips.heading,
					headerLargeTitle: true,
					headerRight: () => (
						<View
							style={{
								flexDirection: 'row',
								alignItems: 'center',
								gap: space.lg,
								marginRight: headerEdge
							}}
						>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={copy.common.add}
								onPress={() => setCreating(true)}
								hitSlop={10}
							>
								<AppSymbol name="plus" fallback="add" size={22} color={color.accent} />
							</Pressable>
							<AccountMenu />
						</View>
					)
				}}
			/>
			<Screen
				largeTitle={Platform.OS === 'web' ? copy.trips.heading : undefined}
				refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}
			>
				{error ? <FormError message={error} /> : null}
				{loading && !data ? (
					<Loading />
				) : trips.length === 0 ? (
					<EmptyState graphic message={copy.common.nothingAdded} />
				) : (
					<InsetGroupedList>
						{trips.map((trip, index) => (
							<TripRow key={trip.id} trip={trip} last={index === trips.length - 1} />
						))}
					</InsetGroupedList>
				)}
			</Screen>
			<NewTrip
				open={creating}
				onClose={() => setCreating(false)}
				onCreated={(id) => {
					setCreating(false);
					router.push(`/trip/${id}/discover`);
				}}
			/>
		</>
	);
}

function TripRow({ trip, last }: { trip: Trip; last: boolean }) {
	const dates =
		trip.startDate && trip.endDate ? formatDayRangeShort(trip.startDate, trip.endDate) : trip.dates;
	const cityNames = trip.cities.map((city) => city.name).join(', ');
	return (
		<ListRow
			title={trip.name}
			subtitle={`${dates}${cityNames ? ` · ${cityNames}` : ''}`}
			value={copy.trips.memberCount(trip.memberCount)}
			symbol={{ name: 'airplane', fallback: 'airplane-outline' }}
			onPress={() => router.push(`/trip/${trip.id}/discover`)}
			last={last}
		/>
	);
}
