import { createContext, useRef } from 'react';
import { Pressable, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy } from '@trippy/copy';
import { color, screenMargin, space } from '../theme';
import { GlassSurface } from './GlassSurface';
import { AppSymbol } from './Symbol';

export const FAB_SIZE = 56;

/**
 * Set around a screen that shows the floating Add button, so `Screen` pads its
 * content far enough for the last row to scroll clear of the button.
 */
export const FabClearanceContext = createContext(false);
export const fabClearance = FAB_SIZE + space.lg;

/**
 * How far above the bottom the floating Add button sits, before its own gap.
 *
 * `safeArea` says whether the button stands on the safe area's bottom edge (a
 * screen with no tab bar, and the iOS native tabs, whose safe area already
 * includes the floating tab bar) or on the bottom of a JavaScript tab scene,
 * which already ends above its tab bar. The native tab bar shrinks while a list
 * scrolls down, which shrinks the safe area; the offset keeps the largest it has
 * seen so the button does not ride up and down with it. Call it from something
 * that outlives the button, so a button mounted while the bar is minimized
 * still lands where the others did.
 */
export function useFabOffset(safeArea: boolean): number {
	const insets = useSafeAreaInsets();
	const latched = useRef(0);
	latched.current = Math.max(latched.current, safeArea ? insets.bottom : 0);
	return latched.current;
}

/**
 * The floating Add button: bottom right, over the content, and fixed there,
 * `space.lg` above `offset` (see useFabOffset).
 *
 * Liquid Glass tinted in the accent where the system has it, as iOS 26 draws
 * its own floating buttons; the solid accent with a soft shadow elsewhere.
 */
export function Fab({
	onPress,
	offset,
	label = copy.common.add
}: {
	onPress: () => void;
	offset: number;
	label?: string;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			onPress={onPress}
			hitSlop={4}
			style={({ pressed }) => ({
				position: 'absolute',
				right: screenMargin,
				bottom: offset + space.lg,
				width: FAB_SIZE,
				height: FAB_SIZE,
				transform: [{ scale: pressed ? 0.94 : 1 }]
			})}
		>
			<GlassSurface
				tint={color.accent}
				style={{
					flex: 1,
					borderRadius: FAB_SIZE / 2,
					alignItems: 'center',
					justifyContent: 'center'
				}}
				fallback={{
					backgroundColor: color.accent,
					...(Platform.OS === 'android'
						? { elevation: 6 }
						: {
								shadowColor: '#000',
								shadowOpacity: 0.2,
								shadowRadius: 12,
								shadowOffset: { width: 0, height: 6 }
							})
				}}
			>
				<AppSymbol name="plus" fallback="add" size={26} color="#fff" />
			</GlassSurface>
		</Pressable>
	);
}
