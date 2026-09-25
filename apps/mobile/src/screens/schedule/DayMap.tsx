import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import MapView, { Callout, Marker, Polyline, type MapMarker } from 'react-native-maps';
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
	}, [focusPin?.key]);

	return (
		<Card style={{ gap: space.sm }}>
			<View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
				<Text style={type.head}>Map</Text>
				<View style={{ flexDirection: 'row', gap: space.sm }}>
					{focusId ? (
						<Button label="Back to day" small tone="ghost" onPress={onClearFocus} />
					) : null}
					<Button
						label={expanded ? 'Hide' : 'Show'}
						small
						tone="ghost"
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
							key={pin.key}
							ref={(ref) => {
								markerRefs.current[pin.key] = ref;
							}}
							coordinate={{ latitude: pin.lat, longitude: pin.lng }}
							pinColor={pin.color}
							title={pin.title}
						>
							<Pin pin={pin} />
							<Callout tooltip onPress={() => pin.eventIds[0] && onOpenEvent(pin.eventIds[0])}>
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
									<Text style={type.body}>{pin.title}</Text>
									{pin.subtitle ? <Text style={type.small}>{pin.subtitle}</Text> : null}
									{pin.detail.map((line, index) => (
										<Text key={`${line}-${index}`} style={type.faint}>
											{line}
										</Text>
									))}
									{pin.warn ? (
										<Text style={{ ...type.small, color: color.warn }}>{pin.warn}</Text>
									) : null}
									{pin.eventIds[0] ? (
										<Text style={{ ...type.small, color: color.accent }}>
											{copy.schedule.block.openLabel}
										</Text>
									) : null}
									{pin.addId && savedById.has(pin.addId) ? (
										<Pressable
											onPress={() => {
												const place = savedById.get(pin.addId!);
												if (place) onAddPlace(place);
											}}
										>
											<Text style={{ ...type.small, color: color.accent, fontWeight: '700' }}>
												{copy.ui.mapCard.add}
											</Text>
										</Pressable>
									) : null}
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
					{pin.count > 1 ? pin.count : (pin.number ?? '')}
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

function focusRegion(pin: MobileMapPin) {
	return { latitude: pin.lat, longitude: pin.lng, latitudeDelta: 0.015, longitudeDelta: 0.015 };
}
