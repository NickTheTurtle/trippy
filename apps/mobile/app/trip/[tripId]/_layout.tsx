import { Tabs, useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';
import type { ColorValue } from 'react-native';
import { copy } from '@trippy/copy';
import { AccountMenu } from '../../../src/ui/AccountMenu';
import { TripIdContext } from '../../../src/trip-id';
import { color, font } from '../../../src/theme';

/**
 * The five tabs of a trip, in the same order and with the same names as the
 * web app's tab bar (apps/web/src/nav.ts), so someone who knows one client can
 * use the other. Discover is the landing tab there and is the first tab here.
 *
 * The glyphs are text rather than an icon font: the app does not yet bundle
 * one, and a missing glyph would show as a blank tab. These read at tab size
 * and can be swapped for SF Symbols once a custom build is in play.
 */
const ICON = {
	discover: '◍',
	pretrip: '✓',
	calendar: '▤',
	expenses: '$',
	people: '☺'
} as const;

function icon(glyph: string) {
	return ({ color: tint, size }: { color: ColorValue; size: number }) => (
		<Text style={{ color: tint, fontSize: size - 2 }}>{glyph}</Text>
	);
}

export default function TripTabs() {
	const { tripId } = useLocalSearchParams<{ tripId: string }>();
	return (
		<TripIdContext.Provider value={tripId ?? ''}>
			<Tabs
				screenOptions={{
					headerStyle: { backgroundColor: color.bg },
					headerShadowVisible: false,
					headerTintColor: color.ink,
					headerTitleStyle: { ...font.heading, fontSize: 17 },
					headerRight: () => <AccountMenu />,
					tabBarActiveTintColor: color.accent,
					tabBarInactiveTintColor: color.inkFaint,
					tabBarStyle: { backgroundColor: color.surface, borderTopColor: color.line },
					tabBarLabelStyle: { fontSize: 11 },
					sceneStyle: { backgroundColor: color.bg }
				}}
			>
				<Tabs.Screen
					name="discover"
					options={{ title: copy.nav.discover, tabBarIcon: icon(ICON.discover) }}
				/>
				<Tabs.Screen
					name="pretrip"
					options={{ title: copy.nav.pretrip, tabBarIcon: icon(ICON.pretrip) }}
				/>
				<Tabs.Screen
					name="calendar"
					options={{ title: copy.nav.calendar, tabBarIcon: icon(ICON.calendar) }}
				/>
				<Tabs.Screen
					name="expenses"
					options={{ title: copy.nav.expenses, tabBarIcon: icon(ICON.expenses) }}
				/>
				<Tabs.Screen
					name="people"
					options={{ title: copy.nav.people, tabBarIcon: icon(ICON.people) }}
				/>
				{/* The bare /trip/:id path redirects to Discover and is not a tab. */}
				<Tabs.Screen name="index" options={{ href: null }} />
			</Tabs>
		</TripIdContext.Provider>
	);
}
