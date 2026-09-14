/**
 * Check-in and check-out, which is what a stay has instead of a clock.
 *
 * A stay is the one event that is a range of days rather than an hour on one,
 * so both dialogs swap their "When" for this. It is shared rather than written
 * twice because adding a stay and editing one ask the identical question, and
 * the two drifting apart is exactly how the dialogs read as inconsistent.
 *
 * Checkout is held one day past check-in: the shortest real stay is one night.
 */
import { Field } from '../../components/ui/Field';
import { shiftDay } from './shared';

export default function StayDates({
	checkIn,
	checkOut,
	onCheckIn,
	onCheckOut
}: {
	checkIn: string;
	checkOut: string;
	onCheckIn: (v: string) => void;
	onCheckOut: (v: string) => void;
}) {
	return (
		<>
			<Field
				label="Check in"
				className="col-span-4"
				type="date"
				value={checkIn}
				onChange={(e) => {
					const next = e.target.value;
					onCheckIn(next);
					// Dragging the arrival past the departure carries the departure with
					// it rather than refusing: the reader is moving the stay, not
					// shortening it to nothing.
					if (next && next >= checkOut) onCheckOut(shiftDay(next, 1));
				}}
			/>
			<Field
				label="Check out"
				className="col-span-4"
				type="date"
				min={checkIn ? shiftDay(checkIn, 1) : undefined}
				value={checkOut}
				onChange={(e) => onCheckOut(e.target.value)}
			/>
		</>
	);
}
