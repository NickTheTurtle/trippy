import { localDay, openingScheduleDay } from '@trippy/core/schedule-day';

const key = (tripId: string) => `trippy.schedule.day.${tripId}`;

export function scheduleOpeningDay(trip: {
	id: string;
	start_date: string | null;
	end_date: string | null;
}): string | null {
	let remembered: string | null = null;
	try {
		remembered = localStorage.getItem(key(trip.id));
	} catch {
		// Private browsing can refuse storage; the trip's dates still choose today.
	}
	return openingScheduleDay({
		remembered,
		today: localDay(),
		start: trip.start_date,
		end: trip.end_date
	});
}

export function rememberScheduleDay(tripId: string, day: string): void {
	try {
		localStorage.setItem(key(tripId), day);
	} catch {
		// Remembering is a convenience, not part of the schedule's state.
	}
}
