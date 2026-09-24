import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { copy } from '@trippy/copy';
import { color, fieldLabel, radius, space, type } from '../theme';

/**
 * Small controls that several screens need and React Native does not ship.
 */

export function CheckBox({
	checked,
	label,
	onPress
}: {
	checked: boolean;
	label: string;
	onPress: () => void;
}) {
	return (
		<Pressable
			accessibilityRole="checkbox"
			accessibilityState={{ checked }}
			accessibilityLabel={label}
			onPress={onPress}
			hitSlop={8}
			style={({ pressed }) => ({
				width: 22,
				height: 22,
				borderRadius: radius.sm,
				borderWidth: 1.5,
				borderColor: checked ? color.accent : color.line,
				backgroundColor: checked ? color.accent : color.surface,
				alignItems: 'center',
				justifyContent: 'center',
				opacity: pressed ? 0.7 : 1
			})}
		>
			{checked ? <Text style={{ color: '#fff', fontSize: 13, lineHeight: 15 }}>✓</Text> : null}
		</Pressable>
	);
}

/** An iOS-style switch between a few mutually exclusive sections. */
export function SegmentedControl({
	items,
	active,
	onPick
}: {
	items: { key: string; label: string }[];
	active: string;
	onPick: (key: string) => void;
}) {
	return (
		<View
			style={{
				flexDirection: 'row',
				backgroundColor: color.surface2,
				borderRadius: radius.md,
				padding: 3,
				gap: 3
			}}
		>
			{items.map((it) => {
				const on = it.key === active;
				return (
					<Pressable
						key={it.key}
						accessibilityRole="tab"
						accessibilityState={{ selected: on }}
						onPress={() => onPick(it.key)}
						style={{
							flex: 1,
							alignItems: 'center',
							paddingVertical: 7,
							borderRadius: radius.sm,
							backgroundColor: on ? color.surface : 'transparent'
						}}
					>
						<Text
							style={{
								...type.small,
								color: on ? color.ink : color.inkSoft,
								fontWeight: on ? '600' : '400'
							}}
						>
							{it.label}
						</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

/**
 * Picking any number of members.
 *
 * The web app uses a dropdown with checkboxes. A phone has the width for chips
 * laid out inline, which shows the whole roster at once and costs no taps to
 * open, so the same choice is made a different way rather than a dropdown being
 * squeezed onto a small screen.
 */
export function MemberPicker({
	members,
	selected,
	onToggle
}: {
	members: { id: string; name: string }[];
	selected: string[];
	onToggle: (id: string) => void;
}) {
	if (members.length === 0) return <Text style={type.faint}>No members yet.</Text>;

	return (
		<ScrollView
			horizontal
			showsHorizontalScrollIndicator={false}
			keyboardShouldPersistTaps="handled"
		>
			<View style={{ flexDirection: 'row', gap: space.sm }}>
				{members.map((m) => {
					const on = selected.includes(m.id);
					return (
						<Pressable
							key={m.id}
							onPress={() => onToggle(m.id)}
							style={({ pressed }) => ({
								paddingHorizontal: space.md,
								paddingVertical: 6,
								borderRadius: 999,
								borderWidth: 1,
								borderColor: on ? color.accent : color.line,
								backgroundColor: on ? color.accentSoft : color.surface,
								opacity: pressed ? 0.7 : 1
							})}
						>
							<Text style={{ ...type.small, color: on ? color.accentInk : color.inkSoft }}>
								{m.name}
							</Text>
						</Pressable>
					);
				})}
			</View>
		</ScrollView>
	);
}

/** Picking one of a list too long to lay out as chips, with a search box. */
export function ListPicker({
	label,
	value,
	options,
	onPick
}: {
	label: string;
	value: string;
	options: string[];
	onPick: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [q, setQ] = useState('');

	// The zone list runs to several hundred entries, so it is searched rather
	// than scrolled: chips or a wheel would both make finding one a chore.
	const shown = options.filter((o) => o.toLowerCase().includes(q.trim().toLowerCase()));

	return (
		<View style={{ gap: space.xs }}>
			<Text style={fieldLabel}>{label}</Text>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={label}
				onPress={() => {
					setQ('');
					setOpen(true);
				}}
				style={({ pressed }) => ({
					height: 44,
					justifyContent: 'center',
					paddingHorizontal: space.md,
					borderRadius: radius.sm,
					borderWidth: 1,
					borderColor: color.line,
					backgroundColor: pressed ? color.surface2 : color.surface
				})}
			>
				<Text style={type.body}>{value}</Text>
			</Pressable>

			{open ? (
				<View
					style={{
						gap: space.sm,
						borderWidth: 1,
						borderColor: color.line,
						borderRadius: radius.md,
						backgroundColor: color.surface,
						padding: space.sm,
						maxHeight: 260
					}}
				>
					<TextInput
						value={q}
						onChangeText={setQ}
						placeholder={copy.ui.searchPlaceholder}
						autoCapitalize="none"
						placeholderTextColor={color.inkFaint}
						style={{
							height: 44,
							paddingHorizontal: space.md,
							borderRadius: radius.sm,
							borderWidth: 1,
							borderColor: color.line,
							backgroundColor: color.surface,
							color: color.ink
						}}
					/>
					<ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
						{shown.map((o) => (
							<Pressable
								key={o}
								onPress={() => {
									onPick(o);
									setOpen(false);
								}}
								style={({ pressed }) => ({
									paddingVertical: 10,
									paddingHorizontal: space.sm,
									borderRadius: radius.sm,
									backgroundColor: pressed ? color.surface2 : 'transparent'
								})}
							>
								<Text style={{ ...type.body, color: o === value ? color.accentInk : color.ink }}>
									{o}
								</Text>
							</Pressable>
						))}
					</ScrollView>
				</View>
			) : null}
		</View>
	);
}

/** Picking exactly one of a short list. */
export function Picker({
	label,
	options,
	value,
	onPick
}: {
	label?: string;
	options: { key: string; label: string }[];
	value: string;
	onPick: (key: string) => void;
}) {
	return (
		<View style={{ gap: space.xs }}>
			{label ? <Text style={fieldLabel}>{label}</Text> : null}
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				keyboardShouldPersistTaps="handled"
			>
				<View style={{ flexDirection: 'row', gap: space.sm }}>
					{options.map((o) => {
						const on = o.key === value;
						return (
							<Pressable
								key={o.key}
								onPress={() => onPick(o.key)}
								style={({ pressed }) => ({
									paddingHorizontal: space.md,
									paddingVertical: 6,
									borderRadius: 999,
									borderWidth: 1,
									borderColor: on ? color.accent : color.line,
									backgroundColor: on ? color.accentSoft : color.surface,
									opacity: pressed ? 0.7 : 1
								})}
							>
								<Text style={{ ...type.small, color: on ? color.accentInk : color.inkSoft }}>
									{o.label}
								</Text>
							</Pressable>
						);
					})}
				</View>
			</ScrollView>
		</View>
	);
}

export type SearchablePickerOption = { key: string; label: string; detail?: string };

export function SearchablePicker({
	label,
	value,
	options,
	onPick,
	noMatches
}: {
	label: string;
	value: string;
	options: SearchablePickerOption[];
	onPick: (value: string) => void;
	noMatches: string;
}) {
	const [open, setOpen] = useState(false);
	const [q, setQ] = useState('');
	const current = options.find((o) => o.key === value);
	const needle = q.trim().toLowerCase();
	const shown = options.filter((o) => {
		if (!needle) return true;
		return (
			o.key.toLowerCase().includes(needle) ||
			o.label.toLowerCase().includes(needle) ||
			(o.detail ?? '').toLowerCase().includes(needle)
		);
	});

	return (
		<View style={{ gap: space.xs }}>
			<Text style={fieldLabel}>{label}</Text>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={label}
				onPress={() => {
					setQ('');
					setOpen(true);
				}}
				style={({ pressed }) => ({
					minHeight: 44,
					justifyContent: 'center',
					paddingHorizontal: space.md,
					paddingVertical: 6,
					borderRadius: radius.sm,
					borderWidth: 1,
					borderColor: color.line,
					backgroundColor: pressed ? color.surface2 : color.surface
				})}
			>
				<Text style={type.body}>{current ? current.label : value}</Text>
				{current?.detail ? <Text style={type.faint}>{current.detail}</Text> : null}
			</Pressable>

			{open ? (
				<View
					style={{
						gap: space.sm,
						borderWidth: 1,
						borderColor: color.line,
						borderRadius: radius.md,
						backgroundColor: color.surface,
						padding: space.sm,
						maxHeight: 260
					}}
				>
					<TextInput
						value={q}
						onChangeText={setQ}
						placeholder={copy.ui.searchPlaceholder}
						autoCapitalize="none"
						placeholderTextColor={color.inkFaint}
						style={{
							height: 44,
							paddingHorizontal: space.md,
							borderRadius: radius.sm,
							borderWidth: 1,
							borderColor: color.line,
							backgroundColor: color.surface,
							color: color.ink
						}}
					/>
					{shown.length === 0 ? <Text style={type.faint}>{noMatches}</Text> : null}
					<ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
						{shown.map((o) => (
							<Pressable
								key={o.key}
								onPress={() => {
									onPick(o.key);
									setOpen(false);
								}}
								style={({ pressed }) => ({
									paddingVertical: 10,
									paddingHorizontal: space.sm,
									borderRadius: radius.sm,
									backgroundColor: pressed ? color.surface2 : 'transparent'
								})}
							>
								<Text
									style={{ ...type.body, color: o.key === value ? color.accentInk : color.ink }}
								>
									{o.label}
								</Text>
								{o.detail ? <Text style={type.faint}>{o.detail}</Text> : null}
							</Pressable>
						))}
					</ScrollView>
				</View>
			) : null}
		</View>
	);
}
