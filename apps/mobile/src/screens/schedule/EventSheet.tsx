import { useEffect, useMemo, useRef, useState } from 'react';
import type { ElementRef } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { copy } from '@trippy/copy';
import { isLocatedType, STAY_CHECK_IN, type EventType } from '@trippy/core/types';
import { MAX_NAME_LENGTH, MAX_NOTES_LENGTH } from '@trippy/core/validate';
import { guessLeg, minsByMode, rekeyLeg } from '@trippy/core/travel';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import { Button, Field, FormError } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { SheetFooter } from '../../ui/SheetFooter';
import { ConfirmSheet } from '../../ui/ConfirmSheet';
import { Picker } from '../../ui/controls';
import { color, fieldLabel, radius, space, type } from '../../theme';
import { usePlaceField } from './PlaceField';
import {
	DAY_END,
	DRAFT_ID,
	MIN_EVENT_MINS,
	MODE_OPTIONS,
	NO_PEOPLE,
	TYPE_OPTIONS,
	clock,
	dayLabel,
	deriveTitle,
	modeLabel,
	rangeLabel,
	shiftDay,
	typeLabel
} from './shared';
import type { Cell, Crew, EventDraft, EventRow, LegRow, SavedPoi } from './types';

type JourneyEdit = { title: string; mode: string; mins: string };

function legEdit(leg: LegRow): JourneyEdit {
	return { title: leg.title ?? '', mode: leg.resolvedMode, mins: String(leg.resolvedMins) };
}

function sameEdit(a: JourneyEdit, b: JourneyEdit) {
	return a.mode === b.mode && a.mins === b.mins && a.title.trim() === b.title.trim();
}

function estimateFor(leg: LegRow, mode: string) {
	return mode === leg.autoMode && leg.autoMins != null ? leg.autoMins : minsByMode(leg.km, mode);
}

function automatic(leg: LegRow) {
	const mode = leg.autoMode ?? guessLeg(leg.km).mode;
	return { mode, mins: estimateFor(leg, mode) };
}

function isAutomatic(leg: LegRow, edit: JourneyEdit) {
	const auto = automatic(leg);
	const mins = Number(edit.mins);
	return edit.mode === auto.mode && (mins === auto.mins || mins === minsByMode(leg.km, edit.mode));
}

