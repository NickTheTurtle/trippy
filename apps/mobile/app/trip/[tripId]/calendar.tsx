import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { useTripId } from '../../../src/trip-id';
import { useApi } from '../../../src/hooks/useApi';
import { useLiveSection } from '../../../src/hooks/useTripEvents';
import { useToast } from '../../../src/ui/Toast';
import {
	Button,
	EmptyState,
	FormError,
	InsetSection,
	ListRow,
	Loading,
	Screen
} from '../../../src/ui';
import { DateField, SegmentedControl } from '../../../src/ui/controls';
import { Sheet } from '../../../src/ui/Sheet';
import { useTripHeaderAction } from '../../../src/ui/TripHeaderAction';
import { useSheetHandoff } from '../../../src/ui/useSheetHandoff';
import { AppSymbol } from '../../../src/ui/Symbol';
import { color, hairline, radius, space, type } from '../../../src/theme';
import { DayBoard } from '../../../src/screens/schedule/DayBoard';
import { DayMap } from '../../../src/screens/schedule/DayMap';
import { EventSheet } from '../../../src/screens/schedule/EventSheet';
import { useScheduleDay } from '../../../src/screens/schedule/useScheduleDay';
import {
	clockRange,
	dayLabel,
	modeLabel,
	rangeLabel,
	typeLabel
} from '../../../src/screens/schedule/shared';
import type { BoardDay, EventRow, LegRow, ScheduleData } from '../../../src/screens/schedule/types';

type TripData = { trip: { schedule_locked: number } };

