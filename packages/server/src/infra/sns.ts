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
	const res = await fetch(url);
	if (!res.ok) throw new Error(`cert fetch failed: ${res.status}`);
	return res.text();
};

/**
 * True only when `message` carries a signature that verifies against a genuine
 * AWS SNS certificate. Every failure path, a missing field, a disallowed cert
 * host, an unfetchable certificate, a bad signature, an unknown message type,
 * answers false rather than throwing, so a caller can treat the boolean as the
 * whole decision.
 */
export async function verifySnsSignature(
	message: SnsMessage,
	fetchCert: CertFetcher = defaultFetchCert
): Promise<boolean> {
	if (!message.Signature || !message.SigningCertURL) return false;
	if (!isAllowedSnsCertUrl(message.SigningCertURL)) return false;

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
