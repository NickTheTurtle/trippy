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
	children,
	onDismiss,
	error,
	busy = false,
	busyLabel = copy.common.working
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
	onDismiss?: () => void;
	/**
	 * A refusal from the primary action, pinned under the title bar.
	 *
	 * The save is in the title bar, so its answer has to be next to it: an error
	 * drawn at the top of a long form is off-screen when the user is at the
	 * bottom, and a toast cannot help because the app's toast renders under
	 * this Modal on iOS.
	 */
	error?: string | null;
	/**
	 * Something started from inside the sheet is running (a delete confirmed
	 * over it): Cancel, the primary action and a swipe are all held, and the
	 * primary slot shows the spinner, until it settles.
	 */
	busy?: boolean;
	busyLabel?: string;
}) {
	const { height } = useWindowDimensions();
	const insets = useSafeAreaInsets();
	useEffect(() => {
		if (!open) return;
		return setInteractionBusy(true);
	}, [open]);
	const spinning = primaryBusy || busy;
	const canPrimary = !!onPrimary && !!primaryLabel && !spinning && !primaryDisabled;
	// A refused swipe on iOS still arrives as a close request, so the request
	// itself has to be ignored while a save or a delete is running.
	const requestClose = spinning ? () => {} : onClose;
	const bar = (
		<>
			<View style={s.grabber} />
			<View style={s.navBar}>
				<Pressable
					accessibilityRole="button"
					accessibilityState={{ disabled: busy }}
					onPress={busy ? undefined : onClose}
					hitSlop={12}
					style={s.navSide}
				>
					<Text style={[s.navAction, busy && { opacity: 0.35 }]}>{copy.common.cancel}</Text>
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
				{primaryLabel || spinning ? (
					<Pressable
						accessibilityRole="button"
						accessibilityState={{ disabled: primaryDisabled, busy: spinning }}
						onPress={canPrimary ? onPrimary : undefined}
						hitSlop={12}
						style={[s.navSide, { alignItems: 'flex-end' }]}
					>
						{spinning ? (
							<ActivityIndicator
								color={color.accent}
								size="small"
								accessibilityLabel={primaryBusy ? primaryBusyLabel : busyLabel}
							/>
						) : primaryLabel ? (
							<Text style={[s.navAction, primaryDisabled && { opacity: 0.35 }]}>
								{primaryLabel}
							</Text>
						) : null}
					</Pressable>
				) : (
					<View style={s.navSide} />
				)}
			</View>
			{error ? (
				<Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={s.error}>
					{error}
				</Text>
			) : null}
		</>
	);

	if (Platform.OS === 'ios') {
		// The system page sheet: the app behind shrinks back and dims, the sheet
		// follows a swipe down, and the motion is UIKit's own rather than a view
		// sliding over a shadow. A swipe is a Cancel, refused while a save or a
		// delete is running so its answer is not lost with the sheet.
		return (
			<Modal
				visible={open}
				presentationStyle="pageSheet"
				animationType="slide"
				allowSwipeDismissal={!spinning}
				onRequestClose={requestClose}
				onDismiss={onDismiss}
			>
				<View style={[s.sheet, s.page]}>
					{bar}
					<ScrollView
						style={{ flex: 1 }}
						contentContainerStyle={{ gap: space.lg, paddingBottom: space.xl + insets.bottom }}
						keyboardShouldPersistTaps="handled"
						keyboardDismissMode="interactive"
						// The sheet sits below the top of the screen, so a
						// KeyboardAvoidingView measured against its own frame would
						// under-pad by that offset. The scroll view's native keyboard
						// inset is computed in screen space and is right in any sheet.
						automaticallyAdjustKeyboardInsets
					>
						{children}
					</ScrollView>
				</View>
			</Modal>
		);
	}

	return (
		<Modal
			visible={open}
			transparent
			animationType="slide"
			onRequestClose={onClose}
			onDismiss={onDismiss}
		>
			<KeyboardAvoidingView style={{ flex: 1, justifyContent: 'flex-end' }}>
				<Pressable style={s.backdrop} onPress={onClose} />
				<View
					style={[
						s.sheet,
						s.drawer,
						{ maxHeight: height * 0.94, flexShrink: 1, paddingBottom: space.lg + insets.bottom }
					]}
				>
					{bar}
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
		paddingHorizontal: space.lg,
		paddingTop: space.sm,
		gap: space.md
	},
	page: { flex: 1 },
	drawer: {
		borderTopLeftRadius: radius.sheet,
		borderTopRightRadius: radius.sheet,
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
	navSubtitle: { ...type.caption, textAlign: 'center' },
	error: {
		...type.footnote,
		color: color.dangerInk,
		backgroundColor: color.dangerSoft,
		borderRadius: radius.md,
		paddingHorizontal: space.md,
		paddingVertical: space.sm,
		marginBottom: space.sm
	}
});
