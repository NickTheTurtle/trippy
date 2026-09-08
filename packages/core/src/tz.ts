/** Time-zone helpers that run on the client and server (no Node APIs). */

/** Minutes that `tz` is offset from UTC at the given instant (handles DST). */
export function tzOffsetMinutes(tz: string, at: Date = new Date()): number {
	try {
		const dtf = new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
		const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
		const asUtc = Date.UTC(
			Number(p.year),
			Number(p.month) - 1,
			Number(p.day),
			Number(p.hour),
			Number(p.minute),
			Number(p.second)
		);
		return Math.round((asUtc - at.getTime()) / 60000);
	} catch {
		return 0;
	}
}

/** Current local time in `tz`, e.g. "3:04 PM". */
export function localTime(tz: string, at: Date = new Date()): string {
	try {
		return new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			hour: 'numeric',
			minute: '2-digit'
		}).format(at);
	} catch {
		return '';
	}
}

/** Short zone abbreviation, e.g. "GMT+8" or "EDT". */
export function zoneAbbr(tz: string, at: Date = new Date()): string {
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			timeZoneName: 'short',
			hour: 'numeric'
		}).formatToParts(at);
		return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
	} catch {
		return '';
	}
}

/**
 * The calendar day (`YYYY-MM-DD`) and minutes-since-midnight in `tz` at the given
 * instant. Used to draw the "now" line only on the day that is actually current
 * in the destination's zone.
 */
export function localDayMinutes(tz: string, at: Date = new Date()): { day: string; minutes: number } {
	try {
		const p = Object.fromEntries(
			new Intl.DateTimeFormat('en-CA', {
				timeZone: tz,
				hourCycle: 'h23',
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit'
			})
				.formatToParts(at)
				.map((x) => [x.type, x.value])
		);
		return {
			day: `${p.year}-${p.month}-${p.day}`,
			minutes: Number(p.hour) * 60 + Number(p.minute)
		};
	} catch {
		return { day: '', minutes: 0 };
	}
}

/**
 * Human offset of `tz` relative to `homeTz`, e.g. "12h ahead", "3h behind",
 * or "same time". Returns an empty string when the zones match exactly.
 */
export function offsetFromHome(tz: string, homeTz: string, at: Date = new Date()): string {
	if (!homeTz || tz === homeTz) return 'same time';
	const diff = tzOffsetMinutes(tz, at) - tzOffsetMinutes(homeTz, at);
	if (diff === 0) return 'same time';
	const sign = diff > 0 ? 'ahead' : 'behind';
	const mins = Math.abs(diff);
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	const hp = h > 0 ? `${h}h` : '';
	const mp = m > 0 ? `${m}m` : '';
	return `${[hp, mp].filter(Boolean).join(' ')} ${sign}`;
}
