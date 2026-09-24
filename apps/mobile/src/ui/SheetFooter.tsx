import { Pressable, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { copy } from '@trippy/copy';
import { color, radius, space } from '../theme';
import { Button } from './index';

export function SheetFooter({
	primaryLabel,
	primaryBusyLabel = copy.common.saving,
	primaryBusy = false,
	primaryDisabled = false,
	onPrimary,
	destructiveLabel,
	destructiveIcon = '🗑',
	onDestructive,
	children
}: {
	primaryLabel?: string;
	primaryBusyLabel?: string;
	primaryBusy?: boolean;
	primaryDisabled?: boolean;
	onPrimary?: () => void;
	destructiveLabel?: string;
	destructiveIcon?: string;
	onDestructive?: () => void;
	children?: ReactNode;
}) {
	return (
		<View style={{ gap: space.sm }}>
			{children}
			<View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
				{onDestructive && destructiveLabel ? (
					<Pressable
						accessibilityRole="button"
						accessibilityLabel={destructiveLabel}
						onPress={onDestructive}
						style={({ pressed }) => ({
							height: 44,
							width: primaryLabel ? 44 : undefined,
							flex: primaryLabel ? undefined : 1,
							borderRadius: radius.md,
							borderWidth: 1,
							borderColor: color.dangerInk,
							backgroundColor: color.dangerInk,
							alignItems: 'center',
							justifyContent: 'center',
							flexDirection: 'row',
							gap: space.sm,
							opacity: pressed ? 0.82 : 1
						})}
					>
						<Text style={{ color: '#fff', fontSize: 18 }}>{destructiveIcon}</Text>
						{primaryLabel ? null : (
							<Text style={{ color: '#fff', fontWeight: '600' }}>{copy.common.delete}</Text>
						)}
					</Pressable>
				) : null}
				{primaryLabel && onPrimary ? (
					<View style={{ flex: 1 }}>
						<Button
							label={primaryBusy ? primaryBusyLabel : primaryLabel}
							onPress={onPrimary}
							busy={primaryBusy}
							disabled={primaryDisabled}
						/>
					</View>
				) : null}
			</View>
		</View>
	);
}
