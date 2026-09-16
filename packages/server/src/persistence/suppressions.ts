import { db } from '../db';

/**
 * The email suppression list: addresses SES has told us bounce or complain,
 * which `sendMail` checks before it sends.
 *
 * The whole feature exists to protect the owner's `dxu.info` sending identity.
 * AWS watches the bounce and complaint rates of an identity across every app
 * that sends as it, and open sign-up means this app mails an address a stranger
 * typed on every registration. One suspended identity would take down mail for
 * everything on the domain, so a known-bad address must never be mailed twice.
 *
 * Three kinds of bad news, kept distinct, because the right response differs:
 *
 *  - `complaint`   someone pressed "this is spam". Permanent.
 *  - `bounce`      SES classified the failure as permanent. Permanent.
 *  - `soft_bounce` a transient failure (full mailbox, greylisting, an hour of
 *                  downtime). Held for a day, then it lifts by itself.
 *
 * See `applySesNotification` for why each one is treated the way it is.
 */

export type SuppressionReason = 'bounce' | 'soft_bounce' | 'complaint';

export interface Suppression {
	email: string;
	reason: SuppressionReason;
	subtype: string | null;
	created_at: number;
	/** Epoch ms after which this stops blocking, or null for a permanent one. */
	expires_at: number | null;
	/** How many transient failures this address has accumulated. */
	soft_count: number;
	/** Whether it is blocking sends right now. An expired soft hold is not. */
	active: boolean;
}

/**
 * How long a single transient bounce holds an address.
 *
 * Long enough that a mailbox which is full, or a mail server which is down, is
 * not hammered with a retry an hour later (SES counts every one of those in the
 * bounce rate), and short enough that a user who cleared their inbox this
 * morning can ask for a password reset tomorrow and get it.
 */
export const SOFT_HOLD_MS = 24 * 60 * 60 * 1000;

/**
 * How many transient bounces before the address is treated as dead.
 *
 * A mailbox that has been "temporarily" unavailable on five separate occasions
 * is not coming back, and each attempt is still a bounce charged against the
 * identity. Escalating is the cheaper mistake: it is visible in `list()`, an
 * operator can lift it with `unsuppress`, and until then we stop paying for a
 * delivery that has failed five times.
 */
export const SOFT_ESCALATION = 5;

interface Row {
	email: string;
	reason: SuppressionReason;
	subtype: string | null;
	created_at: number;
	expires_at: number | null;
	soft_count: number;
}

function normalize(email: string): string {
	return email.trim().toLowerCase();
}

const SELECT_ROW = `SELECT email, reason, subtype, created_at, expires_at, soft_count
	FROM mail_suppressions`;

function read(email: string): Row | undefined {
	return db.prepare(`${SELECT_ROW} WHERE email = ?`).get(normalize(email)) as Row | undefined;
}

/**
 * Is this address blocked from receiving mail right now?
 *
 * Lowercased first, because that is the form the table is keyed by and the form
 * every account and invite is stored as; a mixed-case address must not slip past
 * a suppression recorded in lower case.
 *
 * An expired soft hold answers false while its row stays in the table. The row
 * is the evidence an operator needs, and the counter escalation depends on; it
 * is only the block that lapses. That distinction is the whole reason a
 * transient failure cannot silently cost someone their account: the worst one
 * soft bounce can do is delay them by a day.
 */
export function isSuppressed(email: string, now = Date.now()): boolean {
	const row = read(email);
	if (!row) return false;
	return row.expires_at === null || row.expires_at > now;
}

/**
 * Record (or refresh) a suppression.
 *
 * Upsert rather than insert: an address can bounce and later complain, or bounce
 * twice, and the latest reason and timestamp are the useful ones to keep. The
 * row is unique per address, so this never grows a duplicate.
 *
 * `expiresAt` of null is a permanent suppression; a timestamp is a hold that
 * lifts by itself. `soft_count` is preserved across an upsert, because it
 * counts a history and a later event is not the start of a new one.
 */
export function suppress(
	email: string,
	reason: SuppressionReason,
	subtype: string | null,
	expiresAt: number | null = null,
	now = Date.now()
): void {
	db.prepare(
		`INSERT INTO mail_suppressions (email, reason, subtype, created_at, expires_at, soft_count)
		 VALUES (?, ?, ?, ?, ?, 0)
		 ON CONFLICT (email) DO UPDATE SET
		   reason     = excluded.reason,
		   subtype    = excluded.subtype,
		   created_at = excluded.created_at,
		   expires_at = excluded.expires_at`
	).run(normalize(email), reason, subtype, now, expiresAt);
}

/**
 * Take an address off the list. Not reached by any SES flow; it exists so an
 * operator (or a test) can undo a suppression, for instance after a mailbox that
 * was full is emptied and the owner asks to be let back in. This is the escape
 * hatch that makes a permanent suppression survivable: nothing about it is
 * irreversible, and `list()` shows the operator exactly why it was applied.
 */
