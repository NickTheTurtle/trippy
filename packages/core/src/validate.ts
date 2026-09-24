/**
 * Field-shape checks shared by every client and the API.
 *
 * These live in core rather than beside the code that uses them because a rule
 * enforced in one place and not another is worse than no rule: an email shape
 * used to be checked three different ways (a regex on the profile form, a bare
 * `includes('@')` on an invite, and nothing at all on registration), so `nope`
 * was a valid address to sign up with but not to be invited at.
 */

/**
 * Deliberately loose: local@domain.tld with no spaces. A stricter pattern
 * rejects addresses that genuinely deliver, and the only real proof an address
 * exists is mail arriving at it. This catches the typo, not the forgery.
 */
export function isValidEmail(email: string): boolean {
	return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim().toLowerCase());
}

/**
 * The largest money value any field accepts, in minor units: a hundred billion
 * major units.
 *
 * There has to be a ceiling somewhere, and the reason is not tidiness. An
 * expense stored above `Number.MAX_SAFE_INTEGER` cents took the whole Expenses
 * page down for every member of the trip at once, permanently: SQLite holds a
 * 64-bit integer happily, but `node:sqlite` throws `RangeError` reading it back,
 * so every later read of that trip's ledger threw and there was no route left in
 * the UI to delete the offending row. The page could not load, so the row could
 * not be removed from it.
 *
 * The bound sits far below that limit rather than just beneath it. Cents are
 * exact up to the safe-integer limit, but the display divides by 100 into a
 * double, and that loses the cent somewhere above 70 trillion major units: an
 * amount could be stored exactly and still render as a different number. A
 * hundred billion keeps both the arithmetic and the rendering exact, and still
 * clears the largest real trip by many orders of magnitude even in the
 * lowest-denomination currency in the list.
 */
export const MAX_AMOUNT_CENTS = 1e13;

/**
 * Whether a minor-unit amount is finite and within the bound. Sign is allowed:
 * a negative expense is income, which is a real thing to record.
 */
export function isAmountInRange(cents: number): boolean {
	return Number.isFinite(cents) && Math.abs(cents) <= MAX_AMOUNT_CENTS;
}

/** What a rejected amount says. Shared so the wording cannot drift by field. */
export function amountTooLarge(): string {
	return 'That amount is too large. Enter a smaller one.';
}

/**
 * How long a name, title or label may be.
 *
 * Titles are drawn in cards, chips and calendar blocks, all of which are sized
 * by their column rather than their contents. Five thousand characters in one
 * of them is not a long name, it is a layout attack: the clamp that keeps a
 * title to three rows can only count rows once the text can wrap, so a single
 * unbroken run sets the element's minimum width and drags the page out with it.
 * The stylesheets now break anywhere, which stops the damage; this stops the
 * input, because a name nobody can read is not worth storing either.
 */
export const MAX_NAME_LENGTH = 200;

/** How long a free-text note may be. Generous: notes are meant to be prose. */
export const MAX_NOTES_LENGTH = 4000;

/**
 * Whether a note is short enough to store. Blank is not this check's business.
 *
 * Unlike a name, a note cannot wreck a layout: it is prose in a body area
 * rather than a title drawn in a column-sized card, and the stylesheets already
 * break anywhere. The limit is here because a row with no ceiling is still a
 * row with no ceiling, and four thousand characters is past the point where
 * anyone is writing a note rather than pasting something.
 */
export function isNotesLength(text: string): boolean {
	return text.length <= MAX_NOTES_LENGTH;
}

/** What an over-long note is told, with the limit quoted. */
export function notesTooLong(): string {
	return `Keep notes under ${MAX_NOTES_LENGTH} characters.`;
}

/** Whether a name or title is short enough to store. Blank is not this check's business. */
export function isNameLength(text: string): boolean {
	return text.length <= MAX_NAME_LENGTH;
}

/** What an over-long name is told, with the limit quoted. */
export function nameTooLong(): string {
	return `Keep it under ${MAX_NAME_LENGTH} characters.`;
}

/**
 * A link safe to render as an `href`, or null.
 *
 * Only http and https survive. The field is free text and went straight into an
 * `href`, so `javascript:alert(1)` was stored and rendered as a link; React
 * happens to neutralise that scheme at navigation time, which makes it a
 * near-miss rather than a hole, and leaning on a framework's behaviour for that
 * is not a control. A bare `banana` was the same bug with a duller edge: it
 * resolved against the app's own origin and became a dead internal link, so it
 * is treated as a host and given a scheme rather than rejected.
 */
export function safeExternalUrl(raw: string): string | null {
	const text = raw.trim();
	if (!text) return null;
	// Control characters are how a blocked scheme gets smuggled past a naive
	// check: `java\nscript:` is not a scheme until something strips the newline.
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f\s]/.test(text)) return null;

	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
	// No scheme at all reads as a host: "example.com/thing" is what people type.
	if (!scheme) return isHost(text) ? `https://${text}` : null;

	const protocol = scheme[1].toLowerCase();
	if (protocol !== 'http' && protocol !== 'https') return null;

	const rest = text.slice(scheme[0].length).replace(/^\/\//, '');
	return isHost(rest) ? text : null;
}

