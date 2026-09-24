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
 * Bounded and clamped the way the event dialog's Date field is, for the same
 * reason: `min` and `max` colour the platform picker but do not stop a date
 * being typed, and a stay typed past the end of the trip was refused only by
 * the server, after the reader had pressed Save. Checkout may be the morning
 * after the last day, since it is the morning a stay ends, not a night in it.
 * An emptied field is ignored rather than sent: a stay with no dates is not a
 * stay, and '' reached the server as a malformed day.
 */
import { Field } from '../../components/ui/Field';
import { shiftDay } from './shared';

const clamp = (v: string, lo: string, hi: string) => (v < lo ? lo : v > hi ? hi : v);

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
			<Field
				label="Check in"
				className="col-span-6 sm:col-span-4"
				type="date"
				min={firstDay}
				max={lastDay}
				value={checkIn}
				onChange={(e) => {
					const typed = e.target.value;
					if (!typed) return;
					const next = clamp(typed, firstDay, lastDay);
					onCheckIn(next);
					// Dragging the arrival past the departure carries the departure with
					// it rather than refusing: the reader is moving the stay, not
					// shortening it to nothing.
					if (next >= checkOut) onCheckOut(shiftDay(next, 1));
				}}
			/>
			<Field
				label="Check out"
				className="col-span-6 sm:col-span-4"
				type="date"
				min={shiftDay(checkIn, 1)}
				max={lastOut}
				value={checkOut}
				onChange={(e) => {
					const typed = e.target.value;
					if (!typed) return;
					onCheckOut(clamp(typed, shiftDay(checkIn, 1), lastOut));
				}}
			/>
		</>
	);
}
