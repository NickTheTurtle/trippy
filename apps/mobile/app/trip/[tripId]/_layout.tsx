import { Tabs, useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';
import type { ColorValue } from 'react-native';
import type { ComponentProps } from 'react';
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

type TabScreenOptions = NonNullable<ComponentProps<typeof Tabs.Screen>['options']>;
type TabBarIconProps = Parameters<
	NonNullable<Extract<TabScreenOptions, { tabBarIcon?: unknown }>['tabBarIcon']>
>[0];

function icon(glyph: string) {
	// react-native is duplicated in the tree: expo-router types the icon `color`
	// against the hoisted copy (0.85.x), while Text here resolves to apps/mobile's
	// 0.87 copy. RN 0.87 restructured OpaqueColorValue, so the two ColorValue types
	// are nominally different but identical at runtime; bridge them at this seam.
	return ({ color: tint, size }: TabBarIconProps) => (
		<Text style={{ color: tint as ColorValue, fontSize: size - 2 }}>{glyph}</Text>
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
				{/* `name` is the Expo file route, not a URL anyone reads, so these keep
				    their original spelling where the web slugs were renamed to match
				    their labels. */}
				<Tabs.Screen
					name="pretrip"
					options={{ title: copy.nav.preparation, tabBarIcon: icon(ICON.pretrip) }}
				/>
				<Tabs.Screen
					name="calendar"
					options={{ title: copy.nav.schedule, tabBarIcon: icon(ICON.calendar) }}
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
