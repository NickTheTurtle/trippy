import { createContext, useContext, useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { Platform, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { color } from '../theme';

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
 * Mount a tab's content the first time it is shown, then keep it.
 *
 * iOS native tabs render every tab as soon as the trip opens. That was five
 * fetches and five live subscriptions per visit, and the Schedule tab asks the
 * paid routing provider about its days, even when the tab is never opened. The
 * JavaScript tabs on Android and web are already lazy, so there the content
 * mounts at once as before.
 */
export function lazyTab<P extends object>(Tab: ComponentType<P>) {
	function LazyTab(props: P) {
		const focused = useIsFocused();
		const [seen, setSeen] = useState(Platform.OS !== 'ios' || focused);
		useEffect(() => {
			if (focused) setSeen(true);
		}, [focused]);
		if (!seen) return <View style={{ flex: 1, backgroundColor: color.bg }} />;
		return <Tab {...props} />;
	}
	LazyTab.displayName = `LazyTab(${Tab.displayName ?? Tab.name})`;
	return LazyTab;
}
