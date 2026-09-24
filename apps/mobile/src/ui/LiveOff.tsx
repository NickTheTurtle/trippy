import { Pressable, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { useLiveStatus } from '../hooks/useTripEvents';
import { color, space, type } from '../theme';

export function LiveOff() {
	const events = useLiveStatus();
	if (!events || events.status !== 'off') return null;
	return (
		<View
			style={{
				position: 'absolute',
				left: space.lg,
				right: space.lg,
				top: space.sm,
				zIndex: 10,
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
