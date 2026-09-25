import { forwardRef } from 'react';
import type { ElementRef, ReactNode } from 'react';
import {
	ActivityIndicator,
	Pressable,
	ScrollView,
	StyleSheet,
	Switch,
	Text,
	TextInput,
	View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RefreshControlProps, TextInputProps, ViewStyle } from 'react-native';
import type { AccessibilityState } from 'react-native';
import {
	card,
	color,
	controlHeight,
	fieldLabel,
	hairline,
	radius,
	screenMargin,
	space,
	type
} from '../theme';
import { LiveOff } from './LiveOff';
import { AppSymbol, type AppSymbolName } from './Symbol';

type SymbolSpec = {
	name: AppSymbolName;
	fallback: React.ComponentProps<typeof AppSymbol>['fallback'];
};

type ButtonProps = {
	label: string;
	onPress: () => void;
	accessibilityLabel?: string;
	accessibilityState?: AccessibilityState;
	tone?: 'filled' | 'tinted' | 'plain' | 'primary' | 'ghost' | 'danger';
	busy?: boolean;
	disabled?: boolean;
	small?: boolean;
	style?: ViewStyle;
};

export function Button({
	label,
	onPress,
	accessibilityLabel,
	accessibilityState,
	tone = 'filled',
	busy = false,
	disabled = false,
	small = false,
	style
}: ButtonProps) {
	const off = disabled || busy;
	const normalized = (tone === 'primary' ? 'filled' : tone === 'ghost' ? 'plain' : tone) as
		'filled' | 'tinted' | 'plain' | 'danger';
	const filled = normalized === 'filled' || normalized === 'danger';
	const background =
		normalized === 'filled'
			? color.accent
			: normalized === 'danger'
				? color.dangerInk
				: normalized === 'tinted'
					? color.accentSoft
					: 'transparent';
	const labelColor = filled ? '#fff' : normalized === 'tinted' ? color.accentInk : color.accent;

	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel ?? label}
			accessibilityState={{ ...accessibilityState, disabled: off, busy }}
			onPress={off ? undefined : onPress}
			style={({ pressed }) => [
				s.button,
				{
					minHeight: small ? 34 : 50,
					paddingHorizontal: small ? space.md : space.lg,
					backgroundColor: background,
					borderColor: normalized === 'plain' ? 'transparent' : background,
					opacity: off ? 0.5 : pressed ? 0.72 : 1
				},
				style
			]}
		>
			{busy ? (
				<ActivityIndicator color={filled ? '#fff' : color.accent} size="small" />
			) : (
				<Text style={[s.buttonLabel, { color: labelColor, fontSize: small ? 15 : 17 }]}>
					{label}
				</Text>
			)}
		</Pressable>
	);
}

type FieldProps = {
	label: string;
	labelWidth?: number;
	variant?: 'stacked' | 'row' | 'bare';
	last?: boolean;
} & TextInputProps;

export const Field = forwardRef<ElementRef<typeof TextInput>, FieldProps>(
	({ label, labelWidth, variant = 'stacked', last = false, placeholder, style, ...props }, ref) => {
		if (variant === 'bare') {
			return (
				<TextInput
					ref={ref}
					accessibilityLabel={label}
					placeholder={placeholder ?? (variant === 'bare' ? '0' : undefined)}
					placeholderTextColor={color.inkFaint}
					style={[s.bareInput, style]}
					{...props}
				/>
			);
		}
		if (variant === 'row') {
			return (
				<View style={[s.formRow, !last && s.rowSeparator]}>
					<Text style={[type.body, labelWidth ? { width: labelWidth } : s.rowLabel]}>{label}</Text>
					<TextInput
						ref={ref}
						accessibilityLabel={label}
						placeholder={placeholder}
						placeholderTextColor={color.inkFaint}
						style={[s.formInput, style]}
						{...props}
					/>
				</View>
			);
		}
		return (
			<View style={{ gap: space.xs }}>
				{label ? <Text style={s.label}>{label}</Text> : null}
				<TextInput
					ref={ref}
					accessibilityLabel={label || props.accessibilityLabel}
					placeholder={placeholder}
					placeholderTextColor={color.inkFaint}
					style={[s.input, style]}
					{...props}
				/>
			</View>
		);
	}
);
Field.displayName = 'Field';

export function FormError({ message }: { message: string }) {
	if (!message) return null;
	return (
		<Text style={{ ...type.footnote, color: color.dangerInk, marginLeft: space.lg }}>
			{message}
		</Text>
	);
}

