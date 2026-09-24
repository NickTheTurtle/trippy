import { forwardRef } from 'react';
import type { ElementRef, ReactNode } from 'react';
import {
	ActivityIndicator,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View
} from 'react-native';
import type { RefreshControlProps, TextInputProps, ViewStyle } from 'react-native';
import { card, color, controlHeight, fieldLabel, radius, space, type } from '../theme';

/**
 * The handful of primitives every screen is built from.
 *
 * They exist for the same reason the web app has a `ui/` folder: without them a
 * button's height, a card's radius and a field's border get restated at each
 * call site and drift apart. The names and the behaviour follow the web
 * components so the two clients stay recognisably one product.
 */

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

type ButtonProps = {
	label: string;
	onPress: () => void;
	tone?: 'primary' | 'ghost' | 'danger';
	busy?: boolean;
	disabled?: boolean;
	small?: boolean;
};

export function Button({
	label,
	onPress,
	tone = 'primary',
	busy = false,
	disabled = false,
	small = false
}: ButtonProps) {
	const off = disabled || busy;
	const tint =
		tone === 'primary' ? color.accent : tone === 'danger' ? color.dangerInk : 'transparent';

	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ disabled: off, busy }}
			onPress={off ? undefined : onPress}
			style={({ pressed }) => [
				s.button,
				{
					height: small ? 34 : controlHeight,
					paddingHorizontal: small ? space.md : space.lg,
					backgroundColor: tone === 'ghost' ? 'transparent' : tint,
					borderColor: tone === 'ghost' ? color.line : tint,
					opacity: off ? 0.5 : pressed ? 0.85 : 1
				}
			]}
		>
			{busy ? (
				<ActivityIndicator color={tone === 'ghost' ? color.ink : '#fff'} size="small" />
			) : (
				<Text
					style={[
						s.buttonLabel,
						{ color: tone === 'ghost' ? color.ink : '#fff', fontSize: small ? 14 : 15 }
					]}
				>
					{label}
				</Text>
			)}
		</Pressable>
	);
}

export const Field = forwardRef<ElementRef<typeof TextInput>, { label: string } & TextInputProps>(
	({ label, style, ...props }, ref) => (
		<View style={{ gap: space.xs }}>
			<Text style={s.label}>{label}</Text>
			<TextInput
				ref={ref}
				placeholderTextColor={color.inkFaint}
				style={[s.input, style]}
				{...props}
			/>
		</View>
	)
);
Field.displayName = 'Field';

/** The server's own refusal, shown where the user was looking when it happened. */
export function FormError({ message }: { message: string }) {
	if (!message) return null;
	return (
		<View style={s.formError}>
			<Text style={{ ...type.small, color: color.dangerInk }}>{message}</Text>
		</View>
	);
}

export function EmptyState({ message, hint }: { message: string; hint?: string }) {
	return (
		<View style={s.empty}>
			<Text style={{ ...type.body, color: color.inkSoft }}>{message}</Text>
			{hint ? <Text style={type.faint}>{hint}</Text> : null}
		</View>
	);
}

/** A full screen with the app background and consistent gutters. */
export function Screen({
	children,
	scroll = true,
	refreshControl
}: {
	children: ReactNode;
	scroll?: boolean;
	refreshControl?: React.ReactElement<RefreshControlProps>;
}) {
	if (!scroll) return <View style={s.screen}>{children}</View>;
	return (
		<ScrollView
			style={{ backgroundColor: color.bg }}
			contentContainerStyle={s.screenContent}
			keyboardShouldPersistTaps="handled"
			refreshControl={refreshControl}
		>
			{children}
		</ScrollView>
	);
}

export function Loading() {
	return (
		<View style={s.centre}>
			<ActivityIndicator color={color.accent} />
		</View>
	);
}

export function Rows({ children }: { children: ReactNode }) {
	return <View style={{ gap: space.md }}>{children}</View>;
}

/** A single line of a list: label on the left, value on the right. */
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
	const inner = (
		<View style={s.row}>
			<View style={{ flex: 1, gap: 2 }}>
				<Text style={type.body}>{title}</Text>
				{subtitle ? <Text style={type.small}>{subtitle}</Text> : null}
			</View>
			{right}
		</View>
	);
	if (!onPress) return inner;
	return (
		<Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
			{inner}
		</Pressable>
	);
}

const s = StyleSheet.create({
	screen: { flex: 1, backgroundColor: color.bg },
	screenContent: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl },
	centre: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.bg },
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
		borderRadius: radius.md,
		borderWidth: 1
	},
	buttonLabel: { fontWeight: '600' },
	label: fieldLabel,
	input: {
		height: controlHeight,
		borderWidth: 1,
		borderColor: color.line,
		borderRadius: radius.md,
		backgroundColor: color.surface,
		paddingHorizontal: space.md,
		fontSize: 15,
		color: color.ink
	},
	formError: {
		backgroundColor: color.dangerSoft,
		borderRadius: radius.md,
		paddingHorizontal: space.md,
		paddingVertical: space.sm
	},
	empty: { alignItems: 'center', gap: space.xs, paddingVertical: space.xl },
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.md,
		paddingVertical: space.sm
	}
});