export function EventSheet({
	open,
	base,
	event,
	day,
	startMin,
	suggestedStart,
	initialType = 'activity',
	legs,
	eventOf,
	peopleLabel,
	members,
	crews,
	saved,
	stays,
	cities,
	cityId,
	firstDay,
	lastDay,
	locked,
	onPreview,
	onClose,
	onDone
}: {
	open: boolean;
	base: string;
	event: EventRow | null;
	day: string;
	startMin?: number | null;
	suggestedStart?: number;
	initialType?: EventType;
	legs: LegRow[];
	eventOf: (eventId: string) => EventRow | null;
	peopleLabel: (ids: string[]) => string;
	members: { id: string; name: string }[];
	crews: Crew[];
	saved: SavedPoi[];
	stays: SavedPoi[];
	cities: (Cell | null)[];
	cityId: string | null;
	firstDay: string;
	lastDay: string;
	locked: boolean;
	onPreview: (draft: EventDraft | null) => void;
	onClose: () => void;
	onDone: () => void;
}) {
	const opensAt = startMin ?? suggestedStart ?? STAY_CHECK_IN;
	const openStart = Math.min(opensAt, DAY_END - MIN_EVENT_MINS);
	const [eventType, setEventType] = useState<EventType>(event?.type ?? initialType);
	const [start, setStart] = useState(event?.start_min ?? openStart);
	const [end, setEnd] = useState(event?.end_min ?? Math.min(DAY_END, openStart + 60));
	const [timeChosen, setTimeChosen] = useState(!!event || startMin != null);
	const [date, setDate] = useState(event?.day ?? day);
	const [checkIn, setCheckIn] = useState(event?.day ?? day);
	const [checkOut, setCheckOut] = useState(event?.end_day ?? shiftDay(event?.day ?? day, 1));
	const [people, setPeople] = useState<string[] | null>(event ? [...event.people] : []);
	const [notes, setNotes] = useState(event?.notes ?? '');
	const [mode, setMode] = useState(event?.travel_mode ?? '');
	const [label, setLabel] = useState('');
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [journeyEdits, setJourneyEdits] = useState<Record<string, JourneyEdit>>({});
	const created = useRef<string | null>(null);
	const openedVersion = useRef(event?.version);

	const savedPick =
		(event ? (event.type === 'stay' ? event.lodging_id : event.poi_id) : null) ?? '';
	const openedOn = event
		? ((event.type === 'stay' ? stays : saved).find((p) => p.id === savedPick)?.name ??
				(savedPick ? '' : event.place_text)) ||
			''
		: '';

	const place = usePlaceField({
		base,
		type: eventType,
		cities,
		cityId,
		saved,
		stays,
		initialPoi: savedPick,
		initialPlace: openedOn,
		readonly: locked
	});

	useEffect(() => {
		if (!open) return;
		const was = event
			? deriveTitle(
					isLocatedType(event.type) ? openedOn || null : null,
					event.notes ?? '',
					event.type
				)
			: '';
		setLabel(event && event.title !== was ? event.title : '');
		created.current = null;
		openedVersion.current = event?.version;
		setJourneyEdits({});
	}, [open, event?.id]);

	const staying = eventType === 'stay';
	const onDay = staying ? checkIn : date;
	const startAt = staying ? STAY_CHECK_IN : start;
	const endAt = staying ? DAY_END : Math.max(startAt + MIN_EVENT_MINS, end);
	const lat = place.placeable
		? place.spot
			? place.spot.lat
			: place.poi
				? null
				: (event?.lat ?? null)
		: null;
	const lng = place.placeable
		? place.spot
			? place.spot.lng
			: place.poi
				? null
				: (event?.lng ?? null)
		: null;
	const derived = deriveTitle(
		place.placeable ? (place.spot?.name ?? (place.poi ? null : place.place.trim() || null)) : null,
		notes,
		eventType
	);
	const title = label.trim() || derived;
	const previewId = event?.id ?? DRAFT_ID;

	useEffect(() => {
		if (locked) return;
		onPreview({
			id: previewId,
			day: onDay,
			end_day: staying ? checkOut : null,
			title,
			type: eventType,
			start_min: startAt,
			end_min: endAt,
			people: people ?? [],
			lat,
			lng
		});
		return () => onPreview(null);
	}, [
		locked,
		previewId,
		onDay,
		staying,
		checkOut,
		title,
		eventType,
		startAt,
		endAt,
		people,
		lat,
		lng
	]);

	const placeMoved = place.poi !== savedPick || place.place.trim() !== openedOn.trim();
	const versionTook = (res: { version?: number } | null | undefined) => {
		if (typeof res?.version === 'number') openedVersion.current = res.version;
	};

	const save = useMutation(
		async () => {
			if (!people) throw new Error(NO_PEOPLE);
			if (!staying && endAt - startAt < MIN_EVENT_MINS) {
				throw new Error(`An event needs to run at least ${MIN_EVENT_MINS} minutes.`);
			}
			if (!event) {
				created.current ??= (
					await api<{ id: string }>(`${base}/events`, {
						method: 'POST',
						body: {
							day: onDay,
							endDay: staying ? checkOut : undefined,
							title: label.trim() || undefined,
							type: eventType,
							start: startAt,
							duration: endAt - startAt,
							poiId: place.placeable && place.poi ? place.poi : undefined,
							placeName:
								place.placeable && !place.poi ? place.place.trim() || undefined : undefined,
							notes: notes.trim() || undefined,
							travelMode: eventType === 'travel' && mode ? mode : undefined,
							people,
							timeAuto: !timeChosen && !staying
						}
					})
				).id;
				await saveJourneys(base, onDay, created.current, legs, journeyEdits);
				onDone();
				return;
			}

			versionTook(
				await api<{ version?: number }>(`${base}/events/${event.id}/op`, {
					method: 'POST',
					body: {
						op: 'edit',
						title: label.trim(),
						type: eventType,
						notes: notes.trim(),
						startMin: staying ? undefined : startAt,
						endMin: staying ? undefined : endAt,
						day: onDay,
						endDay: staying ? checkOut : undefined,
						travelMode: eventType === 'travel' ? mode : undefined,
						poiId: place.placeable && placeMoved ? place.poi : undefined,
						placeName: place.placeable && placeMoved && !place.poi ? place.place.trim() : undefined,
						version: openedVersion.current
					}
				})
			);
			versionTook(
				await api<{ version?: number }>(`${base}/events/${event.id}/people`, {
					method: 'PUT',
					body: { people }
				})
			);
			await saveJourneys(base, onDay, event.id, legs, journeyEdits);
			onDone();
		},
		{ fallback: event ? copy.schedule.eventSaveFallback : copy.schedule.eventAddFallback }
	);

	const remove = useMutation(
		async () => {
			if (!event) return;
			await api(`${base}/events/${event.id}/op`, { method: 'POST', body: { op: 'delete' } });
		},
		{ fallback: copy.schedule.eventDeleteFallback, onSuccess: onDone }
	);

	const setStartMinute = (nextStart: number) => {
		setTimeChosen(true);
		const length = Math.max(MIN_EVENT_MINS, end - start);
		const bounded = Math.max(0, Math.min(DAY_END - MIN_EVENT_MINS, nextStart));
		setStart(bounded);
		setEnd(Math.min(DAY_END, bounded + length));
	};

	const setJourney = (leg: LegRow, patch: Partial<JourneyEdit>) => {
		setJourneyEdits((old) => ({
			...old,
			[leg.key]: { ...(old[leg.key] ?? legEdit(leg)), ...patch }
		}));
	};

	return (
		<>
			<Sheet
				open={open && !confirmDelete}
				title={
					locked
						? copy.schedule.dialog.view
						: event
							? copy.schedule.dialog.edit
							: copy.schedule.dialog.add
				}
				subtitle={staying ? rangeLabel(checkIn, checkOut) : dayLabel(onDay)}
				onClose={onClose}
			>
				{place.field}
				{locked ? (
					<ReadonlyPill label={copy.schedule.fields.type} value={typeLabel(eventType)} />
				) : (
					<Picker
						label={copy.schedule.fields.type}
						options={TYPE_OPTIONS}
						value={eventType}
						onPick={(next) => {
							const typed = next as EventType;
							place.retype(typed);
							setEventType(typed);
						}}
					/>
				)}
				{staying ? (
					<DatePair
						checkIn={checkIn}
						checkOut={checkOut}
						firstDay={firstDay}
						lastDay={lastDay}
						readonly={locked}
						onCheckIn={setCheckIn}
						onCheckOut={setCheckOut}
					/>
				) : (
					<>
						<DayStepper
							label={copy.schedule.fields.date}
							value={date}
							min={firstDay}
							max={lastDay}
							readonly={locked}
							onChange={setDate}
						/>
						<View style={{ flexDirection: 'row', gap: space.md }}>
							<View style={{ flex: 1 }}>
								<TimeStepper
									label={copy.schedule.fields.start}
									value={start}
									min={0}
									max={DAY_END - MIN_EVENT_MINS}
									readonly={locked}
									onChange={setStartMinute}
								/>
							</View>
							<View style={{ flex: 1 }}>
								<TimeStepper
									label={copy.schedule.fields.end}
									value={end}
									min={start + MIN_EVENT_MINS}
									max={DAY_END}
									readonly={locked}
									onChange={(v) => {
										setTimeChosen(true);
										setEnd(v);
									}}
								/>
							</View>
						</View>
					</>
				)}
				{eventType === 'travel' ? (
					locked ? (
						<ReadonlyPill
							label={`${copy.schedule.fields.mode}${copy.ui.field.optionalSuffix}`}
							value={mode ? modeLabel(mode) : copy.schedule.journey.automatic}
						/>
					) : (
						<Picker
							label={`${copy.schedule.fields.mode}${copy.ui.field.optionalSuffix}`}
							options={[{ key: '', label: copy.schedule.journey.automatic }, ...MODE_OPTIONS]}
							value={mode}
							onPick={setMode}
						/>
					)
				) : null}
				<PeopleChooser
					people={members}
					crews={crews}
					value={people}
					readonly={locked}
					onChange={setPeople}
				/>
				<Field
					label={`${copy.schedule.fields.label}${copy.ui.field.optionalSuffix}`}
					value={label}
					placeholder={derived}
					maxLength={MAX_NAME_LENGTH}
					onChangeText={setLabel}
					editable={!locked}
				/>
				<View style={{ gap: space.xs }}>
					<Text style={fieldLabel}>
						{copy.schedule.fields.notes}
						{copy.ui.field.optionalSuffix}
					</Text>
					<TextInput
						value={notes}
						onChangeText={setNotes}
						editable={!locked}
						multiline
						maxLength={MAX_NOTES_LENGTH}
						placeholderTextColor={color.inkFaint}
						style={{
							minHeight: 88,
							textAlignVertical: 'top',
							borderWidth: 1,
							borderColor: color.line,
							borderRadius: radius.md,
							backgroundColor: color.surface,
							paddingHorizontal: space.md,
							paddingVertical: space.sm,
							color: color.ink
						}}
					/>
				</View>
				<JourneyEditor
					legs={legs}
					edits={journeyEdits}
					eventOf={eventOf}
					peopleLabel={peopleLabel}
					readonly={locked}
					onSet={setJourney}
				/>
				<FormError message={save.error} />
				<SheetFooter
					primaryLabel={locked ? undefined : event ? copy.common.save : copy.common.add}
					primaryBusyLabel={event ? copy.common.saving : copy.common.adding}
					primaryBusy={save.busy}
					onPrimary={locked ? undefined : () => void save.run()}
					destructiveLabel={
						locked ? undefined : event ? copy.common.deleteLabel(event.title) : undefined
					}
					onDestructive={locked || !event ? undefined : () => setConfirmDelete(true)}
				>
					{locked ? (
						<Text style={{ ...type.small, color: color.inkSoft }}>{copy.schedule.lock.tag}</Text>
					) : null}
				</SheetFooter>
			</Sheet>
			<ConfirmSheet
				open={confirmDelete}
				title={event ? copy.common.deleteTitle(event.title) : ''}
				confirmLabel={copy.common.delete}
				busyLabel={copy.common.deleting}
				busy={remove.busy}
				error={remove.error}
				onCancel={() => setConfirmDelete(false)}
				onConfirm={() => void remove.run()}
			/>
		</>
	);
}

