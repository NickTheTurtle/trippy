import { describe, expect, it, beforeEach } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import {
	verifySnsSignature,
	isAllowedSnsCertUrl,
	isAllowedSnsApiUrl,
	isFreshTimestamp,
	rememberMessageId,
	resetSeenMessageIds,
	MAX_MESSAGE_AGE_MS,
	type SnsMessage
} from '../src/infra/sns.ts';

/**
 * The signature check on the SES/SNS receiver.
 *
 * The endpoint is unauthenticated because SNS holds no session, so this
 * signature is the only thing between it and anyone who finds the URL. If it
 * could be bypassed, a stranger could forge a "complaint" for any address and
 * have us stop mailing that user: a denial-of-service against our own accounts.
 * These cases pin that a genuine message passes, a tampered one does not, and a
 * certificate URL that is not really AWS is refused before it is ever fetched.
 */

const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem';

// A stand-in for AWS's signing key. The verifier accepts a bare public key as
// well as an X.509 certificate precisely so the signature maths can be tested
// without minting a self-signed certificate; a real SNS message always ships a
// certificate.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** The exact string AWS signs for a Notification, rebuilt here to sign a fixture. */
function notificationStringToSign(m: SnsMessage): string {
	const keys = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] as const;
	let out = '';
	for (const k of keys) {
		const v = m[k];
		if (v === undefined || v === null) continue;
		out += `${k}\n${String(v)}\n`;
	}
	return out;
}

function sign(stringToSign: string): string {
	const signer = createSign('RSA-SHA256');
	signer.update(stringToSign, 'utf8');
	signer.end();
	return signer.sign(privateKey, 'base64');
}

/** A fully-formed, correctly-signed Notification. */
function signedNotification(timestamp = new Date().toISOString()): SnsMessage {
	const base: SnsMessage = {
		Type: 'Notification',
		MessageId: `id-${Math.random().toString(36).slice(2)}`,
		TopicArn: 'arn:aws:sns:us-east-1:123456789012:ses-bounces',
		Message: JSON.stringify({ notificationType: 'Delivery' }),
		Timestamp: timestamp,
		SignatureVersion: '2',
		SigningCertURL: CERT_URL
	};
	return { ...base, Signature: sign(notificationStringToSign(base)) };
}

/** Answers the cert fetch with our stand-in public key; never touches the network. */
const fetchCert = async () => publicPem;

describe('SNS certificate URL validation', () => {
	it('accepts a genuine SNS host and certificate path', () => {
		expect(isAllowedSnsCertUrl(CERT_URL)).toBe(true);
		expect(
			isAllowedSnsCertUrl('https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-x1.pem')
		).toBe(true);
		expect(
			isAllowedSnsCertUrl('https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-x.pem')
		).toBe(true);
	});

	it('rejects a look-alike or non-AWS host', () => {
		expect(isAllowedSnsCertUrl('https://sns.us-east-1.amazonaws.com.evil.com/x.pem')).toBe(false);
		expect(isAllowedSnsCertUrl('https://evil.com/sns.amazonaws.com.pem')).toBe(false);
		expect(isAllowedSnsCertUrl('https://amazonaws.com/x.pem')).toBe(false);
		// Userinfo trick: the real host is still evil.com.
		expect(
			isAllowedSnsCertUrl(
				'https://sns.us-east-1.amazonaws.com@evil.com/SimpleNotificationService-a.pem'
			)
		).toBe(false);
	});

	it('rejects a path on a real SNS host that is not a certificate', () => {
		// A verified-looking host is not enough: only the certificate path is
		// something we have any business fetching.
		expect(isAllowedSnsCertUrl('https://sns.us-east-1.amazonaws.com/?Action=Publish')).toBe(false);
		expect(isAllowedSnsCertUrl('https://sns.us-east-1.amazonaws.com/x.pem')).toBe(false);
		expect(isAllowedSnsCertUrl('https://sns.us-east-1.amazonaws.com/a/b/../x.pem')).toBe(false);
	});

	it('rejects plain HTTP', () => {
		expect(isAllowedSnsCertUrl('http://sns.us-east-1.amazonaws.com/x.pem')).toBe(false);
		expect(
			isAllowedSnsCertUrl('http://sns.us-east-1.amazonaws.com/SimpleNotificationService-a.pem')
		).toBe(false);
	});

	it('rejects garbage that is not a URL at all', () => {
		expect(isAllowedSnsCertUrl('')).toBe(false);
		expect(isAllowedSnsCertUrl('not a url')).toBe(false);
		expect(isAllowedSnsCertUrl('file:///etc/passwd')).toBe(false);
	});
});

