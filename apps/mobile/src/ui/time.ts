/**
 * A native time picker's answer, as minutes on the board's day.
 *
 * The picker returns a wall-clock time, so the end of the day comes back as
 * 0 (12:00 AM), not 1440. When the field can reach midnight (its maximum is
 * the end of the day) and 0 is below its minimum, 0 is that midnight. Every
 * other value is snapped to the step and held to the bounds, so an end picked
 * before the start clamps up to the earliest allowed end, as it always has,
 * rather than jumping to midnight.
 */
export function normalizeTimePickerMinutes(
	rawMinutes: number,
	minimum: number,
	maximum: number,
	step: number
): number {
	const dayEnd = 24 * 60;
	const snapped = Math.round(rawMinutes / step) * step;
	// Checked after snapping: Android's picker ignores the step, so 12:01 AM
	// arrives as 1 and has to count as midnight too.
	if (snapped === 0 && maximum === dayEnd && minimum > 0) return dayEnd;
	return Math.min(maximum, Math.max(minimum, snapped));
}
