import { Pressable, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { useLiveStatus } from '../hooks/useTripEvents';
import { color, radius, space, type } from '../theme';
import { AppSymbol } from './Symbol';

export function LiveOff() {
	const events = useLiveStatus();
	if (!events || events.status !== 'off') return null;
	return (
		<View
			style={{
				flexDirection: 'row',
				gap: space.sm,
				alignItems: 'center',
				backgroundColor: color.warnSoft,
				borderRadius: radius.section,
				paddingHorizontal: space.md,
				paddingVertical: space.sm
			}}
		>
			<AppSymbol name="wifi.slash" fallback="wifi-outline" size={16} color={color.warn} />
			<Text style={{ ...type.footnote, color: color.inkSoft, flex: 1 }}>
				{copy.tripShell.liveOff}
			</Text>
			<Pressable onPress={events.retry} hitSlop={8}>
				<Text style={{ ...type.footnote, color: color.accent, fontWeight: '600' }}>
					{copy.tripShell.reconnect}
				</Text>
			</Pressable>
		</View>
	);
}
