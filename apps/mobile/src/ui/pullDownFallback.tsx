import { useState, type ComponentProps } from 'react';
import { Pressable, Text, View } from 'react-native';
import { InsetSection, ListRow } from './index';
import { Sheet } from './Sheet';
import { AppSymbol } from './Symbol';
import { useSheetHandoff } from './useSheetHandoff';
import { color, displayType, radius, space, type } from '../theme';

type IoniconName = ComponentProps<typeof AppSymbol>['fallback'];

export type PullDownOption = { key: string; label: string };
export type PullDownAction = {
	key: string;
	label: string;
	/** SF Symbol for the iOS menu; `fallback` is the Ionicon elsewhere. */
	symbol: string;
	fallback: IoniconName;
	destructive?: boolean;
	onPress: () => void;
};

export type PullDownProps = {
	/**
	 * `title` is a heading that opens a menu (the city on Discover, like Photos'
	 * "Library"); `pill` is a small capsule button beside other controls (View as).
	 */
	variant: 'title' | 'pill';
	/** The trigger's visible text: the current choice. */
	label: string;
	accessibilityLabel: string;
	/** The fallback sheet's title, and the menu's picker label. */
	title: string;
	options: PullDownOption[];
	value: string;
	onPick: (key: string) => void;
	/** Commands under the choices (Add, Edit, Delete city). */
	actions?: PullDownAction[];
};

/**
 * A pull-down: a trigger showing the current choice that opens the list of
 * choices, with a checkmark on the current one, and optionally commands below.
 *
 * On iOS this is the system menu (see PullDown.ios.tsx). This is the version
 * for Android and web, and for an iOS client without the native UI module: the
 * same trigger, opening a sheet of the same choices and commands.
 */
export function PullDownFallback({
	variant,
	label,
	accessibilityLabel,
	title,
	options,
	value,
	onPick,
	actions = []
}: PullDownProps) {
	const [open, setOpen] = useState(false);
	// A command opens another sheet, which iOS refuses while this one is still
	// closing, so it waits for this sheet's dismissal.
	const handoff = useSheetHandoff(
		Object.fromEntries(actions.map((action) => [action.key, action.onPress])) as Record<
			string,
			() => void
		>
	);
	return (
		<>
			<PullDownTrigger
				variant={variant}
				label={label}
				accessibilityLabel={accessibilityLabel}
				onPress={() => setOpen(true)}
			/>
			<Sheet open={open} title={title} onClose={() => setOpen(false)} onDismiss={handoff.flush}>
				<InsetSection>
					{options.map((option, index) => (
						<ListRow
							key={option.key}
							title={option.label}
							accessory={option.key === value ? 'checkmark' : 'none'}
							accessibilityState={{ selected: option.key === value }}
							onPress={() => {
								onPick(option.key);
								setOpen(false);
							}}
							last={index === options.length - 1}
						/>
					))}
				</InsetSection>
				{actions.length ? (
					<InsetSection>
						{actions.map((action, index) => (
							<ListRow
								key={action.key}
								title={action.label}
								symbol={{ name: action.symbol, fallback: action.fallback }}
								tone={action.destructive ? 'destructive' : 'normal'}
								accessory="none"
								onPress={() => handoff.queue(action.key, () => setOpen(false))}
								last={index === actions.length - 1}
							/>
						))}
					</InsetSection>
				) : null}
			</Sheet>
		</>
	);
}

/** The trigger, drawn to match the native menu's label. */
export function PullDownTrigger({
	variant,
	label,
	accessibilityLabel,
	onPress
}: {
	variant: PullDownProps['variant'];
	label: string;
	accessibilityLabel: string;
	onPress: () => void;
}) {
	if (variant === 'title') {
		return (
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={accessibilityLabel}
				onPress={onPress}
				hitSlop={8}
				style={({ pressed }) => ({
					flexDirection: 'row',
					alignItems: 'center',
					gap: 6,
					alignSelf: 'flex-start',
					maxWidth: '100%',
					opacity: pressed ? 0.6 : 1
				})}
			>
				<Text style={[displayType.title2, { flexShrink: 1 }]} numberOfLines={1}>
					{label}
				</Text>
				<AppSymbol name="chevron.down" fallback="chevron-down" size={14} color={color.accent} />
			</Pressable>
		);
	}
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel}
			onPress={onPress}
			hitSlop={{ top: 6, bottom: 6 }}
			style={({ pressed }) => ({
				flexDirection: 'row',
				alignItems: 'center',
				gap: 4,
				height: 32,
				maxWidth: 150,
				paddingHorizontal: space.md,
				borderRadius: radius.lg,
				backgroundColor: color.accentSoft,
				opacity: pressed ? 0.6 : 1
			})}
		>
			<View style={{ flexShrink: 1 }}>
				<Text
					numberOfLines={1}
					style={{ ...type.footnote, fontWeight: '600', color: color.accentInk }}
				>
					{label}
				</Text>
			</View>
			<AppSymbol name="chevron.down" fallback="chevron-down" size={11} color={color.accentInk} />
		</Pressable>
	);
}
