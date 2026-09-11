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