export default function Calendar() {
	const tripId = useTripId();
	const toast = useToast();
	const [gestureActive, setGestureActive] = useState(false);
	const tripState = useApi<TripData>(`/trips/${tripId}`);
	const schedule = useScheduleDay(tripId, gestureActive);
	useLiveSection(['trip'], tripState.reload);
	const data = schedule.data;
	const locked = tripState.data?.trip.schedule_locked === 1;
	const [adding, setAdding] = useState<{
		day: string;
		type?: EventRow['type'];
		poi?: { id: string; name: string };
	} | null>(null);
	const [opened, setOpened] = useState<EventRow | null>(null);
	const [mapFocusId, setMapFocusId] = useState<string | null>(null);
	const [mapFocusKey, setMapFocusKey] = useState(0);
	const [addMenuOpen, setAddMenuOpen] = useState(false);
	const [jumpOpen, setJumpOpen] = useState(false);
	const [viewAsOpen, setViewAsOpen] = useState(false);
	const openedRef = useRef<ScheduleData | null>(null);
	openedRef.current = data;
	const memberName = useMemo(
		() => new Map((data?.members ?? []).map((member) => [member.id, member.name])),
		[data?.members]
	);
	const memberIds = useMemo(() => data?.members.map((member) => member.id) ?? [], [data?.members]);

	// Stable, so the memoized board blocks and the map do not all re-render on
	// every gesture start and end. It reads the latest payload through the ref.
	const openAndFocus = useCallback((id: string) => {
		setMapFocusId(id);
		setMapFocusKey((key) => key + 1);
		for (const entry of openedRef.current?.board ?? []) {
			for (const event of [...entry.events, ...entry.stays]) {
				if (event.id === id) {
					setOpened(event);
					return;
				}
			}
		}
	}, []);

	useEffect(() => {
		if (schedule.error) toast.error(schedule.error);
	}, [schedule.error, toast]);
	useEffect(() => {
		setMapFocusId(null);
		setMapFocusKey((key) => key + 1);
	}, [data?.day]);
	const headerAdd = useCallback(() => {
		if (!locked && data) setAddMenuOpen(true);
	}, [data, locked]);
	useTripHeaderAction(!locked && data ? headerAdd : null);
	const addHandoff = useSheetHandoff({
		event: () => data && setAdding({ day: data.day }),
		stay: () => data && setAdding({ day: data.day, type: 'stay' })
	});

	if (schedule.loading && !data) return <Loading />;
	if (!data || !schedule.anchor) {
		return (
			<Screen>
				<FormError message={schedule.error ?? copy.api.loadFailed} />
				<Button label={copy.api.retry} onPress={schedule.reload} />
			</Screen>
		);
	}

	const refresh = () => {
		schedule.reload();
		tripState.reload();
	};

	return (
		<>
			<Screen
				scrollEnabled={!gestureActive}
				refreshControl={
					<RefreshControl refreshing={schedule.loading && !!data} onRefresh={refresh} />
				}
			>
				<FormError message={schedule.error ?? ''} />
				<View style={{ gap: space.md }}>
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
						<IconButton
							label={copy.schedule.nav.previousDay}
							icon="chevron.left"
							fallback="chevron-back"
							disabled={!data.prevDay}
							onPress={schedule.stepPrev}
						/>
						<View style={{ flex: 1, alignItems: 'center' }}>
							<Text style={type.title2}>{dayLabel(data.day)}</Text>
							<Text style={type.faint}>
								{[
									!data.prevDay ? copy.schedule.mobile.firstDay : null,
									!data.nextDay ? copy.schedule.mobile.lastDay : null
								]
									.filter(Boolean)
									.join(' · ') || ' '}
							</Text>
						</View>
						<IconButton
							label={copy.schedule.nav.nextDay}
							icon="chevron.right"
							fallback="chevron-forward"
							disabled={!data.nextDay}
							onPress={schedule.stepNext}
						/>
					</View>
					<SegmentedControl
						items={[
							{ key: 'day', label: copy.schedule.views.day },
							{ key: 'agenda', label: copy.schedule.views.agenda }
						]}
						active={schedule.view}
						onPick={(view) => schedule.setView(view as 'day' | 'agenda')}
					/>
					<InsetSection>
						<ListRow
							title={copy.schedule.nav.jumpToDate}
							value={dayLabel(data.day)}
							onPress={() => setJumpOpen(true)}
						/>
						<ListRow
							title={copy.viewAs.label}
							value={
								schedule.viewAsOptions.find((option) => option.key === schedule.readAs)?.label ??
								copy.viewAs.everyone
							}
							onPress={() => setViewAsOpen(true)}
							last
						/>
					</InsetSection>
					{locked ? (
						<Text style={{ ...type.footnote, color: color.warn, marginHorizontal: space.lg }}>
							{copy.schedule.lock.hint}
						</Text>
					) : null}
				</View>

				<StayBand stays={schedule.anchor.stays} locked={locked} onOpenEvent={openAndFocus} />
				{schedule.view === 'day' ? (
					<View
						style={{
							backgroundColor: color.surface,
							borderRadius: radius.section,
							overflow: 'hidden'
						}}
					>
						<DayBoard
							base={`/trips/${tripId}/schedule`}
							entry={schedule.anchor}
							memberIds={memberIds}
							peopleLabel={schedule.peopleLabel}
							eventById={schedule.eventById}
							locked={locked}
							onOpen={openAndFocus}
							onGestureChange={setGestureActive}
							onReload={schedule.reload}
						/>
					</View>
				) : (
					<Agenda
						entry={schedule.anchor}
						eventById={schedule.eventById}
						peopleLabel={schedule.peopleLabel}
						memberName={memberName}
						locked={locked}
						onOpenEvent={openAndFocus}
						onOpenLeg={(leg) => openAndFocus(leg.toEventId)}
					/>
				)}
				<DayMap
					entry={schedule.anchor}
					saved={data.saved}
					city={schedule.anchor.city}
					memberIds={schedule.visibleMemberIds}
					peopleLabel={schedule.peopleLabel}
					locked={locked}
					focusId={mapFocusId}
					focusKey={mapFocusKey}
					onOpenEvent={openAndFocus}
					onAddPlace={(place) =>
						setAdding({
							day: data.day,
							type: place.kind === 'food' ? 'food' : 'activity',
							poi: place
						})
					}
					onClearFocus={() => setMapFocusId(null)}
				/>
			</Screen>

			{adding ? (
				<EventSheet
					open
					base={`/trips/${tripId}/schedule`}
					event={null}
					day={adding.day}
					suggestedStart={schedule.suggestedStart(adding.day)}
					initialType={adding.type ?? 'activity'}
					initialPoi={adding.poi}
					legs={schedule.draftLegs}
					eventOf={(id) => schedule.eventById.get(id) ?? null}
					peopleLabel={schedule.peopleLabel}
					members={data.members}
					crews={data.crews}
					saved={data.saved}
					stays={data.stays}
					cities={data.cities}
					cityId={schedule.anchor.city?.id ?? null}
					firstDay={data.firstDay}
					lastDay={data.lastDay}
					locked={locked}
					onPreview={schedule.setPreview}
					onClose={() => setAdding(null)}
					onDone={() => {
						setAdding(null);
						schedule.setPreview(null);
						schedule.reload();
					}}
				/>
			) : null}
			{opened ? (
				<EventSheet
					open
					base={`/trips/${tripId}/schedule`}
					event={opened}
					day={opened.day}
					legs={schedule.legsTo(opened.id)}
					eventOf={(id) => schedule.eventById.get(id) ?? null}
					peopleLabel={schedule.peopleLabel}
					members={data.members}
					crews={data.crews}
					saved={data.saved}
					stays={data.stays}
					cities={data.cities}
					cityId={opened.city_id ?? schedule.anchor.city?.id ?? null}
					firstDay={data.firstDay}
					lastDay={data.lastDay}
					locked={locked}
					onPreview={schedule.setPreview}
					onClose={() => setOpened(null)}
					onDone={() => {
						setOpened(null);
						setMapFocusId(null);
						schedule.setPreview(null);
						schedule.reload();
					}}
				/>
			) : null}
			<AddMenuSheet
				open={addMenuOpen}
				onClose={() => setAddMenuOpen(false)}
				onDismiss={addHandoff.flush}
				onEvent={() => addHandoff.queue('event', () => setAddMenuOpen(false))}
				onStay={() => addHandoff.queue('stay', () => setAddMenuOpen(false))}
			/>
			<JumpSheet
				open={jumpOpen}
				value={data.day}
				days={data.days}
				firstDay={data.firstDay}
				lastDay={data.lastDay}
				onClose={() => setJumpOpen(false)}
				onPick={(next) => {
					schedule.setDay(next);
					setJumpOpen(false);
				}}
			/>
			<OptionSheet
				open={viewAsOpen}
				title={copy.viewAs.label}
				value={schedule.readAs}
				options={schedule.viewAsOptions.map((option) => ({
					key: option.key,
					label: option.warn ? `${option.label} (!)` : option.label
				}))}
				onClose={() => setViewAsOpen(false)}
				onPick={(next) => {
					schedule.setViewAs(next);
					setViewAsOpen(false);
				}}
			/>
		</>
	);
}

