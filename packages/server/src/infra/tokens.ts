import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Single-use tokens that arrive by email: the verification link that mints an
 * account, and the reset link that takes one over.
 *
 * The database stores only a SHA-256 of the token, never the token itself. A
 * session id is kept in the clear because it is already a bearer credential the
 * holder has; these are different, because a leaked table would otherwise hand
 * an attacker the ability to create accounts at addresses they do not own and
 * to seize accounts they do not own. Hashing costs one call per lookup and
 * removes that entirely.
 *
 * No salt and no scrypt here, deliberately. These are 256 bits of `randomBytes`
 * rather than a human-chosen password, so there is no dictionary to guard
 * against and a fast hash gives up nothing.
 */

/** 32 bytes, base64url so it survives a URL without escaping. */
export function mintToken(): string {
	return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compare two token hashes without letting the clock say how much of the hash
 * matched. Only useful where the lookup is not by primary key; kept here so the
 * one safe comparison is the obvious one to reach for.
 */
export function tokenHashEquals(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8');
	const right = Buffer.from(b, 'utf8');
	return left.length === right.length && timingSafeEqual(left, right);
}

/** How long an emailed link stays usable. */
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Deliberately shorter than the verification link. A reset link is a live
 * takeover of an account that already exists, so an old mailbox left open on a
 * shared machine is a much worse thing to leave lying around than an unclaimed
 * sign-up.
 */
export const RESET_TTL_MS = 60 * 60 * 1000;
