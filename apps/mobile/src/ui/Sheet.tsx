import { useEffect } from 'react';
import type { ReactNode } from 'react';
import {
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
import { color, radius, space, type } from '../theme';
import { setInteractionBusy } from './busy';

/**
 * The native answer to the web app's Modal.
 *
 * Dialogs became sheets rather than centred boxes because that is what a phone
 * user expects of a form that appears over the page, and because a sheet
 * anchored to the bottom keeps its fields next to the keyboard instead of
 * behind it.
 */
export function Sheet({
	open,
	title,
	subtitle,
	onClose,
	children
}: {
	open: boolean;
	title: string;
	/** The context the dialog acts in, as on web: a city name, a trip name. */
	subtitle?: string | null;
	onClose: () => void;
	children: ReactNode;
}) {
	const { height } = useWindowDimensions();
	useEffect(() => {
		if (!open) return;
		return setInteractionBusy(true);
	}, [open]);
	return (
		<Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
			<KeyboardAvoidingView
				style={{ flex: 1 }}
				behavior={Platform.OS === 'ios' ? 'padding' : undefined}
			>
				<Pressable style={s.backdrop} onPress={onClose} />
				<View style={[s.sheet, { maxHeight: height * 0.92 }]}>
					<View style={s.grabber} />
					<View style={s.head}>
						<View style={{ flex: 1 }}>
							<Text style={type.head}>{title}</Text>
							{subtitle ? <Text style={type.faint}>{subtitle}</Text> : null}
						</View>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Close"
							onPress={onClose}
							hitSlop={12}
						>
							<Text style={{ ...type.body, color: color.inkFaint, fontSize: 20 }}>×</Text>
						</Pressable>
					</View>
					{/* The tallest form here is the expense split, which grows with the
					    roster. Capping the body and scrolling it keeps the save button
					    reachable on a large trip rather than pushed off the screen. */}
					<ScrollView
						style={{ maxHeight: height * 0.68 }}
						contentContainerStyle={{ gap: space.md }}
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
	backdrop: { flex: 1, backgroundColor: 'rgba(28,35,33,0.28)' },
	sheet: {
		backgroundColor: color.bg,
		borderTopLeftRadius: radius.lg,
		borderTopRightRadius: radius.lg,
		paddingHorizontal: space.lg,
		paddingTop: space.sm,
		paddingBottom: space.lg,
		gap: space.md
	},
	grabber: {
		alignSelf: 'center',
		width: 36,
		height: 4,
		borderRadius: 2,
		backgroundColor: color.line
	},
	head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }
});