describe('SNS subscribe URL validation', () => {
	it('accepts an SNS API URL and refuses anywhere else', () => {
		// The SubscribeURL is an API URL, not a certificate, so it has no .pem
		// path; the host rule is the same one and is the part that matters.
		expect(
			isAllowedSnsApiUrl('https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=x')
		).toBe(true);
		expect(isAllowedSnsApiUrl('https://evil.com/?Action=ConfirmSubscription')).toBe(false);
		expect(isAllowedSnsApiUrl('http://sns.us-east-1.amazonaws.com/')).toBe(false);
	});
});

describe('SNS signature verification', () => {
	it('accepts a correctly signed notification', async () => {
		expect(await verifySnsSignature(signedNotification(), fetchCert)).toBe(true);
	});

	it('rejects a forged notification whose body was changed after signing', async () => {
		const msg = signedNotification();
		// An attacker swaps in their own SES payload but cannot re-sign it.
		msg.Message = JSON.stringify({
			notificationType: 'Complaint',
			complaint: { complainedRecipients: [{ emailAddress: 'victim@example.test' }] }
		});
		expect(await verifySnsSignature(msg, fetchCert)).toBe(false);
	});

	it('rejects a message with no signature at all', async () => {
		const msg = signedNotification();
		delete msg.Signature;
		expect(await verifySnsSignature(msg, fetchCert)).toBe(false);
	});

	it('rejects a signature made with the wrong key', async () => {
		const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const msg = signedNotification();
		const signer = createSign('RSA-SHA256');
		signer.update(notificationStringToSign(msg), 'utf8');
		signer.end();
		msg.Signature = signer.sign(other.privateKey, 'base64');
		expect(await verifySnsSignature(msg, fetchCert)).toBe(false);
	});

	it('refuses a certificate served from a non-AWS URL without fetching it', async () => {
		const msg = signedNotification();
		msg.SigningCertURL = 'https://evil.com/cert.pem';
		let fetched = false;
		const spyFetch = async () => {
			fetched = true;
			return publicPem;
		};
		expect(await verifySnsSignature(msg, spyFetch)).toBe(false);
		expect(fetched).toBe(false);
	});

	it('rejects an unknown signature version', async () => {
		const msg = signedNotification();
		msg.SignatureVersion = '9';
		expect(await verifySnsSignature(msg, fetchCert)).toBe(false);
	});

	it('rejects a message type it does not know how to canonicalise', async () => {
		// An unexpected Type has no defined signed string, so there is nothing to
		// verify against and the only safe answer is no.
		const msg = signedNotification();
		msg.Type = 'SomethingElse';
		expect(await verifySnsSignature(msg, fetchCert)).toBe(false);
		delete msg.Type;
		expect(await verifySnsSignature(msg, fetchCert)).toBe(false);
	});

	it('rejects a message missing the fields the signature covers', async () => {
		for (const field of ['MessageId', 'TopicArn', 'Message', 'Timestamp'] as const) {
			const msg = signedNotification();
			delete msg[field];
			expect(await verifySnsSignature(msg, fetchCert)).toBe(false);
		}
	});

	it('refuses a certificate the fetch could not produce', async () => {
		const msg = signedNotification();
		const failing = async () => {
			throw new Error('502');
		};
		expect(await verifySnsSignature(msg, failing)).toBe(false);
	});

	it('refuses a certificate that is not a key at all', async () => {
		const msg = signedNotification();
		expect(await verifySnsSignature(msg, async () => 'hello, not a certificate')).toBe(false);
	});

	it('rejects a stale message even though its signature is perfect', async () => {
		// The replay case. A signature says who wrote a message, never when or how
		// often it may be delivered, so a genuine notification captured off the
		// wire would verify forever without a freshness window.
		const old = new Date(Date.now() - MAX_MESSAGE_AGE_MS - 60_000).toISOString();
		const msg = signedNotification(old);
		expect(await verifySnsSignature(msg, fetchCert)).toBe(false);
		// The same message, judged at the time it was actually sent, is fine: it is
		// the age that refuses it, not anything wrong with the signature.
		expect(await verifySnsSignature(msg, fetchCert, Date.parse(old) + 1000)).toBe(true);
	});

	it('rejects a message dated in the future beyond clock skew', async () => {
		const msg = signedNotification(new Date(Date.now() + 10 * 60_000).toISOString());
		expect(await verifySnsSignature(msg, fetchCert)).toBe(false);
	});

	it('rejects an unparseable timestamp rather than treating it as now', async () => {
		const msg = signedNotification('not a date');
		expect(await verifySnsSignature(msg, fetchCert)).toBe(false);
	});
});

