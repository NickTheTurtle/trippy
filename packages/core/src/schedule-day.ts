/**
 * The day a schedule opens on when its address does not name one.
 *
 * The first visit belongs on today while the trip is happening. After that the
 * reader is in the middle of something, so returning to the schedule puts them
 * back on the day they left, as long as the trip still has that day.
 */

export function isIsoDay(value: string | null | undefined): value is string {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	);
}

/** Today on the device's own calendar, not UTC's. */
export function localDay(at: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function openingScheduleDay({
	remembered,
	today,
	start,
	end
}: {
	remembered: string | null;
	today: string;
	start: string | null;
	end: string | null;
}): string | null {
	if (!isIsoDay(start) || !isIsoDay(end) || start > end) return null;
	const inTrip = (day: string | null) => isIsoDay(day) && day >= start && day <= end;
	if (inTrip(remembered)) return remembered;
	return inTrip(today) ? today : null;
}