export function EmptyState({ message, hint }: { message: string; hint?: string }) {
	return (
		<View style={s.empty}>
			<Text style={{ ...type.body, color: color.inkSoft, textAlign: 'center' }}>{message}</Text>
			{hint ? <Text style={{ ...type.footnote, textAlign: 'center' }}>{hint}</Text> : null}
		</View>
	);
}

export function Screen({
	children,
	scroll = true,
	refreshControl,
	scrollEnabled = true,
	largeTitle,
	subtitle,
	action,
	safeTop = false,
	topOffset = 0
}: {
	children: ReactNode;
	scroll?: boolean;
	refreshControl?: React.ReactElement<RefreshControlProps>;
	scrollEnabled?: boolean;
	largeTitle?: string;
	subtitle?: string;
	action?: ReactNode;
	safeTop?: boolean;
	topOffset?: number;
}) {
	const insets = useSafeAreaInsets();
	const content = (
		<>
			<LiveOff />
			{largeTitle ? <LargeTitle title={largeTitle} subtitle={subtitle} action={action} /> : null}
			{children}
		</>
	);
	if (!scroll) return <View style={s.screen}>{content}</View>;
	return (
		<ScrollView
			style={{ backgroundColor: color.bg }}
			contentContainerStyle={[
				s.screenContent,
				(safeTop || topOffset > 0) && {
					paddingTop: (safeTop ? insets.top + space.lg : space.lg) + topOffset
				}
			]}
			keyboardShouldPersistTaps="handled"
			refreshControl={refreshControl}
			scrollEnabled={scrollEnabled}
		>
			{content}
		</ScrollView>
	);
}

export function LargeTitle({
	title,
	subtitle,
	action
}: {
	title: string;
	subtitle?: string;
	action?: ReactNode;
}) {
	return (
		<View style={s.largeTitleRow}>
			<View style={{ flex: 1 }}>
				{subtitle ? <Text style={s.kicker}>{subtitle}</Text> : null}
				<Text style={type.largeTitle} numberOfLines={2}>
					{title}
				</Text>
			</View>
			{action}
		</View>
	);
}

export function Loading() {
	return (
		<View style={s.centre}>
			<ActivityIndicator color={color.accent} />
		</View>
	);
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
	return <View style={[card, { padding: space.lg }, style]}>{children}</View>;
}

export function Head({ children, action }: { children: ReactNode; action?: ReactNode }) {
	return (
		<View style={s.head}>
			<Text style={type.head}>{children}</Text>
			{action}
		</View>
	);
}

export function Muted({ children }: { children: ReactNode }) {
	return <Text style={type.small}>{children}</Text>;
}

export function Rows({ children }: { children: ReactNode }) {
	return <View style={{ gap: space.md }}>{children}</View>;
}

export function InsetGroupedList({ children, style }: { children: ReactNode; style?: ViewStyle }) {
	return <View style={[s.group, style]}>{children}</View>;
}

export function InsetSection({
	title,
	children,
	style,
	footer,
	error
}: {
	title?: string;
	children: ReactNode;
	style?: ViewStyle;
	footer?: string;
	error?: string;
}) {
	return (
		<View style={[{ gap: 7 }, style]}>
			{title ? <Text style={s.sectionTitle}>{title}</Text> : null}
			<InsetGroupedList>{children}</InsetGroupedList>
			{error ? <Text style={[s.sectionFooter, { color: color.dangerInk }]}>{error}</Text> : null}
			{footer && !error ? <Text style={s.sectionFooter}>{footer}</Text> : null}
		</View>
	);
}

export function ListRow({
	title,
	subtitle,
	value,
	symbol,
	accessory = 'chevron',
	onPress,
	onSwitch,
	switchValue,
	last = false,
	tone = 'normal',
	accessibilityLabel
}: {
	title: string;
	subtitle?: string | null;
	value?: string | ReactNode;
	symbol?: SymbolSpec;
	accessory?: 'chevron' | 'checkmark' | 'switch' | 'none';
	onPress?: () => void;
	onSwitch?: (value: boolean) => void;
	switchValue?: boolean;
	last?: boolean;
	tone?: 'normal' | 'destructive';
	accessibilityLabel?: string;
}) {
	const destructive = tone === 'destructive';
	const content = (
		<View
			accessible={!onPress && accessory !== 'switch'}
			accessibilityLabel={accessibilityLabel ?? rowAccessibilityLabel(title, subtitle, value)}
			style={[s.row, !last && s.rowSeparator]}
		>
			{symbol ? (
				<View style={[s.symbolTile, destructive && { backgroundColor: color.dangerSoft }]}>
					<AppSymbol
						name={symbol.name}
						fallback={symbol.fallback}
						size={17}
						color={destructive ? color.dangerInk : color.accentInk}
					/>
				</View>
			) : null}
			<View style={{ flex: 1, gap: 2 }}>
				<Text style={[type.body, destructive && { color: color.dangerInk }]}>{title}</Text>
				{subtitle ? <Text style={type.subhead}>{subtitle}</Text> : null}
			</View>
			{typeof value === 'string' ? <Text style={type.subhead}>{value}</Text> : value}
			{accessory === 'chevron' ? (
				<Text style={s.chevron}>›</Text>
			) : accessory === 'checkmark' ? (
				<AppSymbol name="checkmark" fallback="checkmark" size={18} color={color.accent} />
			) : accessory === 'switch' ? (
				<Switch
					accessibilityLabel={accessibilityLabel ?? rowAccessibilityLabel(title, subtitle, value)}
					value={!!switchValue}
					onValueChange={onSwitch}
					trackColor={{ false: color.line, true: color.accentSoft }}
					thumbColor={switchValue ? color.accent : color.surface}
				/>
			) : null}
		</View>
	);
	if (!onPress) return content;
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel ?? rowAccessibilityLabel(title, subtitle, value)}
			onPress={onPress}
			style={({ pressed }) => ({ opacity: pressed ? 0.62 : 1 })}
		>
			{content}
		</Pressable>
	);
}