function DatePair({
	checkIn,
	checkOut,
	firstDay,
	lastDay,
	readonly,
	onCheckIn,
	onCheckOut
}: {
	checkIn: string;
	checkOut: string;
	firstDay: string;
	lastDay: string;
	readonly: boolean;
	onCheckIn: (v: string) => void;
	onCheckOut: (v: string) => void;
}) {
	const lastOut = shiftDay(lastDay, 1);
	return (
		<View style={{ flexDirection: 'row', gap: space.md }}>
			<View style={{ flex: 1 }}>
				<DayStepper
					label={copy.schedule.fields.checkIn}
					value={checkIn}
					min={firstDay}
					max={lastDay}
					readonly={readonly}
					onChange={(next) => {
						onCheckIn(next);
						if (next >= checkOut) onCheckOut(shiftDay(next, 1));
					}}
				/>
			</View>
			<View style={{ flex: 1 }}>
				<DayStepper
					label={copy.schedule.fields.checkOut}
					value={checkOut}
					min={shiftDay(checkIn, 1)}
					max={lastOut}
					readonly={readonly}
					onChange={onCheckOut}
				/>
			</View>
		</View>
	);
}

function DayStepper({
	label,
	value,
	min,
	max,
	readonly,
	onChange
}: {
	label: string;
	value: string;
	min: string;
	max: string;
	readonly: boolean;
	onChange: (value: string) => void;
}) {
	const prev = shiftDay(value, -1);
	const next = shiftDay(value, 1);
	return (
		<View style={{ gap: space.xs }}>
			<Text style={fieldLabel}>{label}</Text>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
				<Button
					label="‹"
					accessibilityLabel={`Previous ${label.toLowerCase()}`}
					tone="ghost"
					small
					disabled={readonly || prev < min}
					onPress={() => onChange(prev)}
				/>
				<View
					style={{
						flex: 1,
						minHeight: 34,
						justifyContent: 'center',
						alignItems: 'center',
						borderWidth: 1,
						borderColor: color.line,
						borderRadius: radius.md,
						backgroundColor: color.surface
					}}
				>
					<Text style={type.small}>{dayLabel(value)}</Text>
				</View>
				<Button
					label="›"
					accessibilityLabel={`Next ${label.toLowerCase()}`}
					tone="ghost"
					small
					disabled={readonly || next > max}
					onPress={() => onChange(next)}
				/>
			</View>
		</View>
	);
}

