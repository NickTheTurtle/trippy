import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import NativeSegmentedControl from '@react-native-segmented-control/segmented-control';
import { copy } from '@trippy/copy';
import { formatDay } from '@trippy/copy/format';
import { clock } from '../screens/schedule/shared';
import { color, fieldLabel, radius, space, type } from '../theme';
import { AppSymbol } from './Symbol';
import { normalizeTimePickerMinutes } from './time';

export function CheckBox({
	checked,
	label,
	onPress,
	state
}: {
	checked: boolean;
	label: string;
	onPress: () => void;
	state?: 'checked' | 'mixed' | 'unchecked';
}) {
	const visual = state ?? (checked ? 'checked' : 'unchecked');
	return (
		<Pressable
			accessibilityRole="checkbox"
			accessibilityState={{ checked: visual === 'mixed' ? 'mixed' : visual === 'checked' }}
			accessibilityLabel={label}
			onPress={onPress}
			hitSlop={8}
			style={({ pressed }) => ({
				width: 24,
				height: 24,
				borderRadius: 12,
				borderWidth: 1.5,
				borderColor: visual !== 'unchecked' ? color.accent : color.line,
				backgroundColor:
					visual === 'checked'
						? color.accent
						: visual === 'mixed'
							? color.accentSoft
							: color.surface,
				alignItems: 'center',
				justifyContent: 'center',
				opacity: pressed ? 0.7 : 1
			})}
		>
			{visual === 'checked' ? (
				<AppSymbol name="checkmark" fallback="checkmark" size={15} color="#fff" />
			) : visual === 'mixed' ? (
				<View style={{ width: 12, height: 2, borderRadius: 1, backgroundColor: color.accent }} />
			) : null}
		</Pressable>
	);
}

