import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import MapView, {
	Callout,
	CalloutSubview,
	Marker,
	Polyline,
	type MapMarker
} from 'react-native-maps';
import { copy } from '@trippy/copy';
import { Button, Card } from '../../ui';
import { color, radius, space, type } from '../../theme';
import { buildScheduleMapModel, type MobileMapPin } from './mapModel';
import type { BoardDay, Cell, EventRow, SavedPoi } from './types';

export function DayMap({
	entry,
	saved,
	city,
	memberIds,
	peopleLabel,
	locked,
	focusId,
	focusKey,
	onOpenEvent,
	onAddPlace,
	onClearFocus
}: {
	entry: BoardDay;
	saved: SavedPoi[];
	city: Cell | null;
	memberIds: string[];
	peopleLabel: (ids: string[]) => string;
	locked: boolean;
	focusId: string | null;
	focusKey: number;
	onOpenEvent: (id: string) => void;
	onAddPlace: (poi: SavedPoi) => void;
	onClearFocus: () => void;
}) {
	const [expanded, setExpanded] = useState(true);
	const markerRefs = useRef<Record<string, MapMarker | null>>({});
	const model = useMemo(
		() =>
			buildScheduleMapModel({
				events: entry.events,
				stays: entry.stays,
				legs: entry.legs,
				saved,
				city,
				memberIds,
				peopleLabel,
				locked
			}),
		[entry, saved, city, memberIds, peopleLabel, locked]
	);
	const savedById = useMemo(() => new Map(saved.map((place) => [place.id, place])), [saved]);
	const focusPin = focusId
		? model.pins.find((pin) => pin.eventIds.includes(focusId) || pin.addId === focusId)
		: null;

	useEffect(() => {
		if (!focusPin) return;
		const timer = setTimeout(() => markerRefs.current[focusPin.key]?.showCallout(), 150);
		return () => clearTimeout(timer);
	}, [focusPin?.key, focusKey]);

	return (
		<Card style={{ gap: space.sm }}>
			<View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
				<Text style={type.head}>{copy.schedule.map.title}</Text>
				<View style={{ flexDirection: 'row', gap: space.sm }}>
					{focusPin ? (
						<Button label={copy.schedule.map.backToDay} small tone="ghost" onPress={onClearFocus} />
					) : null}
					<Button
						label={expanded ? copy.schedule.map.hide : copy.schedule.map.show}
						small
						tone="ghost"
						accessibilityLabel={expanded ? copy.schedule.map.hide : copy.schedule.map.show}
						accessibilityState={{ expanded }}
						onPress={() => setExpanded((value) => !value)}
					/>
				</View>
			</View>
			{expanded ? (
				<MapView
					style={{ height: 260, borderRadius: radius.md, overflow: 'hidden' }}
					initialRegion={model.region}
					region={focusPin ? focusRegion(focusPin) : model.region}
					showsUserLocation={false}
				>
					{model.routes.map((route) => (
						<Polyline
							key={route.key}
							coordinates={route.points}
							strokeColor={route.color}
							strokeWidth={3}
							lineDashPattern={Platform.OS === 'ios' ? [6, 6] : undefined}
						/>
					))}
					{model.pins.map((pin) => (
						<Marker
							// Colour, number and count are in the key because Android does
							// not redraw a custom marker with tracksViewChanges off, so a
							// changed pin must be a new marker to be drawn again.
							key={`${pin.key}:${pin.color}:${pin.number ?? ''}:${pin.count}`}
							ref={(ref) => {
								markerRefs.current[pin.key] = ref;
							}}
							coordinate={{ latitude: pin.lat, longitude: pin.lng }}
							pinColor={pin.color}
							title={pin.title}
							tracksViewChanges={false}
						>
							<Pin pin={pin} />
							<Callout
								tooltip
								onPress={(e) => {
									// iOS fires a button's own press inside the callout and then
									// this one, marked callout-inside-press. The button already
									// did its job; acting again opened the pin's first event over
									// the one the button chose.
									// The declared type says only callout-press; iOS also sends
									// callout-inside-press (AIRMapMarker.m) for a subview tap.
									if ((e.nativeEvent.action as string) === 'callout-inside-press') return;
									if (pin.addId && pin.eventIds.length === 0) {
										const place = savedById.get(pin.addId);
										if (place) onAddPlace(place);
									} else if (pin.eventIds[0]) onOpenEvent(pin.eventIds[0]);
								}}
							>
								<View
									style={{
										backgroundColor: color.surface,
										borderRadius: radius.md,
										borderWidth: 1,
										borderColor: color.line,
										padding: space.md,
										maxWidth: 260,
										gap: space.xs
									}}
								>
									{pin.entries.map((entry, index) => (
										<View key={`${entry.title}-${index}`} style={{ gap: space.xs }}>
											<Text style={type.body}>{entry.title}</Text>
											{entry.subtitle ? <Text style={type.small}>{entry.subtitle}</Text> : null}
											{entry.detail.map((line, detailIndex) => (
												<Text key={`${line}-${detailIndex}`} style={type.faint}>
													{line}
												</Text>
											))}
											{entry.warn ? (
												<Text style={{ ...type.small, color: color.warn }}>{entry.warn}</Text>
											) : null}
											{entry.eventId ? (
												<ActionText onPress={() => onOpenEvent(entry.eventId!)}>
													{copy.schedule.block.openLabel}
												</ActionText>
											) : null}
											{entry.addId && savedById.has(entry.addId) ? (
												<ActionText
													onPress={() => {
														const place = savedById.get(entry.addId!);
														if (place) onAddPlace(place);
													}}
												>
													{copy.ui.mapCard.add}
												</ActionText>
											) : null}
										</View>
									))}
								</View>
							</Callout>
						</Marker>
					))}
				</MapView>
			) : null}
		</Card>
	);
}

function Pin({ pin }: { pin: MobileMapPin }) {
	return (
		<View style={{ alignItems: 'center' }}>
			<View
				style={{
					minWidth: 26,
					height: 26,
					borderRadius: 13,
					backgroundColor: pin.color,
					borderWidth: 2,
					borderColor: '#fff',
					alignItems: 'center',
					justifyContent: 'center',
					paddingHorizontal: 4
				}}
			>
				<Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>
					{pin.count > 1 ? '' : (pin.number ?? '')}
				</Text>
			</View>
			<View
				style={{
					width: 0,
					height: 0,
					borderLeftWidth: 5,
					borderRightWidth: 5,
					borderTopWidth: 8,
					borderLeftColor: 'transparent',
					borderRightColor: 'transparent',
					borderTopColor: pin.color,
					marginTop: -2
				}}
			/>
		</View>
	);
}

function ActionText({ children, onPress }: { children: string; onPress: () => void }) {
	const body = (
		<Text style={{ ...type.small, color: color.accent, fontWeight: '700' }}>{children}</Text>
	);
	if (Platform.OS === 'ios') {
		return <CalloutSubview onPress={onPress}>{body}</CalloutSubview>;
	}
	return <Pressable onPress={onPress}>{body}</Pressable>;
}

function focusRegion(pin: MobileMapPin) {
	return { latitude: pin.lat, longitude: pin.lng, latitudeDelta: 0.015, longitudeDelta: 0.015 };
}