function TimeStepper({
	label,
	value,
	min,
	max,
	readonly,
	onChange
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	readonly: boolean;
	onChange: (value: number) => void;
}) {
	const [picking, setPicking] = useState(false);
	const step = (delta: number) => Math.max(min, Math.min(max, value + delta));
	return (
		<>
			<View style={{ gap: space.xs }}>
				<Text style={fieldLabel}>{label}</Text>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
					<Button
						label="−"
						accessibilityLabel={`Earlier ${label.toLowerCase()}`}
						tone="ghost"
						small
						disabled={readonly || value <= min}
						onPress={() => onChange(step(-5))}
					/>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel={`Pick ${label.toLowerCase()}`}
						disabled={readonly}
						onPress={() => setPicking(true)}
						style={({ pressed }) => ({
							flex: 1,
							minHeight: 34,
							justifyContent: 'center',
							alignItems: 'center',
							borderWidth: 1,
							borderColor: color.line,
							borderRadius: radius.md,
							backgroundColor: pressed ? color.surface2 : color.surface
						})}
					>
						<Text style={type.small}>{timeLabel(value)}</Text>
					</Pressable>
					<Button
						label="+"
						accessibilityLabel={`Later ${label.toLowerCase()}`}
						tone="ghost"
						small
						disabled={readonly || value >= max}
						onPress={() => onChange(step(5))}
					/>
				</View>
			</View>
			<TimePickerSheet
				open={picking}
				title={label}
				value={value}
				min={min}
				max={max}
				onClose={() => setPicking(false)}
				onPick={(next) => {
					onChange(next);
					setPicking(false);
				}}
			/>
		</>
	);
}

