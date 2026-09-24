import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { useTripId } from '../../../src/trip-id';
import { useApi } from '../../../src/hooks/useApi';
import { useLiveSection } from '../../../src/hooks/useTripEvents';
import { useToast } from '../../../src/ui/Toast';
import { Button, Card, EmptyState, FormError, Loading, Screen } from '../../../src/ui';
import { Picker } from '../../../src/ui/controls';
import { color, radius, space, type } from '../../../src/theme';
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
	const tripState = useApi<TripData>(`/trips/${tripId}`);
	const schedule = useScheduleDay(tripId);
	useLiveSection(['trip'], tripState.reload);
	const data = schedule.data;
	const locked = tripState.data?.trip.schedule_locked === 1;
	const [adding, setAdding] = useState<{ day: string; type?: EventRow['type'] } | null>(null);
	const [opened, setOpened] = useState<EventRow | null>(null);
	const openedRef = useRef<ScheduleData | null>(null);
	openedRef.current = data;
	const memberName = useMemo(
		() => new Map((data?.members ?? []).map((member) => [member.id, member.name])),
		[data?.members]
	);

	useEffect(() => {
		if (schedule.error) toast.error(schedule.error);
	}, [schedule.error, toast]);

	if (schedule.loading && !data) return <Loading />;
	if (!data || !schedule.anchor) {
		return (
			<Screen>
				<FormError message={schedule.error ?? copy.api.loadFailed} />
				<Button label={copy.api.retry} onPress={schedule.reload} />
			</Screen>
		);
	}

	const openSaved = (id: string) => {
		for (const entry of openedRef.current?.board ?? []) {
			for (const event of [...entry.events, ...entry.stays]) {
				if (event.id === id) {
					setOpened(event);
					return;
				}
			}
		}
	};

	const refresh = () => {
		schedule.reload();
		tripState.reload();
	};

	return (
		<>
			<Screen
				refreshControl={
					<RefreshControl refreshing={schedule.loading && !!data} onRefresh={refresh} />
				}
			>
				<FormError message={schedule.error ?? ''} />
				<Card style={{ gap: space.md }}>
					<View
						style={{
							flexDirection: 'row',
							alignItems: 'center',
							justifyContent: 'space-between',
							gap: space.sm
						}}
					>
						<Button
							label="‹"
							accessibilityLabel={copy.schedule.nav.previousDay}
							tone="ghost"
							small
							disabled={!data.prevDay}
							onPress={schedule.stepPrev}
						/>
						<View style={{ flex: 1, alignItems: 'center' }}>
							<Text style={type.head}>{dayLabel(data.day)}</Text>
							<Text style={type.faint}>
								{data.prevDay ? '' : copy.schedule.mobile.firstDay}{' '}
								{data.nextDay ? '' : copy.schedule.mobile.lastDay}
							</Text>
						</View>
						<Button
							label="›"
							accessibilityLabel={copy.schedule.nav.nextDay}
							tone="ghost"
							small
							disabled={!data.nextDay}
							onPress={schedule.stepNext}
						/>
					</View>
					<Picker
						label={copy.schedule.nav.jumpToDate}
						options={data.days.map((d) => ({ key: d, label: dayLabel(d) }))}
						value={data.day}
						onPick={schedule.setDay}
					/>
					<Picker
						label={copy.viewAs.label}
						options={schedule.viewAsOptions.map((o) => ({
							key: o.key,
							label: o.warn ? `${o.label} ⚠` : o.label
						}))}
						value={schedule.readAs}
						onPick={schedule.setViewAs}
					/>
					<View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
						{locked ? (
							<Tag label={copy.schedule.lock.tag} tone="lock" />
						) : (
							<>
								<Button
									label={copy.schedule.add}
									small
									onPress={() => setAdding({ day: data.day })}
								/>
								<Button
									label={copy.schedule.addStay}
									small
									tone="ghost"
									onPress={() => setAdding({ day: data.day, type: 'stay' })}
								/>
							</>
						)}
					</View>
				</Card>

				<StayBand stays={schedule.anchor.stays} onOpenEvent={openSaved} />
				<Agenda
					entry={schedule.anchor}
					eventById={schedule.eventById}
					peopleLabel={schedule.peopleLabel}
					memberName={memberName}
					locked={locked}
					onOpenEvent={openSaved}
					onOpenLeg={(leg) => openSaved(leg.toEventId)}
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
						schedule.setPreview(null);
						schedule.reload();
					}}
				/>
			) : null}
		</>
	);
}

function StayBand({
	stays,
	onOpenEvent
}: {
	stays: EventRow[];
	onOpenEvent: (id: string) => void;
}) {
	if (!stays.length) return null;
	return (
		<Card style={{ gap: space.sm }}>
			<Text style={type.head}>{copy.schedule.mobile.stays}</Text>
			{stays.map((stay) => (
				<Pressable
					key={stay.id}
					accessibilityRole="button"
					accessibilityLabel={copy.common.editLabel(stay.title)}
					onPress={() => onOpenEvent(stay.id)}
					style={({ pressed }) => ({ gap: space.xs, opacity: pressed ? 0.75 : 1 })}
				>
					<Text style={type.body}>{stay.title}</Text>
					<Text style={type.faint}>
						{stay.end_day ? rangeLabel(stay.day, stay.end_day) : dayLabel(stay.day)}
					</Text>
				</Pressable>
			))}
		</Card>
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
			<Card>
				<EmptyState message={copy.common.nothingAdded} hint={copy.schedule.mobile.freeDay} />
			</Card>
		);
	}
	return (
		<View style={{ gap: space.md }}>
			{rows.map((row) => (
				<View key={row.key}>{row.node}</View>
			))}
		</View>
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
			<Card style={{ gap: space.sm }}>
				<View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
					<Text style={{ ...type.small, color: color.accent, width: 76 }}>
						{clockRange(event.start_min, event.end_min)}
					</Text>
					<View style={{ flex: 1, gap: space.xs }}>
						<Text style={type.body}>{event.title}</Text>
						<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
							<Tag label={typeLabel(event.type)} />
							{locked ? <Tag label={copy.schedule.lock.tag} tone="lock" /> : null}
							{event.people.length === 0 ? (
								<Tag label={copy.common.everyone} />
							) : (
								event.people.map((id) => (
									<Tag key={id} label={(memberName.get(id) ?? '?').split(' ')[0]} />
								))
							)}
						</View>
						{event.place_text ? <Text style={type.faint}>{event.place_text}</Text> : null}
						{event.notes ? <Text style={type.small}>{event.notes}</Text> : null}
					</View>
				</View>
			</Card>
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
	return (
		<Pressable
			accessibilityRole="button"
			onPress={onPress}
			style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
		>
			<Card style={{ gap: space.sm, borderColor: leg.tight ? color.warn : color.line }}>
				<View style={{ flexDirection: 'row', gap: space.md }}>
					<Text style={{ ...type.small, color: color.accent, width: 76 }}>
						{clockRange(leg.startMin, leg.endMin)}
					</Text>
					<View style={{ flex: 1, gap: space.xs }}>
						<Text style={type.body}>{name}</Text>
						<Text style={type.small}>
							{mode} · {leg.resolvedMins} min · {peopleLabel(leg.people)}
						</Text>
						{leg.tight ? (
							<Text style={{ ...type.small, color: color.warn }}>{copy.viewAs.travelWarning}</Text>
						) : null}
					</View>
				</View>
			</Card>
		</Pressable>
	);
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