function rowAccessibilityLabel(
	title: string,
	subtitle?: string | null,
	value?: string | ReactNode
): string {
	return [title, subtitle, typeof value === 'string' ? value : null].filter(Boolean).join(', ');
}

export function DestructiveRow({
	title,
	onPress,
	accessibilityLabel
}: {
	title: string;
	onPress: () => void;
	accessibilityLabel?: string;
}) {
	return (
		<ListRow
			title={title}
			tone="destructive"
			symbol={{ name: 'trash', fallback: 'trash-outline' }}
			accessory="none"
			onPress={onPress}
			accessibilityLabel={accessibilityLabel ?? title}
			last
		/>
	);
}

export function Row({
	title,
	subtitle,
	right,
	onPress
}: {
	title: string;
	subtitle?: string | null;
	right?: ReactNode;
	onPress?: () => void;
}) {
	return (
		<ListRow
			title={title}
			subtitle={subtitle}
			value={right}
			accessory={onPress ? 'chevron' : 'none'}
			onPress={onPress}
			last
		/>
	);
}

const s = StyleSheet.create({
	screen: { flex: 1, backgroundColor: color.bg },
	screenContent: {
		paddingHorizontal: screenMargin,
		paddingTop: space.lg,
		gap: space.lg,
		paddingBottom: space.xxl
	},
	centre: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.bg },
	largeTitleRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.md },
	kicker: { ...type.caption, color: color.inkFaint, marginBottom: 1 },
	head: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: space.md,
		minHeight: 38
	},
	button: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		borderRadius: radius.section,
		borderWidth: 1
	},
	buttonLabel: { fontWeight: '600' },
	label: fieldLabel,
	formRow: {
		minHeight: controlHeight,
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: space.md,
		gap: space.md
	},
	rowLabel: { minWidth: 72, maxWidth: '45%', flexShrink: 1 },
	formInput: {
		flex: 1,
		minHeight: controlHeight,
		fontSize: 17,
		color: color.ink,
		textAlign: 'right'
	},
	input: {
		height: controlHeight,
		borderWidth: 1,
		borderColor: color.line,
		borderRadius: radius.button,
		backgroundColor: color.surface,
		paddingHorizontal: space.md,
		fontSize: 15,
		color: color.ink
	},
	bareInput: {
		minHeight: 34,
		borderWidth: hairline,
		borderColor: color.line,
		borderRadius: radius.sm,
		backgroundColor: color.surface,
		fontSize: 17,
		color: color.ink,
		paddingHorizontal: space.sm,
		paddingVertical: 0
	},
	empty: {
		alignItems: 'center',
		justifyContent: 'center',
		padding: space.xl,
		gap: space.sm
	},
	group: {
		backgroundColor: color.surface,
		borderRadius: radius.section,
		overflow: 'hidden'
	},
	sectionTitle: {
		...type.caption,
		marginLeft: space.lg,
		textTransform: 'uppercase',
		letterSpacing: 0.35
	},
	sectionFooter: {
		...type.footnote,
		marginHorizontal: space.lg
	},
	row: {
		minHeight: 52,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.md,
		paddingLeft: space.md,
		paddingRight: space.sm
	},
	rowSeparator: { borderBottomWidth: hairline, borderBottomColor: color.line },
	symbolTile: {
		width: 32,
		height: 32,
		borderRadius: radius.icon,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: color.accentSoft
	},
	chevron: { color: color.inkFaint, fontSize: 28, lineHeight: 28 }
});