function IconButton({
	label,
	icon,
	fallback,
	disabled,
	onPress
}: {
	label: string;
	icon: string;
	fallback: React.ComponentProps<typeof AppSymbol>['fallback'];
	disabled?: boolean;
	onPress: () => void;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityState={{ disabled }}
			disabled={disabled}
			onPress={onPress}
			hitSlop={10}
			style={{
				width: 44,
				height: 44,
				alignItems: 'center',
				justifyContent: 'center',
				opacity: disabled ? 0.3 : 1
			}}
		>
			<AppSymbol name={icon} fallback={fallback} size={22} color={color.accent} />
		</Pressable>
	);
}

function AddMenuSheet({
	open,
	onClose,
	onDismiss,
	onEvent,
	onStay
}: {
	open: boolean;
	onClose: () => void;
	onDismiss: () => void;
	onEvent: () => void;
	onStay: () => void;
}) {
	return (
		<Sheet
			open={open}
			title={copy.schedule.add.replace(/^\+\s*/, '')}
			onClose={onClose}
			onDismiss={onDismiss}
		>
			<InsetSection>
				<ListRow
					title={copy.schedule.dialog.add}
					symbol={{ name: 'calendar.badge.plus', fallback: 'calendar-outline' }}
					onPress={onEvent}
				/>
				<ListRow
					title={copy.schedule.addStay.replace(/^\+\s*/, '')}
					symbol={{ name: 'bed.double', fallback: 'bed-outline' }}
					onPress={onStay}
					last
				/>
			</InsetSection>
		</Sheet>
	);
}

