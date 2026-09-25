import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { copy } from '@trippy/copy';
import { useAuth } from '../auth';
import { color, radius, space, type } from '../theme';
import { GlassSurface } from './GlassSurface';

/**
 * The avatar in the top right, and the menu behind it.
 *
 * The web app puts All trips in the header as a link and the rest in a
 * dropdown. On a phone the header has room for one control, so the three
 * destinations share it. The menu is a Modal rather than an absolutely
 * positioned view because a native header clips its children, and a popover
 * drawn inside it would be cut off at the header's own bottom edge.
 */
export function AccountMenu() {
	const { user, logOut } = useAuth();
	const [open, setOpen] = useState(false);

	if (!user) return null;

	const go = (run: () => void) => () => {
		setOpen(false);
		run();
	};

	return (
		<>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={user.name}
				onPress={() => setOpen(true)}
				style={({ pressed }) => [s.avatar, { opacity: pressed ? 0.7 : 1 }]}
			>
				<Text style={s.initial}>{user.name.slice(0, 1).toUpperCase()}</Text>
			</Pressable>

			<Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
				<Pressable style={s.backdrop} onPress={() => setOpen(false)}>
					{/* Stops a tap inside the menu from reaching the backdrop and
					    dismissing it before the item's own press lands. */}
					<Pressable style={s.menuFrame} onPress={() => {}}>
						<GlassSurface style={s.menu} fallback={s.menuSolid}>
							<Text style={[type.faint, { paddingHorizontal: space.md, paddingBottom: space.xs }]}>
								{user.email}
							</Text>
							<Item label={copy.trips.heading} onPress={go(() => router.replace('/trips'))} />
							<Item
								label={copy.shell.accountSettings}
								onPress={go(() => router.push('/account'))}
							/>
							<Item
								label={copy.shell.logOut}
								danger
								onPress={go(() => {
									void logOut().then(() => router.replace('/login'));
								})}
							/>
						</GlassSurface>
					</Pressable>
				</Pressable>
			</Modal>
		</>
	);
}

function Item({
	label,
	onPress,
	danger = false
}: {
	label: string;
	onPress: () => void;
	danger?: boolean;
}) {
	return (
		<Pressable
			accessibilityRole="menuitem"
			onPress={onPress}
			style={({ pressed }) => [s.item, pressed && { backgroundColor: color.surface2 }]}
		>
			<Text style={{ ...type.body, color: danger ? color.dangerInk : color.ink }}>{label}</Text>
		</Pressable>
	);
}

const s = StyleSheet.create({
	avatar: {
		width: 32,
		height: 32,
		borderRadius: 16,
		backgroundColor: color.accent,
		alignItems: 'center',
		justifyContent: 'center'
	},
	initial: { color: '#fff', fontWeight: '700', fontSize: 13 },
	backdrop: { flex: 1, backgroundColor: 'rgba(28,35,33,0.18)' },
	menuFrame: { position: 'absolute', top: 96, right: space.lg, minWidth: 200 },
	menu: { borderRadius: radius.lg, paddingVertical: space.sm, overflow: 'hidden' },
	menuSolid: { backgroundColor: color.surface, borderWidth: 1, borderColor: color.line },
	item: { paddingHorizontal: space.md, paddingVertical: 10, borderRadius: radius.sm }
});
