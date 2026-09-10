import { Redirect, useLocalSearchParams } from 'expo-router';

/** Discover is the landing tab, as it is on web. */
export default function TripIndex() {
	const { tripId } = useLocalSearchParams<{ tripId: string }>();
	return <Redirect href={`/trip/${tripId}/discover`} />;
}
