import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { copy } from '@trippy/copy';
import { formatDay } from '@trippy/copy/format';
import { isLocatedType, STAY_CHECK_IN, type EventType } from '@trippy/core/types';
import {
	crossesZones,
	lastDayOf,
	normalizeSpan,
	spanProblem,
	type SpanRow,
	type ZoneOf
} from '@trippy/core/span';
import { MAX_NAME_LENGTH, MAX_NOTES_LENGTH } from '@trippy/core/validate';
import { guessLeg, minsByMode, rekeyLeg } from '@trippy/core/travel';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import { DestructiveRow, Field, InsetGroupedList, InsetSection, ListRow } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { ConfirmSheet, confirmOverlays } from '../../ui/ConfirmSheet';
import { ChecklistRow, DateField, DateTimeField, SegmentedControl } from '../../ui/controls';
import { AppSymbol } from '../../ui/Symbol';
import { color, radius, rowInset, space, type } from '../../theme';
import { usePlaceField } from './PlaceField';
import {
	DAY_END,
	DRAFT_ID,
	MIN_EVENT_MINS,
	MODE_OPTIONS,
	NO_PEOPLE,
	TYPE_OPTIONS,
	clock,
	dayDiff,
	dayLabel,
	deriveTitle,
	modeLabel,
	shiftDay,
	typeLabel,
	zoneLookup
} from './shared';
import type { Cell, Crew, EventDraft, EventRow, LegRow, SavedPoi } from './types';
import {
	estimateFor,
	journeyFields,
	legFields,
	sameFields,
	type JourneyEdit,
	type JourneyEdits,
	type JourneyFields
} from './journeys';

function automatic(leg: LegRow) {
	const mode = leg.autoMode ?? guessLeg(leg.km).mode;
	return { mode, mins: estimateFor(leg, mode) };
}

