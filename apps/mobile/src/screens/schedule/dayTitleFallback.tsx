import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { copy } from '@trippy/copy';
import { InsetSection } from '../../ui';
import { DateField } from '../../ui/controls';
import { Sheet } from '../../ui/Sheet';
import { AppSymbol } from '../../ui/Symbol';
import { color, displayType } from '../../theme';
import { dayLabel } from './shared';

export type DayTitleProps = {
	day: string;
	/** The days the trip has; only these can be picked. */
	days: string[];
	firstDay: string;
	lastDay: string;
	onPick: (day: string) => void;
};

/**
 * The day's date, which is also how you jump to another day: pressing it opens
 * a calendar of the trip. The arrows either side still step a day at a time.
 *
 * On iOS the calendar is the system date picker in a popover (DayTitle.ios.tsx).
 * This is the version for Android and web, and for an iOS client without the
 * native UI module: the same title, opening a sheet with the date field.
 */
export function DayTitleFallback({ day, days, firstDay, lastDay, onPick }: DayTitleProps) {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState(day);
	useEffect(() => {
		if (open) setDraft(day);
	}, [open, day]);
	return (
		<>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={`${copy.schedule.nav.jumpToDate}, ${dayLabel(day)}`}
				onPress={() => setOpen(true)}
				hitSlop={8}
				style={({ pressed }) => ({
					flexDirection: 'row',
					alignItems: 'center',
					gap: 6,
					opacity: pressed ? 0.6 : 1
				})}
			>
				<Text style={displayType.title2}>{dayLabel(day)}</Text>
				<AppSymbol name="chevron.down" fallback="chevron-down" size={13} color={color.accent} />
			</Pressable>
			<Sheet
				open={open}
				title={copy.schedule.nav.jumpToDate}
				onClose={() => setOpen(false)}
				onPrimary={() => {
					onPick(draft);
					setOpen(false);
				}}
				primaryLabel={copy.common.save}
				// Only a day the trip offers can be jumped to, and Save says so by
				// being unavailable rather than by closing without a word.
				primaryDisabled={!days.includes(draft)}
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
		</>
	);
}
