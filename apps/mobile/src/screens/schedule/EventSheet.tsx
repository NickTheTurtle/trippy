import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { copy } from '@trippy/copy';
import { isLocatedType, STAY_CHECK_IN, type EventType } from '@trippy/core/types';
import { MAX_NAME_LENGTH, MAX_NOTES_LENGTH } from '@trippy/core/validate';
import { guessLeg, minsByMode, rekeyLeg } from '@trippy/core/travel';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import { Field, FormError } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { SheetFooter } from '../../ui/SheetFooter';
import { ConfirmSheet } from '../../ui/ConfirmSheet';
import { CheckBox, Picker } from '../../ui/controls';
import { color, fieldLabel, radius, space, type } from '../../theme';
import { usePlaceField } from './PlaceField';
import {
	DAY_END,
	DRAFT_ID,
	MIN_EVENT_MINS,
	MODE_OPTIONS,
	NO_PEOPLE,
	TYPE_OPTIONS,
	clockRange,
	deriveTitle,
	modeLabel,
	parseClock,
	rangeLabel,
	shiftDay,
	timeText
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
	const [eventType, setEventType] = useState<EventType>(event?.type ?? initialType);
	const [start, setStart] = useState(event ? timeText(event.start_min) : timeText(opensAt));
	const [end, setEnd] = useState(
		event ? timeText(event.end_min) : timeText(Math.min(DAY_END, opensAt + 60))
	);
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

	const startMinNow = parseClock(start) ?? (event ? event.start_min : opensAt);
	const endMinNow = parseClock(end) ?? Math.min(DAY_END, startMinNow + 60);
	const staying = eventType === 'stay';
	const onDay = staying ? checkIn : date;
	const startAt = staying ? STAY_CHECK_IN : startMinNow;
	const endAt = staying ? DAY_END : Math.max(startAt + MIN_EVENT_MINS, endMinNow);
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
				versionTook(
					await api<{ version?: number }>(`${base}/events/${created.current}/people`, {
						method: 'PUT',
						body: { people }
					})
				);
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
		{ fallback: event ? 'Could not save that event.' : 'Could not add that event.' }
	);

	const remove = useMutation(
		async () => {
			if (!event) return;
			await api(`${base}/events/${event.id}/op`, { method: 'POST', body: { op: 'delete' } });
		},
		{ fallback: 'Could not delete that event.', onSuccess: onDone }
	);

	const setStartTime = (text: string) => {
		setTimeChosen(true);
		const oldStart = parseClock(start) ?? startAt;
		const oldEnd = parseClock(end) ?? endAt;
		setStart(text);
		const nextStart = parseClock(text);
		if (nextStart != null)
			setEnd(timeText(Math.min(DAY_END, nextStart + Math.max(MIN_EVENT_MINS, oldEnd - oldStart))));
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
				subtitle={staying ? rangeLabel(checkIn, checkOut) : onDay}
				onClose={onClose}
			>
				{place.field}
				<Picker
					label={copy.schedule.fields.type}
					options={TYPE_OPTIONS}
					value={eventType}
					onPick={(next) => {
						if (locked) return;
						const typed = next as EventType;
						place.retype(typed);
						setEventType(typed);
					}}
				/>
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
						<Field
							label={copy.schedule.fields.date}
							value={date}
							onChangeText={setDate}
							editable={!locked}
						/>
						<View style={{ flexDirection: 'row', gap: space.md }}>
							<View style={{ flex: 1 }}>
								<Field
									label={copy.schedule.fields.start}
									value={start}
									onChangeText={setStartTime}
									editable={!locked}
								/>
							</View>
							<View style={{ flex: 1 }}>
								<Field
									label={copy.schedule.fields.end}
									value={end}
									onChangeText={(v) => {
										setTimeChosen(true);
										setEnd(v);
									}}
									editable={!locked}
								/>
							</View>
						</View>
					</>
				)}
				{eventType === 'travel' ? (
					<Picker
						label={copy.schedule.fields.mode}
						options={[{ key: '', label: 'Automatic' }, ...MODE_OPTIONS]}
						value={mode}
						onPick={(next) => !locked && setMode(next)}
					/>
				) : null}
				<PeopleChooser
					people={members}
					crews={crews}
					value={people}
					readonly={locked}
					onChange={setPeople}
				/>
				<Field
					label={copy.schedule.fields.label}
					value={label}
					placeholder={derived}
					maxLength={MAX_NAME_LENGTH}
					onChangeText={setLabel}
					editable={!locked}
				/>
				<View style={{ gap: space.xs }}>
					<Text style={fieldLabel}>{copy.schedule.fields.notes}</Text>
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
				<Field
					label={copy.schedule.fields.checkIn}
					value={checkIn}
					editable={!readonly}
					onChangeText={(typed) => {
						const next = clampDay(typed, firstDay, lastDay);
						onCheckIn(next);
						if (next >= checkOut) onCheckOut(shiftDay(next, 1));
					}}
				/>
			</View>
			<View style={{ flex: 1 }}>
				<Field
					label={copy.schedule.fields.checkOut}
					value={checkOut}
					editable={!readonly}
					onChangeText={(typed) => onCheckOut(clampDay(typed, shiftDay(checkIn, 1), lastOut))}
				/>
			</View>
		</View>
	);
}

function clampDay(value: string, lo: string, hi: string) {
	if (!value) return lo;
	return value < lo ? lo : value > hi ? hi : value;
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
			{crews.length ? (
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
			<CheckBox checked={on} label={label} onPress={onPress} />
			<Text style={type.small}>{label}</Text>
		</Pressable>
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
			<Text style={type.head}>Getting here</Text>
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
						<Field
							label={copy.schedule.journey.name}
							value={edit.title}
							placeholder={from ? `${modeLabel(edit.mode)} from ${from}` : modeLabel(edit.mode)}
							editable={!readonly}
							onChangeText={(v) => onSet(leg, { title: v })}
						/>
						<Picker
							label={copy.schedule.fields.mode}
							options={MODE_OPTIONS.map((o) => ({
								...o,
								label: `${o.label} ${estimateFor(leg, o.key)}m`
							}))}
							value={edit.mode}
							onPick={(next) =>
								!readonly && onSet(leg, { mode: next, mins: String(estimateFor(leg, next)) })
							}
						/>
						<Field
							label={copy.schedule.journey.minutes}
							value={edit.mins}
							keyboardType="number-pad"
							editable={!readonly}
							onChangeText={(v) => onSet(leg, { mins: v })}
						/>
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
