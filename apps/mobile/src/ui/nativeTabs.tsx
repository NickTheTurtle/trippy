import { createContext, useContext, useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { Platform, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { color } from '../theme';
import { Fab, FabClearanceContext, useFabOffset } from './Fab';
import { useCurrentTripAddAction } from './TripAddAction';

/**
 * Set by the trip layout around the iOS native tabs.
 *
 * The system tab bar floats over the tab's content, so the tab's scroll view
 * has to inset itself for it. Native tabs adjust only the scroll view present
 * when the tab first mounts, and a tab mounts with its loading state, so
 * `Screen` asks for the automatic inset itself when it is inside them.
 */
export const NativeTabsContext = createContext(false);

export function useInNativeTabs(): boolean {
	return useContext(NativeTabsContext);
}

/**
 * Every trip tab's wrapper: it draws the tab's floating Add button, and mounts
 * the tab's content the first time it is shown, then keeps it.
 *
 * The Add button is here, over the tab's content and outside its scroll view,
 * so it stays put while the list scrolls. It is the focused tab's action (see
 * TripAddAction), and a tab with nothing to add shows none.
 *
 * iOS native tabs render every tab as soon as the trip opens. That was five
 * fetches and five live subscriptions per visit, and the Schedule tab asks the
 * paid routing provider about its days, even when the tab is never opened. The
 * JavaScript tabs on Android and web are already lazy, so there the content
 * mounts at once as before.
 */
export function tripTab<P extends object>(Tab: ComponentType<P>) {
	function LazyTab(props: P) {
		const focused = useIsFocused();
		const [seen, setSeen] = useState(Platform.OS !== 'ios' || focused);
		useEffect(() => {
			if (focused) setSeen(true);
		}, [focused]);
		if (!seen) return <View style={{ flex: 1, backgroundColor: color.bg }} />;
		return (
			<FabClearanceContext.Provider value>
				<View style={{ flex: 1 }}>
					<Tab {...props} />
					<TripFab focused={focused} />
				</View>
			</FabClearanceContext.Provider>
		);
	}
	LazyTab.displayName = `TripTab(${Tab.displayName ?? Tab.name})`;
	return LazyTab;
}

/**
 * The tab's Add button. A child of its own so that a change of action (every
 * tab switch, every schedule reload) redraws only the button, not the tab; and
 * mounted for as long as the tab is, so its offset latch survives the button
 * coming and going.
 */
function TripFab({ focused }: { focused: boolean }) {
	const add = useCurrentTripAddAction();
	const offset = useFabOffset(useInNativeTabs());
	return focused && add ? <Fab onPress={add} offset={offset} /> : null;
}
