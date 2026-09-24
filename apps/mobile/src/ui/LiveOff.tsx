import { Pressable, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { useLiveStatus } from '../hooks/useTripEvents';
import { color, space, type } from '../theme';

/**
 * The line that says live updates have stopped, with the way to restart them.
 *
 * Drawn in the flow at the top of each trip screen (`Screen` renders it), not
 * floated over the layout. Floated, it sat at the top of a wrapper that starts
 * at the very top of the display, because the trip route hides the stack
 * header, so on a notched or edge-to-edge phone it covered the status bar.
 * Outside a trip there is no live stream and this renders nothing.
 */
export function LiveOff() {
	const events = useLiveStatus();
	if (!events || events.status !== 'off') return null;
	return (
		<View
			style={{
				flexDirection: 'row',
				flexWrap: 'wrap',
				gap: space.sm,
				alignItems: 'center',
				backgroundColor: color.bg
			}}
		>
			<Text style={type.faint}>•</Text>
			<Text style={type.faint}>{copy.tripShell.liveOff}</Text>
			<Pressable onPress={events.retry} hitSlop={8}>
				<Text style={{ ...type.small, color: color.accent, fontWeight: '600' }}>
					{copy.tripShell.reconnect}
				</Text>
			</Pressable>
		</View>
	);
}
