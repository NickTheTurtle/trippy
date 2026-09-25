export function normalizeTimePickerMinutes(
	rawMinutes: number,
	minimum: number,
	maximum: number,
	step: number
): number {
	const snapped = Math.round(rawMinutes / step) * step;
	if (maximum === 24 * 60 && minimum > 0 && snapped < minimum) return 24 * 60;
	return Math.min(maximum, Math.max(minimum, snapped));
}