function JumpSheet({
	open,
	value,
	days,
	firstDay,
	lastDay,
	onClose,
	onPick
}: {
	open: boolean;
	value: string;
	days: string[];
	firstDay: string;
	lastDay: string;
	onClose: () => void;
	onPick: (day: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => {
		if (open) setDraft(value);
	}, [open, value]);
	return (
		<Sheet
			open={open}
			title={copy.schedule.nav.jumpToDate}
			onClose={onClose}
			onPrimary={() => {
				if (days.includes(draft)) onPick(draft);
				else {
					setDraft(value);
					onClose();
				}
			}}
			primaryLabel={copy.common.save}
		>
			<InsetSection>
				<DateField
					label={copy.schedule.fields.date}
					value={draft}
					onChange={setDraft}
					minimum={firstDay}
					maximum={lastDay}
					last
				/>
			</InsetSection>
		</Sheet>
	);
}

function OptionSheet({
	open,
	title,
	value,
	options,
	onClose,
	onPick
}: {
	open: boolean;
	title: string;
	value: string;
	options: { key: string; label: string }[];
	onClose: () => void;
	onPick: (key: string) => void;
}) {
	return (
		<Sheet open={open} title={title} onClose={onClose}>
			<InsetSection>
				{options.map((option, index) => (
					<ListRow
						key={option.key}
						title={option.label}
						accessory={option.key === value ? 'checkmark' : 'none'}
						accessibilityState={{ selected: option.key === value }}
						onPress={() => onPick(option.key)}
						last={index === options.length - 1}
					/>
				))}
			</InsetSection>
		</Sheet>
	);
}

function StayBand({
	stays,
	locked,
	onOpenEvent
}: {
	stays: EventRow[];
	locked: boolean;
	onOpenEvent: (id: string) => void;
}) {
	if (!stays.length) return null;
	return (
		<InsetSection title={copy.schedule.mobile.stays}>
			{stays.map((stay, index) => (
				<Pressable
					key={stay.id}
					accessibilityRole="button"
					accessibilityLabel={locked ? `View ${stay.title}` : copy.common.editLabel(stay.title)}
					onPress={() => onOpenEvent(stay.id)}
					style={({ pressed }) => ({
						minHeight: 44,
						paddingHorizontal: space.md,
						paddingVertical: space.sm,
						opacity: pressed ? 0.75 : 1,
						borderBottomWidth: index === stays.length - 1 ? 0 : hairline,
						borderBottomColor: color.line
					})}
				>
					<Text style={type.body}>{stay.title}</Text>
					<Text style={type.faint}>
						{stay.end_day ? rangeLabel(stay.day, stay.end_day) : dayLabel(stay.day)}
					</Text>
				</Pressable>
			))}
		</InsetSection>
	);
}

function Agenda({
	entry,
	eventById,
	peopleLabel,
	memberName,
	locked,
	onOpenEvent,
	onOpenLeg
}: {
	entry: BoardDay;
	eventById: Map<string, EventRow>;
	peopleLabel: (ids: string[]) => string;
	memberName: Map<string, string>;
	locked: boolean;
	onOpenEvent: (id: string) => void;
	onOpenLeg: (leg: LegRow) => void;
}) {
	const rows = useMemo(
		() =>
			[
				...entry.events.map((event) => ({
					key: event.id,
					start: event.start_min,
					node: (
						<EventCard
							event={event}
							memberName={memberName}
							locked={locked}
							onPress={() => onOpenEvent(event.id)}
						/>
					)
				})),
				...entry.legs.map((leg) => ({
					key: `leg:${leg.key}`,
					start: leg.startMin,
					node: (
						<JourneyCard
							leg={leg}
							from={eventById.get(leg.fromEventId)}
							to={eventById.get(leg.toEventId)}
							peopleLabel={peopleLabel}
							onPress={() => onOpenLeg(leg)}
						/>
					)
				}))
			].sort((a, b) => a.start - b.start),
		[entry.events, entry.legs, eventById, locked, onOpenEvent, onOpenLeg, peopleLabel]
	);
	if (!rows.length) {
		return (
			<InsetSection>
				<EmptyState message={copy.common.nothingAdded} hint={copy.schedule.mobile.freeDay} />
			</InsetSection>
		);
	}
	return (
		<InsetSection title={dayLabel(entry.day)}>
			{rows.map((row, index) => (
				<View
					key={row.key}
					style={{
						borderBottomWidth: index === rows.length - 1 ? 0 : hairline,
						borderBottomColor: color.line
					}}
				>
					{row.node}
				</View>
			))}
		</InsetSection>
	);
}

function EventCard({
	event,
	memberName,
	locked,
	onPress
}: {
	event: EventRow;
	memberName: Map<string, string>;
	locked: boolean;
	onPress: () => void;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			onPress={onPress}
			style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
		>
			<View
				style={{
					minHeight: 56,
					flexDirection: 'row',
					alignItems: 'center',
					gap: space.md,
					paddingHorizontal: space.md,
					paddingVertical: space.sm
				}}
			>
				<Text style={{ ...type.footnote, color: color.inkSoft, width: 76 }}>
					{clockRange(event.start_min, event.end_min)}
				</Text>
				<View style={{ flex: 1 }}>
					<Text style={{ ...type.body, fontWeight: '600' }} numberOfLines={2}>
						{event.title}
					</Text>
					<Text style={type.faint} numberOfLines={1}>
						{[
							event.place_text,
							event.people.length === 0
								? copy.common.everyone
								: event.people.map((id) => memberName.get(id) ?? '?').join(', ')
						]
							.filter(Boolean)
							.join(' · ')}
					</Text>
				</View>
				<Text style={{ color: color.inkFaint, fontSize: 28, lineHeight: 28 }}>›</Text>
			</View>
		</Pressable>
	);
}

function JourneyCard({
	leg,
	from,
	to,
	peopleLabel,
	onPress
}: {
	leg: LegRow;
	from?: EventRow;
	to?: EventRow;
	peopleLabel: (ids: string[]) => string;
	onPress: () => void;
}) {
	const mode = modeLabel(leg.resolvedMode);
	const name =
		leg.title ?? (from ? `${mode} from ${from.title}` : to ? `${mode} to ${to.title}` : mode);
	const detail = `${clockRange(leg.startMin, leg.endMin)}. ${mode}, ${leg.resolvedMins} min, ${peopleLabel(leg.people)}${leg.tight ? `. ${copy.viewAs.travelWarning}` : ''}`;
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={`${name}. ${detail}`}
			onPress={onPress}
			style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
		>
			<View
				style={{
					minHeight: 44,
					flexDirection: 'row',
					alignItems: 'center',
					gap: space.md,
					paddingLeft: space.md,
					paddingRight: space.md,
					paddingVertical: space.sm
				}}
			>
				<Text style={{ ...type.footnote, color: color.inkSoft, width: 76 }}>
					{clockRange(leg.startMin, leg.endMin)}
				</Text>
				<AppSymbol
					name={symbolForMode(leg.resolvedMode)}
					fallback="navigate-outline"
					size={15}
					color={leg.tight ? color.warn : color.inkFaint}
				/>
				<View style={{ flex: 1 }}>
					<Text style={type.subhead} numberOfLines={1}>
						{name}
					</Text>
					<Text style={type.faint} numberOfLines={1}>
						{mode} · {leg.resolvedMins} min · {peopleLabel(leg.people)}
					</Text>
				</View>
				{leg.tight ? (
					<AppSymbol
						name="exclamationmark.triangle.fill"
						fallback="warning-outline"
						size={14}
						color={color.warn}
					/>
				) : null}
			</View>
		</Pressable>
	);
}

function symbolForMode(mode: string): string {
	if (mode === 'walk') return 'figure.walk';
	if (mode === 'drive') return 'car.fill';
	if (mode === 'transit') return 'tram.fill';
	return 'location.fill';
}

function Tag({ label, tone = 'normal' }: { label: string; tone?: 'normal' | 'lock' }) {
	return (
		<Text
			style={{
				...type.faint,
				color: tone === 'lock' ? color.warn : color.accentInk,
				backgroundColor: tone === 'lock' ? color.warnSoft : color.accentSoft,
				borderRadius: radius.sm,
				paddingHorizontal: 6,
				paddingVertical: 1,
				overflow: 'hidden',
				fontSize: 11
			}}
		>
			{label}
		</Text>
	);
}
