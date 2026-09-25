import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { Button, Card } from '../../ui';
import { color, radius, space, type } from '../../theme';
import { buildScheduleMapModel } from './mapModel';
import type { BoardDay, Cell, SavedPoi } from './types';

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
	const savedById = useMemo(() => new Map(saved.map((place) => [place.id, place])), [saved]);
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
	const pins = focusId
		? model.pins.filter((pin) => pin.eventIds.includes(focusId) || pin.addId === focusId)
		: model.pins;

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
				<View
					style={{
						borderWidth: 1,
						borderColor: color.line,
						borderRadius: radius.md,
						padding: space.md,
						gap: space.sm,
						backgroundColor: color.surface2
					}}
				>
					<Text style={type.faint}>
						Map preview is available in Expo Go. Pins are listed here for web preview.
					</Text>
					{pins.map((pin) => (
						<View key={pin.key} style={{ gap: space.xs }}>
							<Pressable
								disabled={!pin.eventIds[0]}
								onPress={() => pin.eventIds[0] && onOpenEvent(pin.eventIds[0])}
							>
								<Text style={{ ...type.body, color: pin.color }}>{pin.title}</Text>
								{pin.subtitle ? <Text style={type.small}>{pin.subtitle}</Text> : null}
							</Pressable>
							{pin.detail.map((line, index) => (
								<Text key={`${line}-${index}`} style={type.faint}>
									{line}
								</Text>
							))}
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
					))}
				</View>
			) : null}
		</Card>
	);
}