function TimePickerSheet({
	open,
	title,
	value,
	min,
	max,
	onClose,
	onPick
}: {
	open: boolean;
	title: string;
	value: number;
	min: number;
	max: number;
	onClose: () => void;
	onPick: (value: number) => void;
}) {
	const scroll = useRef<ElementRef<typeof ScrollView> | null>(null);
	const options = useMemo(() => {
		const values: number[] = [];
		for (let minute = Math.ceil(min / 5) * 5; minute <= max; minute += 5) values.push(minute);
		if (!values.includes(value) && value >= min && value <= max) values.push(value);
		return values.sort((a, b) => a - b);
	}, [min, max, value]);

	useEffect(() => {
		if (!open) return;
		const index = Math.max(
			0,
			options.findIndex((option) => option === value)
		);
		const timer = setTimeout(
			() => scroll.current?.scrollTo({ y: Math.max(0, index * 44 - 88), animated: false }),
			0
		);
		return () => clearTimeout(timer);
	}, [open, options, value]);

	return (
		<Sheet open={open} title={title} onClose={onClose}>
			<ScrollView
				ref={scroll}
				style={{ maxHeight: 320 }}
				keyboardShouldPersistTaps="handled"
				nestedScrollEnabled
			>
				{options.map((option) => (
					<Pressable
						key={option}
						accessibilityRole="button"
						accessibilityState={{ selected: option === value }}
						onPress={() => onPick(option)}
						style={({ pressed }) => ({
							minHeight: 44,
							justifyContent: 'center',
							paddingHorizontal: space.md,
							borderRadius: radius.sm,
							backgroundColor:
								option === value ? color.accentSoft : pressed ? color.surface2 : color.surface
						})}
					>
						<Text
							style={{
								...type.body,
								color: option === value ? color.accentInk : color.ink
							}}
						>
							{timeLabel(option)}
						</Text>
					</Pressable>
				))}
			</ScrollView>
			<Button label={copy.common.cancel} tone="ghost" onPress={onClose} />
		</Sheet>
	);
}

