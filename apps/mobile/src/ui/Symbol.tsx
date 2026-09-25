import Ionicons from '@expo/vector-icons/Ionicons';
import { SymbolView } from 'expo-symbols';
import { Platform, View } from 'react-native';
import type { ComponentProps } from 'react';
import type { ColorValue, StyleProp, ViewStyle } from 'react-native';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

export type AppSymbolName = string | { ios?: string; android?: string; web?: string };

export function AppSymbol({
	name,
	fallback,
	size = 20,
	color,
	style
}: {
	name: AppSymbolName;
	fallback: IoniconName;
	size?: number;
	color: ColorValue;
	style?: StyleProp<ViewStyle>;
}) {
	if (Platform.OS === 'ios') {
		return (
			<SymbolView
				name={name as never}
				size={size}
				tintColor={color}
				weight="semibold"
				fallback={<Ionicons name={fallback} size={size} color={color} />}
				style={style as never}
			/>
		);
	}
	return (
		<View style={style}>
			<Ionicons name={fallback} size={size} color={color} />
		</View>
	);
}
