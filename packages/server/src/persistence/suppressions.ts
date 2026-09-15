import { db } from '../db';

/**
 * The email suppression list: addresses SES has told us bounce hard or complain,
 * which `sendMail` checks before it sends.
 *
 * The whole feature exists to protect the owner's `dxu.info` sending identity.
 * AWS watches the bounce and complaint rates of an identity across every app
 * that sends as it, and open sign-up means this app mails an address a stranger
 * typed on every registration. One suspended identity would take down mail for
 * everything on the domain, so a known-bad address must never be mailed twice.
 */

export type SuppressionReason = 'bounce' | 'complaint';

export interface Suppression {
	email: string;
	reason: SuppressionReason;
	subtype: string | null;
	created_at: number;
}

/**
 * Is this address on the list?
 *
 * Lowercased first, because that is the form the table is keyed by and the form
 * every account and invite is stored as; a mixed-case address must not slip past
 * a suppression recorded in lower case.
 */
export function isSuppressed(email: string): boolean {
	const row = db
		.prepare(`SELECT 1 FROM mail_suppressions WHERE email = ?`)
		.get(email.trim().toLowerCase());
	return row !== undefined;
}

/**
 * Record (or refresh) a suppression.
 *
 * Upsert rather than insert: an address can bounce and later complain, or bounce
 * twice, and the latest reason and timestamp are the useful ones to keep. The
 * row is unique per address, so this never grows a duplicate.
 */
export function suppress(email: string, reason: SuppressionReason, subtype: string | null): void {
	db.prepare(
		`INSERT INTO mail_suppressions (email, reason, subtype, created_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (email) DO UPDATE SET
		   reason = excluded.reason,
		   subtype = excluded.subtype,
		   created_at = excluded.created_at`
	).run(email.trim().toLowerCase(), reason, subtype, Date.now());
}

/**
 * Take an address off the list. Not reached by any SES flow; it exists so an
 * operator (or a test) can undo a suppression, for instance after a mailbox that
 * was full is emptied and the owner asks to be let back in.
 */
export function unsuppress(email: string): void {
	db.prepare(`DELETE FROM mail_suppressions WHERE email = ?`).run(email.trim().toLowerCase());
}

/** The whole list, newest first. For an operator view and for tests. */
export function listSuppressions(): Suppression[] {
	return db
		.prepare(
			`SELECT email, reason, subtype, created_at FROM mail_suppressions ORDER BY created_at DESC`
		)
		.all() as unknown as Suppression[];
}

/** The recipient shapes SES uses inside a bounce or complaint payload. */
interface SesRecipient {
	emailAddress?: string;
}

/**
 * The SES event carried inside an SNS notification's `Message` string.
 *
 * SES has published this under two field names over time: the older
 * `notificationType` and the newer event-publishing `eventType`. Both are read
 * so a topic configured either way is handled.
 */
export interface SesEvent {
	notificationType?: string;
	eventType?: string;
	bounce?: {
		bounceType?: string;
		bounceSubType?: string;
		bouncedRecipients?: SesRecipient[];
	};
	complaint?: {
		complainedRecipients?: SesRecipient[];
		complaintFeedbackType?: string;
	};
}

function recipientAddresses(recipients: SesRecipient[] | undefined): string[] {
	return (recipients ?? [])
		.map((r) => r.emailAddress?.trim().toLowerCase())
		.filter((e): e is string => !!e);
}

/**
 * Apply one parsed SES event to the suppression list, returning the addresses it
 * suppressed (for logging and tests).
 *
 * The crux of the whole feature is *what* suppresses:
 *
 *  - A **complaint** always suppresses. Someone marked our mail as spam; sending
 *    more is exactly what pushes the identity's complaint rate up and is the one
 *    thing we must stop doing to that address.
 *  - A **permanent** bounce suppresses. The address does not exist or has been
 *    shut; it will never deliver, and every retry is another hard bounce counted
 *    against the identity.
 *  - A **transient** bounce does NOT suppress. A full mailbox or a momentary
 *    server failure is temporary, and permanently blacklisting the address over
 *    one would lock a real user out of their own account forever. This is the
 *    distinction that matters: transient is loud but recoverable, permanent is
 *    final. `Undetermined` is treated as transient (not suppressed) for the same
 *    reason: we only ever suppress on a bounce SES is sure is permanent.
 *
 * The stored `subtype` is the SES `bounceType` (`Permanent`) for a bounce, since
 * that is the distinction the decision turns on, and the `complaintFeedbackType`
 * for a complaint when one is given.
 */
export function applySesNotification(event: SesEvent): string[] {
	const kind = event.eventType ?? event.notificationType;

	if (kind === 'Bounce' && event.bounce) {
		// Only a bounce SES has classified as permanent reaches the list.
		if (event.bounce.bounceType !== 'Permanent') return [];
		const addresses = recipientAddresses(event.bounce.bouncedRecipients);
		for (const email of addresses) suppress(email, 'bounce', event.bounce.bounceType ?? null);
		return addresses;
	}

	if (kind === 'Complaint' && event.complaint) {
		const addresses = recipientAddresses(event.complaint.complainedRecipients);
		const subtype = event.complaint.complaintFeedbackType ?? null;
		for (const email of addresses) suppress(email, 'complaint', subtype);
		return addresses;
	}

	// Deliveries, sends, opens and anything else are not our concern here.
	return [];
}
