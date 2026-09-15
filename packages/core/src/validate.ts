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
