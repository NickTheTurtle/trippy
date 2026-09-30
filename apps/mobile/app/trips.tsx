import { useState } from 'react';
import { Platform, Pressable, RefreshControl, Text, View } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';
import { copy } from '@trippy/copy';
import { parseCoverGradient } from '@trippy/core/cover';
import { useAuth } from '../src/auth';
import { useApi } from '../src/hooks/useApi';
import { EmptyState, FormError, Loading, Screen } from '../src/ui';
import { AppSymbol } from '../src/ui/Symbol';
import { EmptyMark } from '../src/ui/EmptyMark';
import { AccountMenu } from '../src/ui/AccountMenu';
import { Cover } from '../src/ui/Cover';
import { Tag } from '../src/ui/marks';
import { NewTrip } from '../src/screens/NewTrip';
import {
	color,
	displayType,
	headerEdge,
	largeTitleHeaderStyle,
	radius,
	space,
	type
} from '../src/theme';

/**
 * What GET /trips sends (listTripsForUser), as far as the card reads it. The
 * list has no camelCase start and end dates, only the server's `dates` label,
 * which is also what the web card shows.
 */
type City = { id: string; name: string; photo: string | null };
type Trip = {
	id: string;
	name: string;
	dates: string;
	cover: string;
	role: string;
	cities: City[];
	memberCount: number;
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
					headerStyle: largeTitleHeaderStyle,
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
				nativeLargeTitle
				largeTitle={Platform.OS === 'web' ? copy.trips.heading : undefined}
				refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}
			>
				{error ? <FormError message={error} /> : null}
				{loading && !data ? (
					<Loading />
				) : trips.length === 0 ? (
					<EmptyState graphic message={copy.common.nothingAdded} />
				) : (
					<>
						{/* Its own stack: the screen spaces blocks 24pt apart, and cards
						    that far apart read as unrelated rather than as one list. */}
						<View style={{ gap: space.lg }}>
							{trips.map((trip) => (
								<TripCard key={trip.id} trip={trip} />
							))}
						</View>
						{/* A lone card leaves the lower half of the phone bare, which read
						    as unfinished. The fly fills that space, with no caption since
						    the list is not empty. Cards are about 280pt tall, so two
						    already fill most of the screen and do not need it. */}
						{trips.length < SPARSE_TRIPS ? (
							<View style={styles.sparse}>
								<EmptyMark />
							</View>
						) : null}
					</>
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

/**
 * The web's TripCard (apps/web/src/pages/Trips.tsx): cover, city count, name,
 * dates, role and head count. Drawn the iOS way: a borderless white card with
 * a faint shadow rather than the web's hairline border, and one Pressable, so
 * VoiceOver reads the card as a single button named by the trip and its dates.
 */
function TripCard({ trip }: { trip: Trip }) {
	const first = trip.cities[0] ?? null;
	// Capitalised like the web's `chip accent capitalize`. Tag draws it in
	// capitals on screen; this is the spelling that reaches the label text.
	const role = trip.role.charAt(0).toUpperCase() + trip.role.slice(1);
	return (
		<Pressable
			accessibilityRole="button"
			// The whole card is one element to VoiceOver, so everything it shows is
			// in its name: the chip, the role and the headcount, not just the title.
			accessibilityLabel={[
				trip.name,
				trip.dates,
				copy.trips.cityCount(trip.cities.length),
				role,
				copy.trips.memberCount(trip.memberCount)
			].join(', ')}
			onPress={() => router.push(`/trip/${trip.id}/discover`)}
			style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
		>
			{/* The shadow sits on the Pressable and the clipping on this inner
			    view: iOS drops the shadow of a view that clips its own content. */}
			<View style={styles.clip}>
				{/* The trip's own gradient stays the fallback, as on web, so a trip
				    with no cities yet, or whose first city has no picture, keeps
				    the cover it always had. */}
				<Cover
					photo={first?.photo ?? null}
					seed={trip.name}
					height={150}
					gradient={first?.photo ? undefined : parseCoverGradient(trip.cover)}
					glyph={false}
				>
					<View style={styles.chip}>
						<Text style={styles.chipText}>{copy.trips.cityCount(trip.cities.length)}</Text>
					</View>
				</Cover>
				<View style={styles.body}>
					<Text style={displayType.title3}>{trip.name}</Text>
					<Text style={[type.subhead, styles.dates]}>{trip.dates}</Text>
					<View style={styles.meta}>
						<Tag label={role} tone="accent" caps={false} />
						<Text style={type.footnote}>{copy.trips.memberCount(trip.memberCount)}</Text>
					</View>
				</View>
			</View>
		</Pressable>
	);
}

/** Below this many trips the fly fills the space under the list. */
const SPARSE_TRIPS = 2;

const styles = {
	card: {
		backgroundColor: color.surface,
		borderRadius: radius.lg,
		// iOS only: an Android elevation shadow reads heavier than the web's
		// card, and the web preview has the page colour to set the card apart.
		...Platform.select({
			ios: {
				shadowColor: '#000',
				shadowOpacity: 0.06,
				shadowRadius: 10,
				shadowOffset: { width: 0, height: 2 }
			},
			default: {}
		})
	},
	clip: { borderRadius: radius.lg, overflow: 'hidden' as const },
	// The web's `chip` on `bg-white/85`, 16pt in from the cover's corner so it
	// lines up with the name under it.
	chip: {
		position: 'absolute' as const,
		top: space.lg,
		left: space.lg,
		backgroundColor: 'rgba(255, 255, 255, 0.85)',
		borderRadius: 999,
		paddingHorizontal: 10,
		paddingVertical: 3
	},
	chipText: { ...type.footnote, color: color.ink, fontWeight: '500' as const },
	body: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.lg + 2 },
	dates: { marginTop: 2 },
	meta: {
		flexDirection: 'row' as const,
		alignItems: 'center' as const,
		flexWrap: 'wrap' as const,
		gap: 10,
		marginTop: space.md
	},
	sparse: {
		flexGrow: 1,
		alignItems: 'center' as const,
		justifyContent: 'center' as const,
		paddingVertical: space.xxl
	}
};