function timeLabel(value: number): string {
	return value === DAY_END ? '12:00 AM' : clock(value);
}

function ReadonlyPill({ label, value }: { label: string; value: string }) {
	return (
		<View style={{ gap: space.xs }}>
			<Text style={fieldLabel}>{label}</Text>
			<Text
				style={{
					...type.small,
					alignSelf: 'flex-start',
					color: color.accentInk,
					backgroundColor: color.accentSoft,
					borderRadius: radius.sm,
					paddingHorizontal: space.sm,
					paddingVertical: 4,
					overflow: 'hidden'
				}}
			>
				{value}
			</Text>
		</View>
	);
}

function PeopleChooser({
	people,
	crews,
	value,
	readonly,
	onChange
}: {
	people: { id: string; name: string }[];
	crews: Crew[];
	value: string[] | null;
	readonly: boolean;
	onChange: (next: string[] | null) => void;
}) {
	const ids = people.map((p) => p.id);
	const known = value?.filter((id) => ids.includes(id)) ?? [];
	const everyone = value !== null && (known.length === 0 || known.length === ids.length);
	const selected = new Set(everyone ? ids : known);
	const setKnown = (next: string[]) => {
		if (next.length === ids.length) onChange([]);
		else onChange(next.length === 0 ? null : next);
	};
	const toggle = (id: string) => {
		if (readonly) return;
		const next = new Set(selected);
		if (!next.delete(id)) next.add(id);
		setKnown([...next].filter((x) => ids.includes(x)));
	};
	const toggleCrew = (crew: Crew) => {
		if (readonly) return;
		const offered = crew.members.filter((id) => ids.includes(id));
		const all = offered.every((id) => selected.has(id));
		const next = new Set(selected);
		for (const id of offered) {
			if (all) next.delete(id);
			else next.add(id);
		}
		setKnown([...next].filter((x) => ids.includes(x)));
	};
	return (
		<View style={{ gap: space.sm }}>
			<Text style={fieldLabel}>{copy.schedule.fields.participants}</Text>
			<Text style={type.faint}>
				{value === null ? copy.schedule.fields.nobody : everyone ? copy.common.everyone : ''}
			</Text>
			{readonly ? (
				<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
					{everyone ? (
						<ReadonlyTag label={copy.common.everyone} />
					) : (
						people
							.filter((person) => selected.has(person.id))
							.map((person) => <ReadonlyTag key={person.id} label={person.name} />)
					)}
				</View>
			) : crews.length ? (
				<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
					{crews.map((crew) => (
						<Chip
							key={crew.id}
							label={crew.name}
							on={crew.members.filter((id) => ids.includes(id)).every((id) => selected.has(id))}
							onPress={() => toggleCrew(crew)}
						/>
					))}
				</View>
			) : null}
			{readonly ? null : (
				<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
					{people.map((person) => (
						<Chip
							key={person.id}
							label={person.name}
							on={selected.has(person.id)}
							onPress={() => toggle(person.id)}
						/>
					))}
				</View>
			)}
		</View>
	);
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
	return (
		<Pressable
			accessibilityRole="checkbox"
			accessibilityState={{ checked: on }}
			onPress={onPress}
			style={({ pressed }) => ({
				flexDirection: 'row',
				alignItems: 'center',
				gap: space.xs,
				paddingHorizontal: space.sm,
				paddingVertical: 6,
				borderRadius: 999,
				borderWidth: 1,
				borderColor: on ? color.accent : color.line,
				backgroundColor: on ? color.accentSoft : color.surface,
				opacity: pressed ? 0.7 : 1
			})}
		>
			<Text style={{ color: on ? color.accentInk : color.inkFaint }}>{on ? '✓' : '□'}</Text>
			<Text style={type.small}>{label}</Text>
		</Pressable>
	);
}

