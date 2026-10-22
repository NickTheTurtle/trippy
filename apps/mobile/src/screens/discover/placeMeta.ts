import { localDayMinutes } from '@trippy/core/tz';

/** The stored `hours` column is a JSON array of weekday lines. */
export function parseHours(raw: string | null): string[] | null {
	if (!raw) return null;
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value) ? value.map(String) : null;
	} catch {
		return null;
	}
}

/**
 * Today's opening hours, on the city's own clock (web place-meta.tsx): the
 * weekday is the city's, not the phone's, and an unusable zone gives nothing
 * rather than a plausible wrong row.
 */
export function todayHours(hours: string[] | null | undefined, tz: string): string | null {
	if (!hours || hours.length === 0 || !tz) return null;
	const { day } = localDayMinutes(tz);
	if (!day) return null;
	const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
	if (Number.isNaN(weekday)) return null;
	const idx = (weekday + 6) % 7;
	return (hours[idx] ?? hours[0]).replace(/^[A-Za-z]+:\s*/, '');
}
