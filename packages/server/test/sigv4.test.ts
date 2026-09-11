import { describe, expect, it } from 'vitest';
import { signPost } from '../src/infra/sigv4';

/**
 * Checked against AWS's own published vectors, not against what this
 * implementation happens to produce. A signing bug is indistinguishable from a
 * wrong secret at the call site (both come back as an opaque 403), so the only
 * useful test is one whose expected value came from somewhere else.
 *
 * Source: awslabs/aws-c-auth, tests/aws-signing-test-suite/v4.
 */
const VECTOR_CREDENTIALS = {
	accessKeyId: 'AKIDEXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
};
const VECTOR_TIME = new Date('2015-08-30T12:36:00Z');

describe('signPost', () => {
	it("reproduces the suite's post-x-www-form-urlencoded signature", () => {
		const signed = signPost({
			url: 'https://example.amazonaws.com/',
			body: 'Param1=value1',
			region: 'us-east-1',
			service: 'service',
			credentials: VECTOR_CREDENTIALS,
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				'content-length': '13'
			},
			now: VECTOR_TIME
		});

		expect(signed.headers.authorization).toBe(
			'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
				'SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, ' +
				'Signature=d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b'
		);
	});

	it('hashes the body rather than trusting a caller to have done it', () => {
		const signed = signPost({
			url: 'https://example.amazonaws.com/',
			body: 'Param1=value1',
			region: 'us-east-1',
			service: 'service',
			credentials: VECTOR_CREDENTIALS,
			now: VECTOR_TIME
		});
		expect(signed.headers['x-amz-content-sha256']).toBe(
			'9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e'
		);
	});

	it('stamps the date in the compact form AWS expects, not an ISO string', () => {
		const signed = signPost({
			url: 'https://example.amazonaws.com/',
			body: '',
			region: 'us-east-1',
			service: 'service',
			credentials: VECTOR_CREDENTIALS,
			now: VECTOR_TIME
		});
		expect(signed.headers['x-amz-date']).toBe('20150830T123600Z');
	});

	it('takes the host from the URL, so a caller cannot sign a host it is not calling', () => {
		const signed = signPost({
			url: 'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails',
			body: '{}',
			region: 'us-east-1',
			service: 'ses',
			credentials: VECTOR_CREDENTIALS,
			headers: { host: 'attacker.example' },
			now: VECTOR_TIME
		});
		expect(signed.headers.host).toBe('email.us-east-1.amazonaws.com');
	});

	it('signs a session token when one is present, and omits the header when it is not', () => {
		const temporary = signPost({
			url: 'https://example.amazonaws.com/',
			body: '{}',
			region: 'us-east-1',
			service: 'ses',
			credentials: { ...VECTOR_CREDENTIALS, sessionToken: 'FQoGZXIvYXdzEXAMPLE' },
			now: VECTOR_TIME
		});
		expect(temporary.headers['x-amz-security-token']).toBe('FQoGZXIvYXdzEXAMPLE');
		expect(temporary.headers.authorization).toContain('x-amz-security-token');

		const longTerm = signPost({
			url: 'https://example.amazonaws.com/',
			body: '{}',
			region: 'us-east-1',
			service: 'ses',
			credentials: VECTOR_CREDENTIALS,
			now: VECTOR_TIME
		});
		expect(longTerm.headers['x-amz-security-token']).toBeUndefined();
		expect(longTerm.headers.authorization).not.toContain('x-amz-security-token');
	});

	it('scopes the signature to the day, the region and the service', () => {
		const base = {
			url: 'https://example.amazonaws.com/',
			body: '{}',
			credentials: VECTOR_CREDENTIALS,
			now: VECTOR_TIME
		};
		const signature = (r: string, s: string) =>
			signPost({ ...base, region: r, service: s }).headers.authorization.split('Signature=')[1];

		expect(signature('us-east-1', 'ses')).not.toBe(signature('us-west-2', 'ses'));
		expect(signature('us-east-1', 'ses')).not.toBe(signature('us-east-1', 'sqs'));
		expect(
			signPost({ ...base, region: 'us-east-1', service: 'ses', now: new Date('2015-08-31T12:36:00Z') })
				.headers.authorization
		).not.toBe(signPost({ ...base, region: 'us-east-1', service: 'ses' }).headers.authorization);
	});

	it('refuses a query string rather than canonicalising it the wrong way', () => {
		expect(() =>
			signPost({
				url: 'https://example.amazonaws.com/?Action=SendEmail',
				body: '{}',
				region: 'us-east-1',
				service: 'ses',
				credentials: VECTOR_CREDENTIALS,
				now: VECTOR_TIME
			})
		).toThrow(/query string/);
	});
});
