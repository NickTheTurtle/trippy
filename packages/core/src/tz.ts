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
 * The instant (epoch ms) of `minutes` past midnight on `day` in `tz`.
 *
 * The schedule stores a wall clock and a calendar day, and takes the zone from
 * the event's city. A trip crosses zones, so two such wall clocks are not
 * comparable to each other: 09:00 in Athens is not 09:00 in London, and on a
 * day with a flight in it the later-looking time can be the earlier instant.
 * Anything that has to put two events in one order therefore has to come
 * through here first.
 *
 * `minutes` is not restricted to a single day: 1440 is midnight at the end of
 * `day`, which is how the board ends a day and how a stay is anchored.
 *
 * The offset is resolved by guessing the instant as if the wall clock were UTC,
 * asking the zone what it was offset by around then, and correcting. That is
 * done twice because the first correction can step over a DST transition and
 * land in the other offset. On the two ambiguous wall clocks a year (the hour
 * that repeats, the hour that does not exist) it settles on one of the two
 * readings rather than throwing: an hour of doubt on one night is not worth
 * failing a whole day's comparison over.
 *
 * An empty or unknown zone is read as UTC, which is what `tzOffsetMinutes`
 * already falls back to, so a day whose events have no city still compares
 * consistently within itself.
 */
export function zonedMinutesToUtc(day: string, minutes: number, tz?: string | null): number {
	const [y, m, d] = day.split('-').map(Number);
	const wall = Date.UTC(y, (m || 1) - 1, d || 1) + minutes * 60000;
	if (!tz) return wall;
	let guess = wall - tzOffsetMinutes(tz, new Date(wall)) * 60000;
	guess = wall - tzOffsetMinutes(tz, new Date(guess)) * 60000;
	return guess;
}

/* --- Calendar days -------------------------------------------------------- */

/*
 * A "day string" is `YYYY-MM-DD` with no zone and no time attached: the unit the
 * whole app dates things in (trip endpoints, schedule days, stay night ranges).
 * It lives here because it is the boundary between zoned instants and plain
 * calendar days, and because every layer needs the same answer to "is this a
 * real date" and "how do I show this range".
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when `value` is a `YYYY-MM-DD` day that actually exists.
 *
 * The regex alone accepts month 13 and the 31st of February, so the parts are
 * round-tripped through `Date.UTC`: anything the calendar silently rolls over
 * into the next month comes back different and is rejected.
 */
export function isDayString(value: string): boolean {
	if (!DAY_RE.test(value)) return false;
	const [y, m, d] = value.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === value;
}

/** A real day string, or null for empty / malformed / impossible input. */
export function normalizeDay(value: string | null | undefined): string | null {
	const s = (value ?? '').trim();
	if (!s) return null;
	return isDayString(s) ? s : null;
}

/** Days from `start` to `end` inclusive, or [] if either end is not a real day. */
export function eachDay(start: string, end: string): string[] {
	if (!isDayString(start) || !isDayString(end) || start > end) return [];
	const out: string[] = [];
	for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86400000) {
		out.push(new Date(t).toISOString().slice(0, 10));
	}
	return out;
}

/**
 * Human label for a day range, e.g. "Apr 16 – 20, 2026" when the month and year
 * match, "Apr 28 – May 3, 2026" across months, "Dec 30, 2026 – Jan 2, 2027"
 * across years. Formatted from UTC parts so it never shifts by the reader's zone.
 *
 * A same-day trip collapses to the single date. Both endpoints being equal is a
 * valid trip, not an error, and "Jan 2 – 2, 2028" reads as a typo, so it renders
 * as the one date.
 *
 * Both endpoints are required. A trip cannot exist without them, so there is no
 * placeholder case to format.
 */
export function formatDayRange(start: string, end: string): string {
	if (start === end) return niceDay(start, true);
	const [sy, sm] = start.split('-');
	const [ey, em] = end.split('-');
	if (sy !== ey) return `${niceDay(start, true)} – ${niceDay(end, true)}`;
	if (sm !== em) return `${niceDay(start, false)} – ${niceDay(end, true)}`;
	return `${niceDay(start, false)} – ${Number(end.slice(8, 10))}, ${ey}`;
}

function niceDay(day: string, withYear: boolean): string {
	const d = new Date(`${day}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return day;
	return d.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		...(withYear ? { year: 'numeric' } : {}),
		timeZone: 'UTC'
	});
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