describe('timestamp freshness', () => {
	const now = Date.UTC(2026, 8, 16, 12, 0, 0);
	const at = (ms: number) => new Date(now + ms).toISOString();

	it('accepts a message sent inside the window', () => {
		expect(isFreshTimestamp(at(0), now)).toBe(true);
		expect(isFreshTimestamp(at(-MAX_MESSAGE_AGE_MS + 1000), now)).toBe(true);
	});

	it('refuses one sent outside it', () => {
		expect(isFreshTimestamp(at(-MAX_MESSAGE_AGE_MS - 1000), now)).toBe(false);
	});

	it('fails closed on a missing or unreadable timestamp', () => {
		expect(isFreshTimestamp(undefined, now)).toBe(false);
		expect(isFreshTimestamp('', now)).toBe(false);
		expect(isFreshTimestamp('yesterday', now)).toBe(false);
	});

	it('allows a minute of clock skew but not ten', () => {
		expect(isFreshTimestamp(at(30_000), now)).toBe(true);
		expect(isFreshTimestamp(at(10 * 60_000), now)).toBe(false);
	});
});

describe('replay memory', () => {
	beforeEach(() => resetSeenMessageIds());

	it('accepts an id once and refuses it again', () => {
		expect(rememberMessageId('id-1')).toBe(true);
		expect(rememberMessageId('id-1')).toBe(false);
		expect(rememberMessageId('id-1')).toBe(false);
	});

	it('does not confuse two different messages', () => {
		expect(rememberMessageId('id-1')).toBe(true);
		expect(rememberMessageId('id-2')).toBe(true);
	});

	it('refuses a message with no id', () => {
		// MessageId is inside the signed string, so a genuine message always has
		// one; a missing id is either malformed or an attempt to dodge the check.
		expect(rememberMessageId(undefined)).toBe(false);
		expect(rememberMessageId('')).toBe(false);
	});

	it('forgets ids that can no longer be accepted anyway', () => {
		const now = Date.now();
		expect(rememberMessageId('id-old', now)).toBe(true);
		// Past the freshness window the signature check would refuse the message
		// regardless, so the memory is pruned rather than grown forever.
		expect(rememberMessageId('id-new', now + MAX_MESSAGE_AGE_MS + 1000)).toBe(true);
		expect(rememberMessageId('id-old', now + MAX_MESSAGE_AGE_MS + 1000)).toBe(true);
	});
});
