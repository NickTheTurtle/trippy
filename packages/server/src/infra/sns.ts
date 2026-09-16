import { createVerify, createPublicKey, X509Certificate } from 'node:crypto';

/**
 * Verifying that an SNS message is genuinely from Amazon SNS.
 *
 * The SES bounce and complaint receiver is unauthenticated by necessity: SNS is
 * the caller and it holds no session. That makes signature verification the only
 * thing standing between the endpoint and anyone who finds its URL. Without it,
 * a stranger could POST a forged "complaint" for any address and have us stop
 * mailing that user: a denial-of-service against our own accounts, and a
 * self-inflicted way to lock people out. A shared secret in a query string would
 * not do, because it leaks in logs and proxies and cannot be rotated per
 * message; the real defence is the asymmetric signature AWS already provides.
 *
 * The scheme: every SNS message carries a `Signature`, the URL of the X.509
 * certificate that signed it (`SigningCertURL`), and a `SignatureVersion` that
 * says which hash. We rebuild the exact string AWS signed from a fixed subset of
 * fields in a fixed order, fetch the certificate (only from a real AWS SNS host),
 * and check the signature against its public key.
 */

export interface SnsMessage {
	Type?: string;
	MessageId?: string;
	Token?: string;
	TopicArn?: string;
	Subject?: string;
	Message?: string;
	Timestamp?: string;
	SignatureVersion?: string;
	Signature?: string;
	SigningCertURL?: string;
	SubscribeURL?: string;
	[key: string]: unknown;
}

/**
 * The fields AWS includes in the signed string, per message type, in the order
 * it concatenates them. Each present field contributes `Key\nValue\n`. `Subject`
 * is only present on some notifications and is skipped when absent, which is why
 * the builder tolerates a missing value rather than treating it as empty.
 */
const SIGNABLE_KEYS: Record<string, readonly string[]> = {
	Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
	SubscriptionConfirmation: [
		'Message',
		'MessageId',
		'SubscribeURL',
		'Timestamp',
		'Token',
		'TopicArn',
		'Type'
	],
	UnsubscribeConfirmation: [
		'Message',
		'MessageId',
		'SubscribeURL',
		'Timestamp',
		'Token',
		'TopicArn',
		'Type'
	]
};

/**
 * Is this a certificate URL we are willing to fetch?
 *
 * The check is the second half of the defence: even a valid signature is
 * worthless if the attacker chose which certificate we verify against. It must
 * be HTTPS and its host must be an AWS SNS endpoint (`sns.<region>.amazonaws.com`,
 * or the `.com.cn` variant for the China regions). Anything else, including a
 * look-alike domain or a plain-HTTP URL, is refused before a single byte is
 * fetched, so this can never be turned into a request to an attacker's server.
 */
export function isAllowedSnsCertUrl(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:') return false;
	if (!/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname)) return false;
	// The path is pinned too. Every SNS signing certificate is served as
	// `/SimpleNotificationService-<id>.pem`, so anything else on an SNS host (an
	// API action, a redirect endpoint, a bucket-style path) is not a certificate
	// and we have no business fetching it.
	return /^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/.test(url.pathname);
}

/**
 * Is this URL one we are willing to follow to confirm a subscription?
 *
 * Same host rule as the certificate, without the `.pem` path: a SubscribeURL is
 * an SNS API URL, not a certificate. Kept here next to the host pattern so
 * there is one definition of "really AWS SNS" rather than two that can drift.
 */
export function isAllowedSnsApiUrl(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:') return false;
	return /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname);
}

/** Build the exact string AWS signed, or null for a type we do not verify. */
function canonicalString(message: SnsMessage): string | null {
	const keys = message.Type ? SIGNABLE_KEYS[message.Type] : undefined;
	if (!keys) return null;
	let out = '';
	for (const key of keys) {
		const value = message[key];
		if (value === undefined || value === null) continue;
		out += `${key}\n${String(value)}\n`;
	}
	return out;
}

/** SHA1 for the legacy SignatureVersion 1, SHA256 for 2. Nothing else is accepted. */
function verifyAlgorithm(version: string | undefined): 'RSA-SHA1' | 'RSA-SHA256' | null {
	if (version === '1') return 'RSA-SHA1';
	if (version === '2') return 'RSA-SHA256';
	return null;
}

/**
 * Pull a public key out of what `SigningCertURL` returned.
 *
 * AWS serves a PEM X.509 certificate, so the certificate case is the real one.
 * The fallback to a bare public key exists only so the signature maths can be
 * exercised in a test without minting a self-signed certificate; a genuine SNS
 * certificate always takes the first path.
 */
function publicKeyFromPem(pem: string) {
	try {
		return new X509Certificate(pem).publicKey;
	} catch {
		return createPublicKey(pem);
	}
}

/** Fetch the signing certificate as PEM text. Injectable so tests never hit the network. */
export type CertFetcher = (url: string) => Promise<string>;