export function SegmentedControl({
	items,
	active,
	onPick
}: {
	items: { key: string; label: string }[];
	active: string;
	onPick: (key: string) => void;
}) {
	const selectedIndex = Math.max(
		0,
		items.findIndex((item) => item.key === active)
	);
	if (Platform.OS !== 'web') {
		return (
			<NativeSegmentedControl
				values={items.map((item) => item.label)}
				selectedIndex={selectedIndex}
				onChange={(event) => onPick(items[event.nativeEvent.selectedSegmentIndex]?.key ?? active)}
				tintColor={color.surface}
				backgroundColor={color.surface2}
				fontStyle={{ color: color.inkSoft, fontSize: 15 }}
				activeFontStyle={{ color: color.ink, fontSize: 15, fontWeight: '600' }}
				style={{ height: 34 }}
			/>
		);
	}
	return (
		<View style={s.segmented}>
			{items.map((it) => {
				const on = it.key === active;
				return (
					<Pressable
						key={it.key}
						accessibilityRole="tab"
						accessibilityState={{ selected: on }}
						onPress={() => onPick(it.key)}
						style={[s.segment, on && s.segmentOn]}
					>
						<Text style={[s.segmentText, on && { color: color.ink, fontWeight: '600' }]}>
							{it.label}
						</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

export function DateField({
	label,
	value,
	onChange,
	minimum,
	maximum,
	last = false
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	minimum?: string;
	maximum?: string;
	last?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const pickerDay = clampDay(value || dateToDay(new Date()), minimum, maximum);
	const date = dayToDate(pickerDay) ?? new Date();
	const shown = value ? formatDay(value, { year: true }) : label;
	return (
		<View>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={label}
				onPress={() => {
					if (!open && !value) onChange(pickerDay);
					setOpen((v) => !v);
				}}
				style={[s.formRow, !last && s.rowSeparator]}
			>
				<Text style={type.body}>{label}</Text>
				<Text style={[value ? type.body : type.faint, { flex: 1, textAlign: 'right' }]}>
					{shown}
				</Text>
			</Pressable>
			{open && Platform.OS === 'web' ? (
				<TextInput
					accessibilityLabel={label}
					value={value}
					onChangeText={onChange}
					placeholder="YYYY-MM-DD"
					autoCapitalize="none"
					style={s.searchInput}
				/>
			) : open ? (
				<DateTimePicker
					value={date}
					mode="date"
					display={Platform.OS === 'ios' ? 'inline' : 'default'}
					minimumDate={minimum ? (dayToDate(minimum) ?? undefined) : undefined}
					maximumDate={maximum ? (dayToDate(maximum) ?? undefined) : undefined}
					onChange={(event, selected) => {
						if (Platform.OS !== 'ios') setOpen(false);
						if (Platform.OS !== 'ios' && event.type !== 'set') return;
						if (event.type === 'dismissed') return;
						if (selected) onChange(dateToDay(selected));
					}}
				/>
			) : null}
		</View>
	);
}

export function TimeField({
	label,
	value,
	onChange,
	minimum = 0,
	maximum = 24 * 60,
	step = 5,
	variant = 'stacked',
	last = false
}: {
	label: string;
	value: number;
	onChange: (value: number) => void;
	minimum?: number;
	maximum?: number;
	step?: number;
	variant?: 'stacked' | 'row';
	last?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const time = minutesToDate(value);
	const [webTime, setWebTime] = useState(formatMinutes(value));
	useEffect(() => setWebTime(formatMinutes(value)), [value]);
	function commitWebTime(raw: string) {
		setWebTime(raw);
		const next = parseClock(raw);
		if (next !== null) onChange(normalizeTimePickerMinutes(next, minimum, maximum, step));
	}
	const field = (
		<>
			{open && Platform.OS === 'web' ? (
				<TextInput
					accessibilityLabel={label}
					value={webTime}
					onChangeText={commitWebTime}
					placeholder="9:00 AM"
					autoCapitalize="characters"
					style={s.searchInput}
				/>
			) : open ? (
				<DateTimePicker
					value={time}
					mode="time"
					display={Platform.OS === 'ios' ? 'spinner' : 'default'}
					minuteInterval={step as never}
					onChange={(event, selected) => {
						if (Platform.OS !== 'ios') setOpen(false);
						if (Platform.OS !== 'ios' && event.type !== 'set') return;
						if (event.type === 'dismissed') return;
						if (!selected) return;
						const raw = selected.getHours() * 60 + selected.getMinutes();
						onChange(normalizeTimePickerMinutes(raw, minimum, maximum, step));
					}}
				/>
			) : null}
		</>
	);
	if (variant === 'row') {
		return (
			<View>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={label}
					onPress={() => setOpen((v) => !v)}
					style={[s.formRow, !last && !open && s.rowSeparator]}
				>
					<Text style={type.body}>{label}</Text>
					<Text style={[type.body, { flex: 1, textAlign: 'right' }]}>{formatMinutes(value)}</Text>
				</Pressable>
				{open ? <View style={!last ? s.rowSeparator : undefined}>{field}</View> : null}
			</View>
		);
	}
	return (
		<View style={{ gap: space.xs }}>
			<Text style={fieldLabel}>{label}</Text>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={label}
				onPress={() => setOpen((v) => !v)}
				style={s.fieldButton}
			>
				<Text style={type.body}>{formatMinutes(value)}</Text>
			</Pressable>
			{field}
		</View>
	);
}

export function MemberPicker({
	members,
	selected,
	onToggle
}: {
	members: { id: string; name: string }[];
	selected: string[];
	onToggle: (id: string) => void;
}) {
	if (members.length === 0) return <Text style={type.faint}>{copy.common.nothingAdded}</Text>;
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
							<Text style={{ ...type.footnote, color: on ? color.accentInk : color.inkSoft }}>
								{m.name}
							</Text>
						</Pressable>
					);
				})}
			</View>
		</ScrollView>
	);
}

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
	const shown = options.filter((o) => o.toLowerCase().includes(q.trim().toLowerCase()));
	return (
		<View style={{ gap: space.xs }}>
			<Text style={fieldLabel}>{label}</Text>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={label}
				onPress={() => setOpen(true)}
				style={s.fieldButton}
			>
				<Text style={type.body}>{value}</Text>
			</Pressable>
			{open ? (
				<OptionBox
					q={q}
					setQ={setQ}
					shown={shown.map((key) => ({ key, label: key }))}
					value={value}
					onPick={(key) => {
						onPick(key);
						setOpen(false);
					}}
				/>
			) : null}
		</View>
	);
}

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
								style={({ pressed }) => [s.chip, on && s.chipOn, { opacity: pressed ? 0.7 : 1 }]}
							>
								<Text style={{ ...type.footnote, color: on ? color.accentInk : color.inkSoft }}>
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
	noMatches,
	last = false,
	variant = 'stacked'
}: {
	label: string;
	value: string;
	options: SearchablePickerOption[];
	onPick: (value: string) => void;
	noMatches: string;
	last?: boolean;
	variant?: 'stacked' | 'row';
}) {
	const [open, setOpen] = useState(false);
	const [q, setQ] = useState('');
	const current = options.find((o) => o.key === value);
	const needle = q.trim().toLowerCase();
	const shown = useMemo(
		() =>
			options.filter((o) => {
				if (!needle) return true;
				return (
					o.key.toLowerCase().includes(needle) ||
					o.label.toLowerCase().includes(needle) ||
					(o.detail ?? '').toLowerCase().includes(needle)
				);
			}),
		[needle, options]
	);
	const pickerButton = (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			onPress={() => {
				setQ('');
				setOpen(true);
			}}
			style={variant === 'row' ? [s.formRow, !last && s.rowSeparator] : s.fieldButton}
		>
			{variant === 'row' ? <Text style={type.body}>{label}</Text> : null}
			<View style={{ flex: 1 }}>
				<Text style={[type.body, { textAlign: variant === 'row' ? 'right' : 'left' }]}>
					{current ? current.label : value}
				</Text>
				{current?.detail ? (
					<Text style={[type.faint, { textAlign: variant === 'row' ? 'right' : 'left' }]}>
						{current.detail}
					</Text>
				) : null}
			</View>
		</Pressable>
	);
	return (
		<View style={variant === 'row' ? undefined : { gap: space.xs }}>
			{variant === 'row' ? null : <Text style={fieldLabel}>{label}</Text>}
			{pickerButton}
			{open ? (
				<OptionBox
					q={q}
					setQ={setQ}
					shown={shown}
					value={value}
					noMatches={noMatches}
					onPick={(key) => {
						onPick(key);
						setOpen(false);
					}}
				/>
			) : null}
		</View>
	);
}