function ReadonlyTag({ label }: { label: string }) {
	return (
		<Text
			style={{
				...type.small,
				alignSelf: 'flex-start',
				color: color.accentInk,
				backgroundColor: color.accentSoft,
				borderRadius: 999,
				paddingHorizontal: space.sm,
				paddingVertical: 6,
				overflow: 'hidden'
			}}
		>
			{label}
		</Text>
	);
}

function JourneyEditor({
	legs,
	edits,
	eventOf,
	peopleLabel,
	readonly,
	onSet
}: {
	legs: LegRow[];
	edits: Record<string, JourneyEdit>;
	eventOf: (eventId: string) => EventRow | null;
	peopleLabel: (ids: string[]) => string;
	readonly: boolean;
	onSet: (leg: LegRow, patch: Partial<JourneyEdit>) => void;
}) {
	if (!legs.length) return null;
	return (
		<View style={{ gap: space.sm }}>
			<Text style={type.head}>{copy.schedule.journey.heading}</Text>
			{legs.map((leg) => {
				const edit = edits[leg.key] ?? legEdit(leg);
				const from = eventOf(leg.fromEventId)?.title ?? null;
				return (
					<View
						key={leg.key}
						style={{
							borderWidth: 1,
							borderColor: color.line,
							borderRadius: radius.md,
							padding: space.md,
							gap: space.sm
						}}
					>
						<Text style={type.small}>{peopleLabel(leg.people)}</Text>
						{leg.tight ? (
							<Text style={{ ...type.small, color: color.warn }}>{copy.viewAs.travelWarning}</Text>
						) : null}
						{readonly ? (
							<>
								<ReadonlyPill
									label={`${copy.schedule.journey.name}${copy.ui.field.optionalSuffix}`}
									value={
										edit.title ||
										(from ? `${modeLabel(edit.mode)} from ${from}` : modeLabel(edit.mode))
									}
								/>
								<ReadonlyPill label={copy.schedule.fields.mode} value={modeLabel(edit.mode)} />
								<ReadonlyPill
									label={copy.schedule.journey.minutes}
									value={`${edit.mins} ${copy.schedule.journey.minutesUnit}`}
								/>
							</>
						) : (
							<>
								<Field
									label={`${copy.schedule.journey.name}${copy.ui.field.optionalSuffix}`}
									value={edit.title}
									placeholder={from ? `${modeLabel(edit.mode)} from ${from}` : modeLabel(edit.mode)}
									onChangeText={(v) => onSet(leg, { title: v })}
								/>
								<Picker
									label={copy.schedule.fields.mode}
									options={MODE_OPTIONS.map((o) => ({
										...o,
										label: `${o.label} ${copy.schedule.journey.estimate(estimateFor(leg, o.key))}`
									}))}
									value={edit.mode}
									onPick={(next) =>
										onSet(leg, { mode: next, mins: String(estimateFor(leg, next)) })
									}
								/>
								<Field
									label={copy.schedule.journey.minutes}
									value={edit.mins}
									keyboardType="number-pad"
									onChangeText={(v) => onSet(leg, { mins: v })}
								/>
							</>
						)}
					</View>
				);
			})}
		</View>
	);
}

async function saveJourneys(
	base: string,
	day: string,
	toEventId: string,
	legs: LegRow[],
	edits: Record<string, JourneyEdit>
) {
	const touched = legs.filter((leg) => edits[leg.key] && !sameEdit(edits[leg.key], legEdit(leg)));
	if (!touched.length) return;
	const fresh = await api<{ board: { legs: LegRow[] }[] }>(`${base}?day=${day}`);
	const rows = new Map(fresh.board.flatMap((b) => b.legs).map((leg) => [leg.key, leg]));
	for (const leg of touched) {
		const row = rows.get(rekeyLeg(leg.key, toEventId));
		if (!row) continue;
		const edit = edits[leg.key];
		const legTitle = edit.title.trim();
		await api(`${base}/legs/${row.id}`, {
			method: 'PATCH',
			body: isAutomatic(row, edit)
				? { mode: '', mins: '', title: legTitle }
				: { mode: edit.mode, mins: edit.mins, title: legTitle }
		});
	}
}
