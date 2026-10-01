import { useState } from 'react';
import { copy } from '@trippy/copy';
import { color } from '../../theme';
import { hasSwiftUI, serifPostScript } from '../../ui/swiftUI';
import { DayTitleFallback, type DayTitleProps } from './dayTitleFallback';
import { dayLabel } from './shared';

export type { DayTitleProps } from './dayTitleFallback';

/**
 * The iOS day title: pressing the date opens the system calendar in a popover
 * anchored to it, spanning the trip's dates, as Calendar and Reminders offer a
 * date. A date the trip has no day for (a stranded event on a shortened trip
 * can leave a gap) is refused and the picker goes back to the current day. Picking a day jumps there and closes it; the month arrows inside only
 * page the calendar. See dayTitleFallback.tsx for why the title is the control.
 */
export function DayTitle(props: DayTitleProps) {
	if (!hasSwiftUI) return <DayTitleFallback {...props} />;
	return <NativeDayTitle {...props} />;
}

function NativeDayTitle({ day, days, firstDay, lastDay, onPick }: DayTitleProps) {
	const [open, setOpen] = useState(false);
	// Remounts the picker after a refused day, so it shows the current day
	// again rather than keeping the refused one highlighted.
	const [pickerKey, setPickerKey] = useState(0);
	// Required here, not imported: see hasSwiftUI.
	const ui = require('@expo/ui/swift-ui') as typeof import('@expo/ui/swift-ui');
	const m = require('@expo/ui/swift-ui/modifiers') as typeof import('@expo/ui/swift-ui/modifiers');
	const { Host, Popover, Button, HStack, Text, Image, DatePicker } = ui;
	const label = dayLabel(day);

	return (
		// Width from the row between the arrows, height from SwiftUI, so a large
		// text size truncates the date rather than running under the arrows.
		<Host matchContents={{ vertical: true }} style={{ alignSelf: 'stretch' }}>
			<Popover isPresented={open} onIsPresentedChange={setOpen} arrowEdge="top">
				<Popover.Trigger>
					<Button
						onPress={() => setOpen(true)}
						modifiers={[
							m.buttonStyle('plain'),
							m.accessibilityLabel(`${copy.schedule.nav.jumpToDate}, ${label}`)
						]}
					>
						<HStack spacing={6} alignment="center">
							<Text
								modifiers={[
									m.font({ family: serifPostScript, size: 24, textStyle: 'title2' }),
									m.foregroundStyle(color.ink),
									m.lineLimit(1)
								]}
							>
								{label}
							</Text>
							<Image systemName="chevron.down" size={13} color={color.accent} />
						</HStack>
					</Button>
				</Popover.Trigger>
				<Popover.Content>
					<DatePicker
						key={pickerKey}
						selection={atNoon(day)}
						range={{ start: atStart(firstDay), end: atEnd(lastDay) }}
						displayedComponents={['date']}
						onDateChange={(date) => {
							const picked = toDay(date);
							if (!days.includes(picked)) {
								setPickerKey((k) => k + 1);
								return;
							}
							onPick(picked);
							setOpen(false);
						}}
						modifiers={[
							m.datePickerStyle('graphical'),
							m.tint(color.accent),
							m.frame({ width: 320 }),
							m.padding({ all: 12 })
						]}
					/>
				</Popover.Content>
			</Popover>
		</Host>
	);
}

// Trip days are calendar dates with no zone, so they are read and written in
// the phone's own zone; noon keeps a selection clear of any midnight shift.
function parts(day: string): [number, number, number] {
	const [y, mo, d] = day.split('-').map(Number);
	return [y, mo - 1, d];
}
function atNoon(day: string): Date {
	const [y, mo, d] = parts(day);
	return new Date(y, mo, d, 12);
}
function atStart(day: string): Date {
	const [y, mo, d] = parts(day);
	return new Date(y, mo, d, 0, 0, 0);
}
function atEnd(day: string): Date {
	const [y, mo, d] = parts(day);
	return new Date(y, mo, d, 23, 59, 59);
}
function toDay(date: Date): string {
	const mm = String(date.getMonth() + 1).padStart(2, '0');
	const dd = String(date.getDate()).padStart(2, '0');
	return `${date.getFullYear()}-${mm}-${dd}`;
}