function OptionBox({
	q,
	setQ,
	shown,
	value,
	onPick,
	noMatches
}: {
	q: string;
	setQ: (q: string) => void;
	shown: SearchablePickerOption[];
	value: string;
	onPick: (key: string) => void;
	noMatches?: string;
}) {
	return (
		<View style={s.optionBox}>
			<TextInput
				value={q}
				onChangeText={setQ}
				placeholder={copy.ui.searchPlaceholder}
				autoCapitalize="none"
				placeholderTextColor={color.inkFaint}
				style={s.searchInput}
			/>
			{shown.length === 0 ? <Text style={type.faint}>{noMatches}</Text> : null}
			<ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
				{shown.map((o) => (
					<Pressable
						key={o.key}
						onPress={() => onPick(o.key)}
						style={({ pressed }) => [s.option, pressed && { backgroundColor: color.surface2 }]}
					>
						<Text style={{ ...type.body, color: o.key === value ? color.accentInk : color.ink }}>
							{o.label}
						</Text>
						{o.detail ? <Text style={type.faint}>{o.detail}</Text> : null}
					</Pressable>
				))}
			</ScrollView>
		</View>
	);
}

function clampDay(value: string, minimum?: string, maximum?: string): string {
	let day = value;
	if (minimum && (!day || day < minimum)) day = minimum;
	if (maximum && (!day || day > maximum)) day = maximum;
	return day || dateToDay(new Date());
}

function parseClock(raw: string): number | null {
	const match = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
	if (!match) return null;
	let hour = Number(match[1]);
	const minute = Number(match[2] ?? '0');
	if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return null;
	const meridiem = match[3]?.toUpperCase();
	if (meridiem) {
		if (hour < 1 || hour > 12) return null;
		if (meridiem === 'AM') hour = hour === 12 ? 0 : hour;
		else hour = hour === 12 ? 12 : hour + 12;
	} else if (hour > 23) return null;
	return hour * 60 + minute;
}

function dayToDate(value: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return null;
	return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}
function dateToDay(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}
function minutesToDate(value: number): Date {
	const d = new Date();
	d.setHours(Math.floor(value / 60), value % 60, 0, 0);
	return d;
}
function formatMinutes(value: number): string {
	return clock(value);
}

const s = StyleSheet.create({
	formRow: {
		minHeight: 44,
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: space.md,
		gap: space.md
	},
	rowSeparator: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line },
	segmented: { flexDirection: 'row', backgroundColor: color.surface2, borderRadius: 9, padding: 2 },
	segment: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 7 },
	segmentOn: { backgroundColor: color.surface },
	segmentText: { ...type.subhead, color: color.inkSoft, fontWeight: '500' },
	fieldButton: {
		minHeight: 44,
		justifyContent: 'center',
		paddingHorizontal: space.md,
		paddingVertical: 7,
		borderRadius: radius.button,
		backgroundColor: color.surface
	},
	chip: {
		paddingHorizontal: space.md,
		paddingVertical: 6,
		borderRadius: 999,
		borderWidth: 1,
		borderColor: color.line,
		backgroundColor: color.surface
	},
	chipOn: { borderColor: color.accent, backgroundColor: color.accentSoft },
	optionBox: {
		gap: space.sm,
		borderRadius: radius.section,
		backgroundColor: color.surface,
		padding: space.sm,
		maxHeight: 260
	},
	searchInput: {
		height: 44,
		paddingHorizontal: space.md,
		borderRadius: radius.button,
		backgroundColor: color.surface2,
		color: color.ink,
		fontSize: 17
	},
	option: { paddingVertical: 10, paddingHorizontal: space.sm, borderRadius: radius.button }
});
