import { useEffect } from 'react';
import type { ReactNode } from 'react';
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	useWindowDimensions,
	View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy } from '@trippy/copy';
import { color, radius, space, type } from '../theme';
import { setInteractionBusy } from './busy';

export function Sheet({
	open,
	title,
	subtitle,
	onClose,
	onPrimary,
	primaryLabel,
	primaryBusyLabel = copy.common.saving,
	primaryBusy = false,
	primaryDisabled = false,
	children
}: {
	open: boolean;
	title: string;
	subtitle?: string | null;
	onClose: () => void;
	onPrimary?: () => void;
	primaryLabel?: string;
	primaryBusyLabel?: string;
	primaryBusy?: boolean;
	primaryDisabled?: boolean;
	children: ReactNode;
}) {
	const { height } = useWindowDimensions();
	const insets = useSafeAreaInsets();
	useEffect(() => {
		if (!open) return;
		return setInteractionBusy(true);
	}, [open]);
	const canPrimary = !!onPrimary && !!primaryLabel && !primaryBusy && !primaryDisabled;
	return (
		<Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
			<KeyboardAvoidingView
				style={{ flex: 1, justifyContent: 'flex-end' }}
				behavior={Platform.OS === 'ios' ? 'padding' : undefined}
			>
				<Pressable style={s.backdrop} onPress={onClose} />
				<View
					style={[s.sheet, { maxHeight: height * 0.94, paddingBottom: space.lg + insets.bottom }]}
				>
					<View style={s.grabber} />
					<View style={s.navBar}>
						<Pressable accessibilityRole="button" onPress={onClose} hitSlop={12} style={s.navSide}>
							<Text style={s.navAction}>{copy.common.cancel}</Text>
						</Pressable>
						<View style={s.titleBox}>
							<Text style={s.navTitle} numberOfLines={1}>
								{title}
							</Text>
							{subtitle ? (
								<Text style={s.navSubtitle} numberOfLines={1}>
									{subtitle}
								</Text>
							) : null}
						</View>
						<Pressable
							accessibilityRole="button"
							onPress={canPrimary ? onPrimary : undefined}
							hitSlop={12}
							style={[s.navSide, { alignItems: 'flex-end' }]}
						>
							{primaryBusy ? (
								<ActivityIndicator
									color={color.accent}
									size="small"
									accessibilityLabel={primaryBusyLabel}
								/>
							) : primaryLabel ? (
								<Text style={[s.navAction, primaryDisabled && { opacity: 0.35 }]}>
									{primaryLabel}
								</Text>
							) : null}
						</Pressable>
					</View>
					<ScrollView
						style={{ maxHeight: height * 0.72, flexShrink: 1 }}
						contentContainerStyle={{ gap: space.lg, paddingBottom: space.sm }}
						keyboardShouldPersistTaps="handled"
					>
						{children}
					</ScrollView>
				</View>
			</KeyboardAvoidingView>
		</Modal>
	);
}

const s = StyleSheet.create({
	backdrop: {
		position: 'absolute',
		top: 0,
		right: 0,
		bottom: 0,
		left: 0,
		backgroundColor: 'rgba(28,35,33,0.22)'
	},
	sheet: {
		backgroundColor: color.bg,
		borderTopLeftRadius: radius.sheet,
		borderTopRightRadius: radius.sheet,
		paddingHorizontal: space.lg,
		paddingTop: space.sm,
		gap: space.md,
		shadowColor: '#000',
		shadowOpacity: 0.16,
		shadowRadius: 22,
		shadowOffset: { width: 0, height: -8 }
	},
	grabber: {
		alignSelf: 'center',
		width: 38,
		height: 5,
		borderRadius: 999,
		backgroundColor: '#d1d1d6'
	},
	navBar: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.sm },
	navSide: { width: 78, minHeight: 44, justifyContent: 'center' },
	navAction: { ...type.body, color: color.accent, fontWeight: '600' },
	titleBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
	navTitle: { ...type.head, textAlign: 'center' },
	navSubtitle: { ...type.caption, textAlign: 'center' }
});