function isAutomatic(leg: LegRow, edit: JourneyFields) {
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
	initialPoi,
	legs,
	liveLegs,
	eventOf,
	peopleLabel,
	members,
	crews,
	saved,
	stays,
	cities,
	cityId,
	cityOf,
	firstDay,
	lastDay,
	locked,
	onPreview,
	onJourneys,
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
	initialPoi?: { id: string; name: string };
	/** The journeys into this event with the draft applied, before the journey edits below. */
	legs: LegRow[];
	/** The same journeys with the journey edits applied, as the board draws them. */
	liveLegs?: LegRow[];
	eventOf: (eventId: string) => EventRow | null;
	peopleLabel: (ids: string[]) => string;
	members: { id: string; name: string }[];
	crews: Crew[];
	saved: SavedPoi[];
	stays: SavedPoi[];
	cities: (Cell | null)[];
	/** For ordering the place picker: the event's city, or the open day's. */
	cityId: string | null;
	/**
	 * The city of a day the board has loaded: its id, null when that day has
	 * none, or undefined when the day is not loaded and so is not known here.
	 */
	cityOf?: (day: string) => string | null | undefined;
	firstDay: string;
	lastDay: string;
	locked: boolean;
	onPreview: (draft: EventDraft | null) => void;
	/** The journey edits as typed, for the board's preview; null when there are none. */
	onJourneys?: (edits: JourneyEdits | null) => void;
	onClose: () => void;
	onDone: () => void;
}) {
	const opensAt = startMin ?? suggestedStart ?? STAY_CHECK_IN;
	const openStart = Math.min(opensAt, DAY_END - MIN_EVENT_MINS);
	/* An end stored as 24:00 is shown as it is picked and read, 12:00 AM on the
	   morning after, as the web dialog does: an End row reading "Sat 12:00 AM"
	   for a block that runs to the end of Saturday says it ends as Saturday
	   begins, and re-picking that 12:00 AM would quietly lose the day. Saving
	   folds it back (`normalizeSpan`). Not for a journey across zones, whose
	   stored form keeps a midnight arrival where it is. */
	const endsAtMidnight =
		!!event &&
		event.type !== 'stay' &&
		event.end_min >= DAY_END &&
		!crossesZones(event, zoneLookup(cities));
	const openEnd = openStart + 60;
	const [eventType, setEventType] = useState<EventType>(event?.type ?? initialType);
	const [start, setStart] = useState(event?.start_min ?? openStart);
	const [end, setEnd] = useState(
		event ? (endsAtMidnight ? 0 : event.end_min) : openEnd >= DAY_END ? 0 : openEnd
	);
	const [timeChosen, setTimeChosen] = useState(!!event || startMin != null);
	const [date, setDate] = useState(event?.day ?? day);
	// A timed event's last day (inclusive), as shown. It opens on the start day,
	// and a stay's checkout is its own field below, so neither leaks into the other.
	const [endDate, setEndDate] = useState(
		event && event.type !== 'stay'
			? endsAtMidnight
				? shiftDay(lastDayOf(event), 1)
				: lastDayOf(event)
			: !event && openEnd >= DAY_END
				? shiftDay(day, 1)
				: (event?.day ?? day)
	);
	const [endCity, setEndCity] = useState(event?.end_city_id ?? '');
	// A journey's departure city once picked; null follows the event's own city,
	// or for a new one the city of the day it is put on.
	const [departPick, setDepartPick] = useState<string | null>(null);
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
		: (initialPoi?.name ?? '');

	const place = usePlaceField({
		base,
		type: eventType,
		cities,
		cityId,
		saved,
		stays,
		initialPoi: event ? savedPick : (initialPoi?.id ?? ''),
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
	// The end is read as picked: on a later day, or in an arrival city's zone, it
	// can be an earlier clock than the start. `spanProblem` judges it instead.
	const endAt = staying ? DAY_END : end;
	const zoneOf = useMemo(() => zoneLookup(cities), [cities]);
	const knownCities = cities.filter((c): c is Cell => c != null);
	const cityName = (id: string | null) => knownCities.find((c) => c.id === id)?.name ?? '';
	// A journey on a trip with somewhere else to go (or one already going
	// somewhere) asks where it leaves from and where it lands.
	const offerCities = eventType === 'travel' && (knownCities.length > 1 || !!event?.end_city_id);
	// The city of the chosen day, when the board has it loaded; undefined when not.
	const dayCity = cityOf?.(onDay);
	// The departure the row shows: the one picked, else the event's own, else a
	// new one's chosen day's city when that day is loaded. Null (a blank row)
	// when none of those is known, rather than a guess.
	const departure =
		(offerCities ? departPick : null) ?? (event ? event.city_id : (dayCity ?? null));
	// The city sent, as on web: only one that is known. Otherwise absent, so the
	// server works the day's city out (`cityOfDay`) instead of being overruled.
	const sentCity = offerCities && departure ? departure : event ? null : (dayCity ?? null);
	// The city the start is judged and previewed in, which may fall back to the
	// open day's city: a best guess for drawing, never sent. A picked place's
	// city comes first for a block that has one (not a journey, not free time),
	// because the server stores that block's city from its place.
	const placeCity =
		eventType !== 'travel' && eventType !== 'freetime' && place.placeable && place.poi
			? ((staying ? stays : saved).find((p) => p.id === place.poi)?.city_id ?? null)
			: null;
	const startCity =
		placeCity || (offerCities && departure) || (event ? event.city_id : (dayCity ?? cityId));
	const arrival = eventType === 'travel' && endCity && endCity !== startCity ? endCity : null;
	/* The span as picked, which is what `spanProblem` judges, and the one form
	   it is stored in (`normalizeSpan`), which is what is drawn and sent: 12:00
	   AM the next morning on the same clock is 24:00 of the day itself, so the
	   preview leaves no sliver on tomorrow and the save says exactly what the
	   server will keep. */
	const typed: SpanRow = {
		type: eventType,
		day: onDay,
		end_day: staying ? checkOut : endDate !== date ? endDate : null,
		start_min: startAt,
		end_min: endAt,
		city_id: startCity,
		end_city_id: arrival
	};
	const settled = staying
		? { end_day: checkOut, end_city_id: null, end_min: DAY_END }
		: normalizeSpan(typed, zoneOf);
	const crossing = crossesZones({ ...typed, ...settled }, zoneOf);
	/** The end is picked on the start's day and clock, so the two compare as picked. */
	const sameClock = endDate === date && !crossing;
	const problem = staying ? null : spanMessage(typed, settled.end_day, zoneOf, firstDay, lastDay);
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
			end_day: settled.end_day,
			title,
			type: eventType,
			start_min: startAt,
			end_min: settled.end_min,
			city_id: startCity,
			end_city_id: settled.end_city_id,
			people: people ?? [],
			lat,
			lng
		});
		return () => onPreview(null);
	}, [
		locked,
		previewId,
		onDay,
		settled.end_day,
		title,
		eventType,
		startAt,
		settled.end_min,
		startCity,
		settled.end_city_id,
		people,
		lat,
		lng
	]);

	/* The journey edits go to the board as they are typed, beside the draft, so
	   its bars, their place, the tight mark and the view-as marks follow them;
	   closing the sheet (save or cancel) takes them off again. They used to stay
	   in here until the save, so the board showed the old journey under a sheet
	   that said otherwise. */
	useEffect(() => {
		if (locked || !onJourneys) return;
		onJourneys(Object.keys(journeyEdits).length ? journeyEdits : null);
		return () => onJourneys(null);
	}, [journeyEdits, locked, onJourneys]);

	const placeMoved = place.poi !== savedPick || place.place.trim() !== openedOn.trim();
	/* The span refusal this sheet raised itself, which then follows the span as
	   it is corrected (as the web dialog's message does) rather than standing
	   until the next save. A refusal from the server stands as sent. */
	const refused = useRef<string | null>(null);
	const versionTook = (res: { version?: number } | null | undefined) => {
		if (typeof res?.version === 'number') openedVersion.current = res.version;
	};

	const save = useMutation(
		async () => {
			refused.current = null;
			if (!people) throw new Error(NO_PEOPLE);
			if (problem) {
				refused.current = problem;
				throw new Error(problem);
			}
			// The length a new event is created with, start to its stored end on
			// the wall clock across however many days it covers.
			const length =
				settled.end_min -
				startAt +
				(staying ? 0 : dayDiff(date, settled.end_day ?? date) * DAY_END);
			if (!event) {
				created.current ??= (
					await api<{ id: string }>(`${base}/events`, {
						method: 'POST',
						body: {
							day: onDay,
							endDay: staying ? checkOut : (settled.end_day ?? undefined),
							endCityId: settled.end_city_id ?? undefined,
							// The city the start is read in, only when it is known: the
							// departure picked or shown on a journey, else the chosen
							// day's city if the board has that day loaded. Absent lets
							// the server work out the day's city itself.
							cityId: staying ? undefined : (sentCity ?? undefined),
							title: label.trim() || undefined,
							type: eventType,
							start: startAt,
							duration: length,
							endMin: staying ? undefined : settled.end_min,
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
						endMin: staying ? undefined : settled.end_min,
						day: onDay,
						// A span's last day, or null to bring a span back to one day.
						// Silent on an event that never had one, so a plain edit sends
						// what it always did.
						endDay: staying
							? checkOut
							: (settled.end_day ?? (event.type !== 'stay' && event.end_day ? null : undefined)),
						// Set, cleared, or untouched, by the same rule.
						endCityId: settled.end_city_id ?? (event.end_city_id ? null : undefined),
						// Only from the row that shows it, so an edit elsewhere never
						// moves an event to another city's clock.
						cityId: offerCities ? (departure ?? undefined) : undefined,
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

	/**
	 * Moving the start carries the end with it, keeping the length, as the web
	 * dialog does. A block on one clock on one day stops at midnight, as before.
	 * Anything else (a span, or a journey whose end is on another city's clock)
	 * moves its end by the same minutes on the end's own clock, which is the
	 * same real time: a red-eye that leaves an hour later lands an hour later,
	 * even when that is tomorrow. Nothing is held to the trip's last day; an end
	 * pushed past it is shown as a problem rather than quietly shortened.
	 */
	const setStartMinute = (nextStart: number) => {
		setTimeChosen(true);
		if (sameClock) {
			const length = Math.max(MIN_EVENT_MINS, end - start);
			const bounded = Math.max(0, Math.min(DAY_END - MIN_EVENT_MINS, nextStart));
			setStart(bounded);
			placeEnd(endDate, Math.min(DAY_END, bounded + length));
			return;
		}
		setStart(nextStart);
		let endMin = end + (nextStart - start);
		let endOn = endDate;
		while (endMin > DAY_END) {
			endMin -= DAY_END;
			endOn = shiftDay(endOn, 1);
		}
		while (endMin < 0 && endOn > date) {
			endMin += DAY_END;
			endOn = shiftDay(endOn, -1);
		}
		placeEnd(endOn, Math.max(0, endMin));
	};

	/**
	 * Put the end at `minute` on `on`. A same-clock 24:00 is shown as 12:00 AM
	 * the next morning, the way it is read (see `endsAtMidnight`), so the End
	 * row never says a day ends as it begins; the save folds it back. A
	 * journey's arrival on another clock keeps its midnight where it is.
	 */
	const placeEnd = (on: string, minute: number) => {
		if (minute >= DAY_END && !crossing) {
			setEndDate(shiftDay(on, 1));
			setEnd(0);
			return;
		}
		setEndDate(on);
		setEnd(minute);
	};

	/**
	 * Moving the start day moves the end day the same number of days, so a
	 * three-day hike stays three days wherever it goes. Past the trip's last
	 * day it says so (`outsideTrip`) instead of losing a day.
	 */
	const setStartDay = (next: string) => {
		setEndDate(shiftDay(endDate, dayDiff(date, next)));
		setDate(next);
	};

	const setEndDay = (next: string) => {
		setTimeChosen(true);
		setEndDate(next < date ? date : next);
	};

	// Only the fields touched are held (see `journeys.ts`); picking a mode drops
	// typed minutes, so the minutes read as that mode's estimate.
	const setJourney = (leg: LegRow, patch: JourneyEdit) => {
		setJourneyEdits((old) => ({ ...old, [leg.key]: { ...old[leg.key], ...patch } }));
	};

	// "(optional)" is advice about filling a field in, so a read-only view leaves it off.
	const optional = locked ? '' : copy.ui.field.optionalSuffix;

	return (
		<>
			<Sheet
				open={open && (confirmOverlays || !confirmDelete)}
				busy={confirmOverlays && remove.busy}
				busyLabel={copy.common.deleting}
				title={
					locked
						? copy.schedule.dialog.view
						: event
							? copy.schedule.dialog.edit
							: copy.schedule.dialog.add
				}
				onClose={onClose}
				onPrimary={locked ? undefined : () => void save.run()}
				primaryLabel={locked ? undefined : event ? copy.common.save : copy.common.add}
				primaryBusyLabel={event ? copy.common.saving : copy.common.adding}
				primaryBusy={save.busy}
				primaryDisabled={place.saving}
				error={save.error && save.error === refused.current ? (problem ?? '') : save.error}
			>
				<InsetSection>
					<Field
						variant="row"
						label={`${copy.schedule.fields.label}${optional}`}
						value={label}
						placeholder={derived}
						maxLength={MAX_NAME_LENGTH}
						onChangeText={setLabel}
						editable={!locked}
						last
					/>
				</InsetSection>
				{place.field}
				<RowPicker
					label={copy.schedule.fields.type}
					value={eventType}
					options={TYPE_OPTIONS}
					readonly={locked}
					onPick={(next) => {
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
					// Start and End are one section, each a day and a time, like
					// Calendar's Starts / Ends; a journey's arrival city closes it.
					<InsetSection>
						{locked ? (
							<>
								<ListRow
									title={copy.schedule.fields.start}
									value={`${formatDay(date, { year: true })}  ${timeLabel(start)}`}
									accessory="none"
								/>
								<ListRow
									title={copy.schedule.fields.end}
									value={`${formatDay(endDate, { year: true })}  ${timeLabel(end)}`}
									accessory="none"
									last={!offerCities}
								/>
								{offerCities ? (
									<>
										<ListRow
											title={copy.schedule.fields.departsFrom}
											value={cityName(departure)}
											accessory="none"
										/>
										<ListRow
											title={copy.schedule.fields.arrivesIn}
											value={arrival ? cityName(arrival) : copy.schedule.fields.sameCity}
											accessory="none"
											last
										/>
									</>
								) : null}
							</>
						) : (
							<>
								<DateTimeField
									label={copy.schedule.fields.start}
									dayLabel={copy.schedule.fields.date}
									day={date}
									minute={start}
									onDay={setStartDay}
									onMinute={setStartMinute}
									minimumDay={firstDay}
									maximumDay={lastDay}
									maximumMinute={sameClock ? DAY_END - MIN_EVENT_MINS : DAY_END - 5}
								/>
								{/* Up to the morning after the last day, so a span can end at
								    the trip's last midnight (12:00 AM then); any later time on
								    that morning is outside the trip and says so. */}
								<DateTimeField
									label={copy.schedule.fields.end}
									dayLabel={copy.schedule.fields.endDate}
									day={endDate}
									minute={end}
									onDay={setEndDay}
									onMinute={(v) => {
										setTimeChosen(true);
										placeEnd(endDate, v);
									}}
									minimumDay={date}
									maximumDay={shiftDay(lastDay, 1)}
									minimumMinute={sameClock ? start + MIN_EVENT_MINS : 0}
									maximumMinute={DAY_END}
									invalid={problem != null}
									last={!offerCities}
								/>
								{offerCities ? (
									<>
										<InlinePicker
											label={copy.schedule.fields.departsFrom}
											value={departure ?? ''}
											options={knownCities.map((c) => ({ key: c.id, label: c.name }))}
											onPick={setDepartPick}
											last={false}
										/>
										<InlinePicker
											label={copy.schedule.fields.arrivesIn}
											value={arrival ?? ''}
											options={[
												{ key: '', label: copy.schedule.fields.sameCity },
												...knownCities
													.filter((c) => c.id !== departure)
													.map((c) => ({ key: c.id, label: c.name }))
											]}
											onPick={setEndCity}
										/>
									</>
								) : null}
							</>
						)}
					</InsetSection>
				)}
				{eventType === 'travel' ? (
					<RowPicker
						label={`${copy.schedule.fields.mode}${optional}`}
						value={mode}
						options={[{ key: '', label: copy.schedule.journey.automatic }, ...MODE_OPTIONS]}
						readonly={locked}
						onPick={setMode}
					/>
				) : null}
				<PeopleChooser
					people={members}
					crews={crews}
					value={people}
					readonly={locked}
					onChange={setPeople}
				/>
				{locked ? (
					<InsetSection>
						<ListRow
							title={copy.schedule.fields.notes}
							subtitle={notes || undefined}
							accessory="none"
							last
						/>
					</InsetSection>
				) : (
					<InsetSection title={`${copy.schedule.fields.notes}${copy.ui.field.optionalSuffix}`}>
						<TextInput
							accessibilityLabel={copy.schedule.fields.notes}
							value={notes}
							onChangeText={setNotes}
							multiline
							maxLength={MAX_NOTES_LENGTH}
							placeholderTextColor={color.inkFaint}
							style={{
								minHeight: 88,
								textAlignVertical: 'top',
								backgroundColor: color.surface,
								paddingHorizontal: rowInset,
								paddingVertical: space.md,
								fontSize: 17,
								color: color.ink
							}}
						/>
					</InsetSection>
				)}
				<JourneyEditor
					legs={legs}
					liveLegs={liveLegs}
					edits={journeyEdits}
					eventOf={eventOf}
					peopleLabel={peopleLabel}
					readonly={locked}
					onSet={setJourney}
				/>
				{locked ? (
					<View
						style={{
							flexDirection: 'row',
							alignItems: 'center',
							gap: space.xs,
							marginHorizontal: space.lg
						}}
					>
						<AppSymbol
							name="lock.fill"
							fallback="lock-closed-outline"
							size={13}
							color={color.warn}
						/>
						<Text style={{ ...type.footnote, color: color.warn }}>{copy.schedule.lock.footer}</Text>
					</View>
				) : null}
				{!locked && event ? (
					<InsetSection>
						<DestructiveRow
							title={copy.common.delete}
							accessibilityLabel={copy.common.deleteLabel(event.title)}
							onPress={() => setConfirmDelete(true)}
						/>
					</InsetSection>
				) : null}
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
		<InsetSection>
			{readonly ? (
				<>
					<ListRow
						title={copy.schedule.fields.checkIn}
						value={dayLabel(checkIn)}
						accessory="none"
					/>
					<ListRow
						title={copy.schedule.fields.checkOut}
						value={dayLabel(checkOut)}
						accessory="none"
						last
					/>
				</>
			) : (
				<>
					<DateField
						label={copy.schedule.fields.checkIn}
						value={checkIn}
						minimum={firstDay}
						maximum={lastDay}
						onChange={(next) => {
							onCheckIn(next);
							if (next >= checkOut) onCheckOut(shiftDay(next, 1));
						}}
					/>
					<DateField
						label={copy.schedule.fields.checkOut}
						value={checkOut}
						minimum={shiftDay(checkIn, 1)}
						maximum={lastOut}
						onChange={onCheckOut}
						last
					/>
				</>
			)}
		</InsetSection>
	);
}

function RowPicker({
	label,
	value,
	options,
	readonly,
	onPick
}: {
	label: string;
	value: string;
	options: { key: string; label: string }[];
	readonly?: boolean;
	onPick: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const current = options.find((option) => option.key === value);
	return (
		<InsetSection>
			<ListRow
				title={label}
				value={current?.label ?? value}
				accessory={readonly ? 'none' : 'chevron'}
				onPress={readonly ? undefined : () => setOpen((v) => !v)}
				last={!open}
			/>
			{open
				? options.map((option, index) => (
						<ListRow
							key={option.key}
							title={option.label}
							accessory={option.key === value ? 'checkmark' : 'none'}
							accessibilityState={{ selected: option.key === value }}
							onPress={() => {
								onPick(option.key);
								setOpen(false);
							}}
							last={index === options.length - 1}
						/>
					))
				: null}
		</InsetSection>
	);
}

function timeLabel(value: number): string {
	return value === DAY_END ? '12:00 AM' : clock(value);
}

/**
 * The sentence for what is wrong with a timed event's span, from the shared
 * rules. Outside the trip first, as the web dialog orders it: a date past the
 * last day is the one fix that is not about the clock. The span is judged as
 * picked, but the trip's bound as stored, so 12:00 AM on the morning after the
 * last day is allowed, being the last day's own midnight.
 */
function spanMessage(
	typed: SpanRow,
	storedEndDay: string | null,
	zoneOf: ZoneOf,
	firstDay: string,
	lastDay: string
): string | null {
	if ((storedEndDay ?? typed.day) > lastDay || lastDayOf(typed) < firstDay) {
		return copy.schedule.span.outsideTrip;
	}
	const wrong = spanProblem(typed, zoneOf);
	if (wrong === 'end-before-start') return copy.schedule.span.endBeforeStart;
	if (wrong === 'too-long') return copy.schedule.span.tooLong;
	return null;
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
		<InsetSection
			title={copy.schedule.fields.participants}
			footer={
				// The rows already say who is on it, so the footer only speaks up for
				// the one state no row shows: nobody.
				readonly ? undefined : value === null ? copy.schedule.fields.nobody : undefined
			}
		>
			{readonly ? (
				everyone ? (
					<ListRow title={copy.common.everyone} accessory="none" last />
				) : (
					people
						.filter((person) => selected.has(person.id))
						.map((person, index, list) => (
							<ListRow
								key={person.id}
								title={person.name}
								accessory="none"
								last={index === list.length - 1}
							/>
						))
				)
			) : (
				<>
					{crews.map((crew) => (
						<ChecklistRow
							key={crew.id}
							label={crew.name}
							checked={crew.members
								.filter((id) => ids.includes(id))
								.every((id) => selected.has(id))}
							onPress={() => toggleCrew(crew)}
						/>
					))}
					{people.map((person, index) => (
						<ChecklistRow
							key={person.id}
							label={person.name}
							checked={selected.has(person.id)}
							onPress={() => toggle(person.id)}
							last={index === people.length - 1}
						/>
					))}
				</>
			)}
		</InsetSection>
	);
}

function JourneyEditor({
	legs,
	liveLegs,
	edits,
	eventOf,
	peopleLabel,
	readonly,
	onSet
}: {
	legs: LegRow[];
	liveLegs?: LegRow[];
	edits: Record<string, JourneyEdit>;
	eventOf: (eventId: string) => EventRow | null;
	peopleLabel: (ids: string[]) => string;
	readonly: boolean;
	onSet: (leg: LegRow, patch: JourneyEdit) => void;
}) {
	if (!legs.length) return null;
	return (
		<View style={{ gap: space.sm }}>
			{legs.map((leg) => {
				const edit = journeyFields(leg, edits[leg.key]);
				const from = eventOf(leg.fromEventId)?.title ?? null;
				// Whether it fits is the board's answer, edits included.
				const tight = (liveLegs?.find((l) => l.key === leg.key) ?? leg).tight;
				return (
					<InsetSection
						key={leg.key}
						title={copy.schedule.journey.heading}
						footer={peopleLabel(leg.people)}
					>
						{tight ? (
							<View style={{ paddingHorizontal: rowInset, paddingTop: space.md }}>
								<Text style={{ ...type.footnote, color: color.warn }}>
									{copy.viewAs.travelWarning}
								</Text>
							</View>
						) : null}
						{readonly ? (
							<>
								{/* The mode once: in the name when it is the board's own
								    ("Walk from X"), else on its own row under a name
								    somebody gave it. */}
								<ListRow
									title={copy.schedule.journey.name}
									value={
										edit.title ||
										(from ? `${modeLabel(edit.mode)} from ${from}` : modeLabel(edit.mode))
									}
									accessory="none"
								/>
								{edit.title ? (
									<ListRow
										title={copy.schedule.fields.mode}
										value={modeLabel(edit.mode)}
										accessory="none"
									/>
								) : null}
								<ListRow
									title={copy.schedule.journey.minutes}
									value={`${edit.mins} ${copy.schedule.journey.minutesUnit}`}
									accessory="none"
									last
								/>
							</>
						) : (
							<>
								<Field
									variant="row"
									label={`${copy.schedule.journey.name}${copy.ui.field.optionalSuffix}`}
									value={edit.title}
									placeholder={from ? `${modeLabel(edit.mode)} from ${from}` : modeLabel(edit.mode)}
									onChangeText={(v) => onSet(leg, { title: v })}
								/>
								<InlinePicker
									label={copy.schedule.fields.mode}
									options={MODE_OPTIONS.map((o) => ({
										...o,
										label: `${o.label} ${copy.schedule.journey.estimate(estimateFor(leg, o.key))}`
									}))}
									value={edit.mode}
									onPick={(next) => onSet(leg, { mode: next, mins: undefined })}
								/>
								<Field
									variant="row"
									label={copy.schedule.journey.minutes}
									value={edit.mins}
									keyboardType="number-pad"
									onChangeText={(v) => onSet(leg, { mins: v })}
									last
								/>
							</>
						)}
					</InsetSection>
				);
			})}
		</View>
	);
}

function InlinePicker({
	label,
	value,
	options,
	onPick,
	last = true
}: {
	label: string;
	value: string;
	options: { key: string; label: string }[];
	onPick: (value: string) => void;
	/** The section's last row, which draws no hairline under itself or its list. */
	last?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const current = options.find((option) => option.key === value);
	return (
		<>
			<ListRow
				title={label}
				value={current?.label ?? value}
				onPress={() => setOpen((v) => !v)}
				last={last && !open}
			/>
			{open
				? options.map((option, index) => (
						<ListRow
							key={option.key}
							title={option.label}
							accessory={option.key === value ? 'checkmark' : 'none'}
							onPress={() => {
								onPick(option.key);
								setOpen(false);
							}}
							last={last && index === options.length - 1}
						/>
					))
				: null}
		</>
	);
}

async function saveJourneys(
	base: string,
	day: string,
	toEventId: string,
	legs: LegRow[],
	edits: Record<string, JourneyEdit>
) {
	const touched = legs.filter(
		(leg) => edits[leg.key] && !sameFields(journeyFields(leg, edits[leg.key]), legFields(leg))
	);
	if (!touched.length) return;
	const fresh = await api<{ board: { legs: LegRow[] }[] }>(`${base}?day=${day}`);
	const rows = new Map(fresh.board.flatMap((b) => b.legs).map((leg) => [leg.key, leg]));
	for (const leg of touched) {
		const row = rows.get(rekeyLeg(leg.key, toEventId));
		if (!row) continue;
		const edit = journeyFields(leg, edits[leg.key]);
		const legTitle = edit.title.trim();
		await api(`${base}/legs/${row.id}`, {
			method: 'PATCH',
			body: isAutomatic(row, edit)
				? { mode: '', mins: '', title: legTitle }
				: { mode: edit.mode, mins: edit.mins, title: legTitle }
		});
	}
}
