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
import type {
	AccessibilityRole,
	RefreshControlProps,
	StyleProp,
	TextInputProps,
	ViewStyle
} from 'react-native';
import type { AccessibilityState } from 'react-native';
import {
	blockGap,
	card,
	color,
	controlHeight,
	fieldLabel,
	hairline,
	radius,
	rowInset,
	rowMinHeight,
	rowPadY,
	screenMargin,
	space,
	type
} from '../theme';
import { EmptyMark } from './EmptyMark';
import { LiveOff } from './LiveOff';
import { useInNativeTabs } from './nativeTabs';
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
			const stacked = label.length > 20;
			return (
				<View style={[stacked ? s.formRowStacked : s.formRow, !last && s.rowSeparator]}>
					<Text
						numberOfLines={stacked ? undefined : 1}
						style={[type.body, labelWidth ? { width: labelWidth } : s.rowLabel]}
					>
						{label}
					</Text>
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

/**
 * The shared "there is nothing here" state, drawn the iOS way: no card, centred
 * in the space the list would have used, so an empty tab reads as a calm page
 * rather than as a white box with one grey sentence in it.
 *
 * It follows the web component's two shapes (see apps/web EmptyState). With
 * `graphic`, the fly drawing then the caption, for a list you fill by adding to
 * it. Without it, the caption alone, for a state the app computed ("Everyone is
 * even"), which is an answer rather than an absence. `action` is for the one
 * screen whose empty state has a single thing to do next.
 */
export function EmptyState({
	message,
	hint,
	graphic = false,
	symbol,
	title,
	action
}: {
	message: string;
	hint?: string;
	graphic?: boolean;
	/** A first-run page's own mark, in a soft tile, instead of the fly. */
	symbol?: SymbolSpec;
	title?: string;
	action?: ReactNode;
}) {
	return (
		<View style={s.empty}>
			{graphic ? <EmptyMark /> : null}
			{symbol ? (
				<View style={s.emptyTile}>
					<AppSymbol
						name={symbol.name}
						fallback={symbol.fallback}
						size={26}
						color={color.accentInk}
					/>
				</View>
			) : null}
			<View style={{ gap: space.xs, alignItems: 'center' }}>
				{title ? <Text style={{ ...type.title3, textAlign: 'center' }}>{title}</Text> : null}
				<Text style={{ ...type.body, color: color.inkSoft, textAlign: 'center' }}>{message}</Text>
				{hint ? <Text style={{ ...type.footnote, textAlign: 'center' }}>{hint}</Text> : null}
			</View>
			{action ? <View style={{ marginTop: space.sm }}>{action}</View> : null}
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
	const inTabs = useInNativeTabs();
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
			contentInsetAdjustmentBehavior={inTabs ? 'automatic' : undefined}
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

export function SectionHeader({ children, action }: { children: string; action?: ReactNode }) {
	return (
		<View style={s.sectionHeader}>
			<Text style={[s.sectionTitle, { flex: 1, marginLeft: 0 }]}>{children}</Text>
			{action}
		</View>
	);
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
			{title ? <SectionHeader>{title}</SectionHeader> : null}
			<InsetGroupedList>{children}</InsetGroupedList>
			{error ? <Text style={[s.sectionFooter, { color: color.dangerInk }]}>{error}</Text> : null}
			{footer && !error ? <Text style={s.sectionFooter}>{footer}</Text> : null}
		</View>
	);
}

/** The iOS disclosure chevron: a small, light glyph, not a large text character. */
export function Chevron() {
	return (
		<AppSymbol name="chevron.right" fallback="chevron-forward" size={14} color={color.inkFaint} />
	);
}

/**
 * One row of an inset-grouped list, and the geometry every row shares.
 *
 * The row's leading item (an icon tile, avatar or checkbox) sits in the row's
 * own inset; the hairline below the row is drawn on the body beside it, so it
 * starts where the text does, the way iOS lists draw it. The body carries the
 * vertical padding, so a row of any number of lines keeps the same margin
 * above and below its text instead of touching the card.
 */
export function GroupedRow({
	leading,
	children,
	trailing,
	accessory = 'none',
	onPress,
	last = false,
	accessible,
	accessibilityRole,
	accessibilityLabel,
	accessibilityState,
	bodyStyle,
	alignTop = false
}: {
	leading?: ReactNode;
	children: ReactNode;
	trailing?: ReactNode;
	accessory?: 'chevron' | 'none';
	onPress?: () => void;
	last?: boolean;
	accessible?: boolean;
	accessibilityRole?: AccessibilityRole;
	accessibilityLabel?: string;
	accessibilityState?: AccessibilityState;
	bodyStyle?: StyleProp<ViewStyle>;
	/**
	 * Pin the leading item to the first line rather than centring it, for rows
	 * that grow downwards (a task with its people under it), the way Reminders
	 * keeps its circle beside the title.
	 */
	alignTop?: boolean;
}) {
	const content = (
		<View
			style={[s.row, alignTop && { alignItems: 'flex-start' }]}
			accessible={onPress ? undefined : accessible}
			accessibilityLabel={onPress ? undefined : accessibilityLabel}
			accessibilityState={onPress ? undefined : accessibilityState}
		>
			{leading ? (
				<View style={[s.rowLeading, alignTop && { marginTop: rowPadY - 1 }]}>{leading}</View>
			) : null}
			<View style={[s.rowBody, !last && s.rowSeparator, bodyStyle]}>
				<View style={{ flex: 1, gap: 2 }}>{children}</View>
				{trailing}
				{accessory === 'chevron' ? <Chevron /> : null}
			</View>
		</View>
	);
	if (!onPress) return content;
	return (
		<Pressable
			accessibilityRole={accessibilityRole ?? 'button'}
			accessibilityLabel={accessibilityLabel}
			accessibilityState={accessibilityState}
			onPress={onPress}
			style={({ pressed }) => ({ opacity: pressed ? 0.62 : 1 })}
		>
			{content}
		</Pressable>
	);
}

export function ListRow({
	title,
	subtitle,
	detail,
	value,
	symbol,
	leading,
	accessory = 'chevron',
	onPress,
	onSwitch,
	switchValue,
	last = false,
	tone = 'normal',
	accessibilityLabel,
	accessibilityState
}: {
	title: string;
	subtitle?: string | null;
	detail?: string | null;
	value?: string | ReactNode;
	symbol?: SymbolSpec;
	leading?: ReactNode;
	accessory?: 'chevron' | 'checkmark' | 'switch' | 'none';
	onPress?: () => void;
	onSwitch?: (value: boolean) => void;
	switchValue?: boolean;
	last?: boolean;
	tone?: 'normal' | 'destructive';
	accessibilityLabel?: string;
	accessibilityState?: AccessibilityState;
}) {
	const destructive = tone === 'destructive';
	const label = accessibilityLabel ?? rowAccessibilityLabel(title, subtitle, detail, value);
	const lead =
		leading ??
		(symbol ? (
			<View style={[s.symbolTile, destructive && { backgroundColor: color.dangerSoft }]}>
				<AppSymbol
					name={symbol.name}
					fallback={symbol.fallback}
					size={17}
					color={destructive ? color.dangerInk : color.accentInk}
				/>
			</View>
		) : null);
	const trailing = (
		<>
			{typeof value === 'string' ? (
				<Text style={s.rowValue} numberOfLines={2}>
					{value}
				</Text>
			) : (
				value
			)}
			{accessory === 'checkmark' ? (
				<AppSymbol name="checkmark" fallback="checkmark" size={18} color={color.accent} />
			) : accessory === 'switch' ? (
				<Switch
					accessibilityLabel={label}
					value={!!switchValue}
					onValueChange={onSwitch}
					trackColor={{ false: color.line, true: color.accentSoft }}
					thumbColor={switchValue ? color.accent : color.surface}
				/>
			) : null}
		</>
	);
	return (
		<GroupedRow
			leading={lead}
			trailing={trailing}
			accessory={accessory === 'chevron' ? 'chevron' : 'none'}
			onPress={onPress}
			last={last}
			accessible={accessory !== 'switch'}
			accessibilityLabel={label}
			accessibilityState={accessibilityState}
		>
			<Text style={[type.body, destructive && { color: color.dangerInk }]}>{title}</Text>
			{subtitle ? <Text style={type.subhead}>{subtitle}</Text> : null}
			{detail ? (
				<Text style={type.subhead} numberOfLines={1}>
					{detail}
				</Text>
			) : null}
		</GroupedRow>
	);
}

function rowAccessibilityLabel(
	title: string,
	subtitle?: string | null,
	detail?: string | null,
	value?: string | ReactNode
): string {
	return [title, subtitle, detail, typeof value === 'string' ? value : null]
		.filter(Boolean)
		.join(', ');
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
		flexGrow: 1,
		paddingHorizontal: screenMargin,
		paddingTop: space.lg,
		gap: blockGap,
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
		marginLeft: rowInset,
		paddingRight: rowInset,
		gap: space.md
	},
	formRowStacked: {
		minHeight: controlHeight,
		marginLeft: rowInset,
		paddingRight: rowInset,
		paddingVertical: space.sm,
		gap: space.xs
	},
	// The label keeps its whole width and never wraps: a two-line label in a
	// Settings-style row reads as broken. The input takes what is left, down to
	// a floor, and its own text scrolls within that.
	rowLabel: { flexShrink: 0, maxWidth: '60%' },
	formInput: {
		flex: 1,
		minWidth: 96,
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
		flexGrow: 1,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: space.xl,
		paddingVertical: 48,
		gap: space.md
	},
	emptyTile: {
		width: 56,
		height: 56,
		borderRadius: radius.section,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: color.accentSoft
	},
	group: {
		backgroundColor: color.surface,
		borderRadius: radius.section,
		overflow: 'hidden'
	},
	sectionHeader: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.md,
		marginHorizontal: rowInset
	},
	sectionTitle: {
		...type.caption,
		marginLeft: rowInset,
		textTransform: 'uppercase',
		letterSpacing: 0.35
	},
	sectionFooter: {
		...type.footnote,
		marginHorizontal: rowInset
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingLeft: rowInset
	},
	rowLeading: { marginRight: space.md },
	rowBody: {
		flex: 1,
		minHeight: rowMinHeight,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingVertical: rowPadY,
		paddingRight: rowInset
	},
	rowSeparator: { borderBottomWidth: hairline, borderBottomColor: color.line },
	// A long value (a picked place, a journey name) wraps within its share of
	// the row rather than squeezing the row's label down to a sliver.
	rowValue: { ...type.subhead, flexShrink: 1, maxWidth: '60%', textAlign: 'right' },
	symbolTile: {
		width: 30,
		height: 30,
		borderRadius: radius.icon,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: color.accentSoft
	}
});