export function unsuppress(email: string): void {
	db.prepare(`DELETE FROM mail_suppressions WHERE email = ?`).run(normalize(email));
}

/**
 * The whole list, newest first, each row flagged with whether it is blocking
 * right now. For an operator view and for tests.
 */
export function list(now = Date.now()): Suppression[] {
	const rows = db.prepare(`${SELECT_ROW} ORDER BY created_at DESC`).all() as unknown as Row[];
	return rows.map((r) => ({ ...r, active: r.expires_at === null || r.expires_at > now }));
}

/** Previous name for `list`, kept so existing callers do not have to change. */
export const listSuppressions = list;

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

/** What one applied notification did, per address. */
export interface SuppressionOutcome {
	email: string;
	reason: SuppressionReason;
	/** null when the suppression is permanent. */
	expires_at: number | null;
}

function recipientAddresses(recipients: SesRecipient[] | undefined): string[] {
	return (recipients ?? [])
		.map((r) => r.emailAddress?.trim().toLowerCase())
		.filter((e): e is string => !!e);
}

/** Bump and read back the soft counter for an address. */
function bumpSoftCount(email: string): number {
	db.prepare(`UPDATE mail_suppressions SET soft_count = soft_count + 1 WHERE email = ?`).run(
		normalize(email)
	);
	return read(email)?.soft_count ?? 0;
}

/**
 * One soft bounce against one address. Returns what the address now looks like.
 *
 * A permanent suppression is never downgraded to a temporary one: once an
 * address has hard bounced or complained, a later transient failure must not
 * hand it back a delivery window. In that case only the counter moves.
 */
function applySoftBounce(email: string, subtype: string | null, now: number): SuppressionOutcome {
	const before = read(email);
	const wasPermanent = !!before && before.expires_at === null;

	if (wasPermanent) {
		bumpSoftCount(email);
		return { email, reason: before.reason, expires_at: null };
	}

	suppress(email, 'soft_bounce', subtype, now + SOFT_HOLD_MS, now);
	const count = bumpSoftCount(email);

	if (count >= SOFT_ESCALATION) {
		// Five transient failures is a dead mailbox wearing a polite face.
		suppress(email, 'bounce', subtype, null, now);
		return { email, reason: 'bounce', expires_at: null };
	}

	return { email, reason: 'soft_bounce', expires_at: now + SOFT_HOLD_MS };
}

/**
 * Apply one parsed SES event to the suppression list, returning what it did
 * (for logging and tests).
 *
 * The crux of the whole feature is *what* suppresses, and for how long:
 *
 *  - A **complaint** suppresses permanently. Someone marked our mail as spam;
 *    sending more is exactly what pushes the identity's complaint rate up, and
 *    AWS suspends at roughly 0.1%. Nothing about the passage of time makes a
 *    complaint less true, so this one never expires on its own.
 *  - A **permanent** bounce suppresses permanently. The address does not exist
 *    or has been shut; it will never deliver, and every retry is another hard
 *    bounce counted against the identity.
 *  - A **transient** bounce suppresses for `SOFT_HOLD_MS` and no longer. A full
 *    mailbox or an hour of downtime at the recipient's provider is temporary,
 *    and permanently blacklisting the address over one would lock a real user
 *    out of their own account forever with no way back in: the reset mail they
 *    need is the mail we would be refusing to send. So the hold is a day, it
 *    lifts by itself, and the row stays visible to an operator either way.
 *    After `SOFT_ESCALATION` of them the address escalates to a permanent
 *    `bounce`, because a mailbox that has failed five times is not a blip and
 *    the retries are not free.
 *  - `Undetermined`, and any bounce type SES adds later, is treated as
 *    transient, for the same reason: we only suppress forever on evidence SES
 *    is sure about.
 *
 * The stored `subtype` is the SES `bounceType` for a bounce, since that is the
 * distinction the decision turns on, and the `complaintFeedbackType` for a
 * complaint when one is given.
 */
export function applySesNotification(event: SesEvent, now = Date.now()): SuppressionOutcome[] {
	const kind = event.eventType ?? event.notificationType;

	if (kind === 'Bounce' && event.bounce) {
		const bounceType = event.bounce.bounceType ?? null;
		const addresses = recipientAddresses(event.bounce.bouncedRecipients);

		if (bounceType === 'Permanent') {
			for (const email of addresses) suppress(email, 'bounce', bounceType, null, now);
			return addresses.map((email) => ({ email, reason: 'bounce' as const, expires_at: null }));
		}

		return addresses.map((email) => applySoftBounce(email, bounceType, now));
	}

	if (kind === 'Complaint' && event.complaint) {
		const subtype = event.complaint.complaintFeedbackType ?? null;
		const addresses = recipientAddresses(event.complaint.complainedRecipients);
		for (const email of addresses) suppress(email, 'complaint', subtype, null, now);
		return addresses.map((email) => ({ email, reason: 'complaint' as const, expires_at: null }));
	}

	// Deliveries, sends, opens and anything else are not our concern here.
	return [];
}
