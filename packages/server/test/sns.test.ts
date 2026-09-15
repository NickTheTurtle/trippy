import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { verifySnsSignature, isAllowedSnsCertUrl, type SnsMessage } from '../src/infra/sns.ts';

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
function signedNotification(): SnsMessage {
	const base: SnsMessage = {
		Type: 'Notification',
		MessageId: 'id-1',
		TopicArn: 'arn:aws:sns:us-east-1:123456789012:ses-bounces',
		Message: JSON.stringify({ notificationType: 'Delivery' }),
		Timestamp: '2026-09-15T00:00:00.000Z',
		SignatureVersion: '2',
		SigningCertURL: CERT_URL
	};
	return { ...base, Signature: sign(notificationStringToSign(base)) };
}

/** Answers the cert fetch with our stand-in public key; never touches the network. */
const fetchCert = async () => publicPem;

describe('SNS certificate URL validation', () => {
	it('accepts a genuine SNS host', () => {
		expect(isAllowedSnsCertUrl(CERT_URL)).toBe(true);
		expect(isAllowedSnsCertUrl('https://sns.eu-west-2.amazonaws.com/x.pem')).toBe(true);
	});

	it('rejects a look-alike or non-AWS host', () => {
		expect(isAllowedSnsCertUrl('https://sns.us-east-1.amazonaws.com.evil.com/x.pem')).toBe(false);
		expect(isAllowedSnsCertUrl('https://evil.com/sns.amazonaws.com.pem')).toBe(false);
		expect(isAllowedSnsCertUrl('https://amazonaws.com/x.pem')).toBe(false);
	});

	it('rejects plain HTTP', () => {
		expect(isAllowedSnsCertUrl('http://sns.us-east-1.amazonaws.com/x.pem')).toBe(false);
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
});