/**
 * Whether what follows the scheme starts with something host-shaped. A dot is
 * required, which is what separates a real destination from `banana`: that
 * resolved against the app's own origin and became a dead internal link.
 */
function isHost(rest: string): boolean {
	const host = rest.split(/[/?#]/, 1)[0];
	return /^[^.]+(\.[^.]+)+$/.test(host) && !host.endsWith('.');
}

/**
 * Whether a string names a time zone this runtime can actually render.
 *
 * The old test was a regex, `Area/Location`, which refused `UTC` (the zone every
 * account starts on) and accepted `Mars/Olympus_Mons`, which then threw a
 * `RangeError` out of every `Intl.DateTimeFormat` that read it, on every page
 * that drew a clock for that city or that person. Asking `Intl` is the only
 * test that agrees with what the zone will be used for, and it is available in
 * every browser, in Node and in Hermes, so this stays pure.
 *
 * Fixed-offset strings such as `+05:30` are refused even where a newer runtime
 * accepts them: the column holds an IANA name, and an offset is not a place, so
 * it would stop tracking daylight saving the day it was stored.
 */
export function isIanaZone(tz: string): boolean {
	if (typeof tz !== 'string') return false;
	const zone = tz.trim();
	if (!zone || zone.length > 64 || /^[+-]/.test(zone) || /^\d/.test(zone)) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

/**
 * The largest share any one participant may be given in a `shares` split.
 *
 * A share is a count ("a couple counts as 2"), so a million is far past any
 * real use. The ceiling exists because the weights are summed and multiplied
 * by the total: `1e308` twice is `Infinity`, and a ledger built on that is
 * `NaN` for every member of the trip.
 */
export const MAX_SHARE_WEIGHT = 1e6;

/** Whether a share weight is finite, not negative, and within the ceiling. */
export function isShareWeight(weight: number): boolean {
	return Number.isFinite(weight) && weight >= 0 && weight <= MAX_SHARE_WEIGHT;
}

/** What an out-of-range share is told. */
export function shareTooLarge(): string {
	return `Keep each share under ${MAX_SHARE_WEIGHT.toLocaleString('en-US')}.`;
}

/**
 * The window a calendar day typed by a person has to fall in.
 *
 * `1200-01-01` and `3000-01-01` are real days, and a date picker fed a
 * two-digit year produces them. They are never a day a group trip meant. This
 * used to be two constants inside the expenses route, so an expense was held to
 * it and the trip it belonged to was not: a trip could run in the year 1200 and
 * every one of its expenses would then be refused for being outside a window the
 * trip itself had ignored.
 */
export const DAY_MIN = '2000-01-01';
export const DAY_MAX = '2100-12-31';

/** Whether a `YYYY-MM-DD` day sits inside the accepted window. */
export function isDayInWindow(day: string): boolean {
	return day >= DAY_MIN && day <= DAY_MAX;
}

/** What a day outside the window is told. */
export function dayOutOfWindow(): string {
	return `Pick a date between ${DAY_MIN.slice(0, 4)} and ${DAY_MAX.slice(0, 4)}.`;
}

/** The day after a `YYYY-MM-DD` day. Pure calendar arithmetic, no zone involved. */
function nextDay(day: string): string {
	const [y, m, d] = day.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Whether a day falls outside a trip's own dates.
 *
 * A trip missing either endpoint, or holding them inverted, cannot bound
 * anything, so it bounds nothing: refusing on a guess would block every write
 * to a trip whose dates are merely unusual. The schedule and the stay routes
 * each carried a copy of this; there is one now.
 */
export function isOutsideTrip(
	day: string,
	first: string | null | undefined,
	last: string | null | undefined
): boolean {
	if (!first || !last || first > last) return false;
	return day < first || day > last;
}

/**
 * What is wrong with a stay's night range, or null when nothing is.
 *
 *  - `order`   the checkout is on or before the check-in: zero or negative nights.
 *  - `outside` a night falls outside the trip.
 *
 * A night is the day it starts on, so a stay covers `[checkIn, checkOut)`. The
 * check-in must be a trip day and so must the last night, which is the day
 * before checkout. That lets a stay begin on the trip's last day and check out
 * the morning after, which is what the schedule has always allowed. The
 * Discover path used to cap checkout at the last day instead, which made a
 * check-in on the last day impossible there (no checkout could then pass both
 * rules) while the board accepted the same stay. One rule now, in one place.
 *
 * Either end may be blank: a half-filled range is undated, not invalid, and
 * each end present is still judged on its own.
 */
export function stayNightsProblem(
	checkIn: string | null | undefined,
	checkOut: string | null | undefined,
	first?: string | null,
	last?: string | null
): 'order' | 'outside' | null {
	if (checkIn && checkOut && checkOut <= checkIn) return 'order';
	if (checkIn && isOutsideTrip(checkIn, first, last)) return 'outside';
	if (checkOut && first && last && first <= last) {
		if (checkOut <= first || checkOut > nextDay(last)) return 'outside';
	}
	return null;
}
