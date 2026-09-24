import { useState } from 'react';
import { Pressable, RefreshControl, Text, View } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';
import { copy } from '@trippy/copy';
import { formatDayRangeShort } from '@trippy/copy/format';
import { useAuth } from '../src/auth';
import { useApi } from '../src/hooks/useApi';
import { Card, EmptyState, FormError, Loading, Screen } from '../src/ui';
import { AccountMenu } from '../src/ui/AccountMenu';
import { NewTrip } from '../src/screens/NewTrip';
import { color, font, space, type } from '../src/theme';

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
					headerShown: true,
					title: copy.trips.heading,
					headerRight: () => <AccountMenu />
				}}
			/>
			<Screen refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}>
				{error ? <FormError message={error} /> : null}

				{loading && !data ? (
					<Loading />
				) : trips.length === 0 ? (
					<EmptyState message={copy.common.nothingAdded} />
				) : (
					<View style={{ gap: space.md }}>
						{trips.map((trip) => (
							<TripCard key={trip.id} trip={trip} />
						))}
					</View>
				)}

				<Pressable
					accessibilityRole="button"
					onPress={() => setCreating(true)}
					style={({ pressed }) => ({
						alignSelf: 'flex-start',
						opacity: pressed ? 0.6 : 1
					})}
				>
					<Text style={{ ...type.body, color: color.accent, fontWeight: '600' }}>
						+ {copy.common.add}
					</Text>
				</Pressable>
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

function TripCard({ trip }: { trip: Trip }) {
	const dates =
		trip.startDate && trip.endDate ? formatDayRangeShort(trip.startDate, trip.endDate) : trip.dates;

	return (
		<Pressable
			onPress={() => router.push(`/trip/${trip.id}/discover`)}
			style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
		>
			<Card>
				<Text style={{ ...type.head, ...font.heading }}>{trip.name}</Text>
				<Text style={{ ...type.small, marginTop: 2 }}>{dates}</Text>
				<Text style={{ ...type.faint, marginTop: space.sm }}>
					{copy.trips.cityCount(trip.cities.length)} · {copy.trips.memberCount(trip.memberCount)}
				</Text>
			</Card>
		</Pressable>
	);
}
