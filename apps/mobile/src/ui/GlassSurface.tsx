import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';

const glass = isLiquidGlassAvailable();

/**
 * A floating surface drawn in Liquid Glass where the system has it (iOS 26 and
 * later), and as the given solid surface everywhere else. Only for things that
 * float over content, such as a popover menu or a toast: iOS keeps glass for
 * that layer and draws lists and forms on solid ground, and so does this app.
 */
export function GlassSurface({
	children,
	style,
	fallback,
	tint
}: {
	children: ReactNode;
	style?: StyleProp<ViewStyle>;
	/** The solid look used where Liquid Glass is unavailable. */
	fallback: StyleProp<ViewStyle>;
	/** A colour the glass takes on, so a toast still reads as success or error. */
	tint?: string;
}) {
	if (!glass) return <View style={[style, fallback]}>{children}</View>;
	return (
		// expo-glass-effect is hoisted to the workspace root and typed against the
		// root's React Native (the web app's copy); Metro pins the app's own at run
		// time, so only the style type differs, as with expo-symbols.
		<GlassView
			glassEffectStyle="regular"
			colorScheme="light"
			tintColor={tint}
			style={style as never}
		>
			{children}
		</GlassView>
	);
}
