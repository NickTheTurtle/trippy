import { Pressable, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { copy } from '@trippy/copy';
import { color, radius, space } from '../theme';
import { Button } from './index';
import { AppSymbol } from './Symbol';

// Deprecated for new sheets. R4 still uses this for the Schedule event sheet
// until that form moves to the iOS navigation-bar Save pattern.
export function SheetFooter({
	primaryLabel,
	primaryBusyLabel = copy.common.saving,
	primaryBusy = false,
	primaryDisabled = false,
	onPrimary,
	destructiveLabel,
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
							borderRadius: radius.button,
							backgroundColor: color.dangerInk,
							alignItems: 'center',
							justifyContent: 'center',
							flexDirection: 'row',
							gap: space.sm,
							opacity: pressed ? 0.82 : 1
						})}
					>
						<AppSymbol name="trash" fallback="trash-outline" size={18} color="#fff" />
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
