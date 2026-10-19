/**
 * Check-in and check-out, which is what a stay has instead of a clock.
 *
 * A stay is the one event that is a range of days rather than an hour on one,
 * so both dialogs swap their "When" for this. It is shared rather than written
 * twice because adding a stay and editing one ask the identical question, and
 * the two drifting apart is exactly how the dialogs read as inconsistent.
 *
 * Checkout is held one day past check-in: the shortest real stay is one night.
 *
 * Bounded and clamped the way the event dialog's dates are, for the same
 * reason: `min` and `max` colour the platform picker but do not stop a date
 * being typed, and a stay typed past the end of the trip was refused only by
 * the server, after the reader had pressed Save. The clamp waits until the box
 * is left (see `DayInput`), or no date could be typed at all. Checkout may be the morning
 * after the last day, since it is the morning a stay ends, not a night in it.
 * An emptied field is ignored rather than sent: a stay with no dates is not a
 * stay, and '' reached the server as a malformed day.
 */
import { FieldShell } from '../../components/ui/Field';
import DayInput from '../../components/ui/DayInput';
import { shiftDay } from './shared';

export default function StayDates({
	checkIn,
	checkOut,
	firstDay,
	lastDay,
	onCheckIn,
	onCheckOut
}: {
	checkIn: string;
	checkOut: string;
	/** The first and last day the trip reaches, the same bounds as the Date field. */
	firstDay: string;
	lastDay: string;
	onCheckIn: (v: string) => void;
	onCheckOut: (v: string) => void;
}) {
	const lastOut = shiftDay(lastDay, 1);
	return (
		<>
			<FieldShell label="Check in" className="col-span-6 sm:col-span-4">
				<DayInput
					className="input"
					min={firstDay}
					max={lastDay}
					value={checkIn}
					onDay={(next) => {
						onCheckIn(next);
						// Dragging the arrival past the departure carries the departure with
						// it rather than refusing: the reader is moving the stay, not
						// shortening it to nothing.
						if (next >= checkOut) onCheckOut(shiftDay(next, 1));
					}}
				/>
			</FieldShell>
			<FieldShell label="Check out" className="col-span-6 sm:col-span-4">
				<DayInput
					className="input"
					min={shiftDay(checkIn, 1)}
					max={lastOut}
					value={checkOut}
					onDay={onCheckOut}
				/>
			</FieldShell>
		</>
	);
}
