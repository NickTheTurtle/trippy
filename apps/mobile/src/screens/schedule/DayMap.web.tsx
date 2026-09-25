import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { InsetSection, ListRow } from '../../ui';
import { color, space, type } from '../../theme';
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
	focusKey: _focusKey,
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
	const hasFocus = focusId != null && pins.length > 0;

	return (
		<InsetSection>
			<ListRow
				title={copy.schedule.map.title}
				value={expanded ? copy.schedule.map.hide : copy.schedule.map.show}
				accessory="none"
				accessibilityState={{ expanded }}
				onPress={() => setExpanded((value) => !value)}
				last={!expanded && !hasFocus}
			/>
			{hasFocus ? (
				<ListRow
					title={copy.schedule.map.backToDay}
					accessory="none"
					onPress={onClearFocus}
					last={!expanded}
				/>
			) : null}
			{expanded ? (
				<View style={{ padding: space.md, gap: space.sm }}>
					<Text style={type.footnote}>{copy.schedule.map.webFallback}</Text>
					{pins.map((pin) => (
						<View key={pin.key} style={{ gap: space.xs }}>
							<Text style={{ ...type.body, color: pin.color }}>{pin.title}</Text>
							{pin.entries.map((entry, index) => (
								<View key={`${entry.title}-${index}`} style={{ gap: space.xs }}>
									<Pressable
										accessibilityRole="button"
										disabled={!entry.eventId}
										onPress={() => entry.eventId && onOpenEvent(entry.eventId)}
									>
										<Text
											style={entry.eventId ? { ...type.small, color: color.accent } : type.small}
										>
											{entry.subtitle ?? entry.title}
										</Text>
									</Pressable>
									{entry.detail.map((line, detailIndex) => (
										<Text key={`${line}-${detailIndex}`} style={type.faint}>
											{line}
										</Text>
									))}
								</View>
							))}
							{pin.addId && savedById.has(pin.addId) ? (
								<Pressable
									accessibilityRole="button"
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
		</InsetSection>
	);
}