const defaultFetchCert: CertFetcher = async (url) => {
	// `redirect: 'error'` is load-bearing. The host allowlist above is checked
	// against the URL in the message, and a 302 from an SNS host to somewhere
	// else would walk straight past it and let the response body (the public key
	// we verify against) be chosen by whoever controlled the redirect. Refusing
	// to follow any redirect keeps the URL we validated and the URL we fetch the
	// same one.
	const res = await fetch(url, { redirect: 'error' });
	if (!res.ok) throw new Error(`cert fetch failed: ${res.status}`);
	return res.text();
};

/**
 * How old a signed message may be and still be acted on.
 *
 * A signature proves who wrote a message, never when. Without a freshness
 * window, one genuine notification captured anywhere on its path (a proxy log,
 * an operator's terminal, a misconfigured mirror) could be replayed at us
 * forever, and each replay would verify perfectly. An hour is comfortably more
 * than SNS's own delivery and retry latency, so a real notification is never
 * refused, and it bounds the window in which a captured one is worth anything.
 */
export const MAX_MESSAGE_AGE_MS = 60 * 60 * 1000;

/**
 * Is the message's own `Timestamp` recent enough to act on?
 *
 * Fails closed: a missing or unparseable timestamp is refused rather than
 * treated as "now". The field is inside the signed string, so an attacker
 * cannot move it without breaking the signature, which is what makes it worth
 * checking at all. Messages dated in the future are refused past a small skew
 * allowance for the same reason a stale one is: a clock that disagrees is not
 * evidence we can reason about.
 */
export function isFreshTimestamp(timestamp: string | undefined, now = Date.now()): boolean {
	if (!timestamp) return false;
	const sent = Date.parse(timestamp);
	if (Number.isNaN(sent)) return false;
	const age = now - sent;
	// A minute of tolerance for clock skew between AWS and this host.
	if (age < -60_000) return false;
	return age <= MAX_MESSAGE_AGE_MS;
}

/**
 * Message ids already acted on, so a replay inside the freshness window is a
 * no-op rather than a second suppression.
 *
 * In memory, like the throttle counters: a restart forgets them, which at worst
 * lets one captured message be applied twice, and applying the same bounce
 * twice is idempotent anyway. The value is stopping a flood of replays of one
 * captured complaint, which a per-process set does perfectly well without
 * turning an unauthenticated endpoint into a write against SQLite.
 */
const seenMessageIds = new Map<string, number>();

/**
 * Record a message id, answering whether it is new. A message with no id is
 * refused: `MessageId` is part of the signed string, so a genuine message
 * always has one.
 */
export function rememberMessageId(messageId: string | undefined, now = Date.now()): boolean {
	if (!messageId) return false;
	// Anything older than the freshness window can never be accepted again, so
	// remembering it is pointless; this keeps the map bounded without an LRU.
	for (const [id, at] of seenMessageIds) {
		if (now - at > MAX_MESSAGE_AGE_MS) seenMessageIds.delete(id);
	}
	if (seenMessageIds.has(messageId)) return false;
	seenMessageIds.set(messageId, now);
	return true;
}

/** Drop the replay memory. For tests, which must not inherit each other's ids. */
export function resetSeenMessageIds(): void {
	seenMessageIds.clear();
}

/**
 * True only when `message` carries a signature that verifies against a genuine
 * AWS SNS certificate and is recent enough to act on. Every failure path, a
 * missing field, a disallowed cert host, an unfetchable certificate, a bad
 * signature, a stale timestamp, an unknown message type, answers false rather
 * than throwing, so a caller can treat the boolean as the whole decision.
 *
 * Replay is deliberately *not* handled here: a caller that only inspects a
 * message should not have its id burned. `rememberMessageId` is the second gate
 * and belongs at the point where a message is acted on.
 */
export async function verifySnsSignature(
	message: SnsMessage,
	fetchCert: CertFetcher = defaultFetchCert,
	now = Date.now()
): Promise<boolean> {
	if (!message.Signature || !message.SigningCertURL) return false;
	if (!isAllowedSnsCertUrl(message.SigningCertURL)) return false;
	// Checked before the certificate is fetched: a stale message is refused
	// without spending a network round trip on it.
	if (!isFreshTimestamp(message.Timestamp, now)) return false;

	const algorithm = verifyAlgorithm(message.SignatureVersion);
	if (!algorithm) return false;

	const canonical = canonicalString(message);
	if (canonical === null) return false;

	let pem: string;
	try {
		pem = await fetchCert(message.SigningCertURL);
	} catch {
		return false;
	}

	try {
		const verifier = createVerify(algorithm);
		verifier.update(canonical, 'utf8');
		verifier.end();
		return verifier.verify(publicKeyFromPem(pem), message.Signature, 'base64');
	} catch {
		return false;
	}
}
