import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, for the one request this app makes to AWS.
 *
 * Hand-rolled rather than pulled in with `@aws-sdk/client-sesv2`, because the
 * SDK brings a credential-provider chain, a retry strategy, a middleware stack
 * and several megabytes of transitive dependencies to do what is, at the level
 * this app needs, four HMACs and a string. The mail module's whole premise is a
 * provider it can talk to over plain `fetch` with no socket to keep alive.
 *
 * The cost of hand-rolling is that a signing bug looks exactly like a wrong
 * secret, so `sigv4.test.ts` checks this against AWS's own published test
 * vectors (`aws-c-auth/tests/aws-signing-test-suite/v4`) rather than against
 * what this implementation happens to produce.
 *
 * Scope, deliberately: headers only (no presigned URLs), a single string body
 * (no streaming), and no query string. SES v2 `SendEmail` needs nothing more,
 * and every unsupported case is a case that cannot be silently wrong.
 */

export interface SigV4Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	/** Present only for temporary credentials from STS. */
	sessionToken?: string;
}

export interface SignedRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';

const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer =>
	createHmac('sha256', key).update(data, 'utf8').digest();

/** `20150830T123600Z`, and its `20150830` prefix, which is all AWS wants. */
function amzDate(at: Date): { stamp: string; day: string } {
	const stamp = at.toISOString().replace(/[:-]|\.\d{3}/g, '');
	return { stamp, day: stamp.slice(0, 8) };
}

/**
 * The four-step key derivation. Each HMAC is keyed by the previous result, so
 * the signing key is scoped to one day, one region and one service: a leaked
 * signature cannot be replayed against a different service or a later date.
 */
function signingKey(secret: string, day: string, region: string, service: string): Buffer {
	const date = hmac(`AWS4${secret}`, day);
	const regional = hmac(date, region);
	const serviced = hmac(regional, service);
	return hmac(serviced, 'aws4_request');
}

/**
 * Sign a POST with a string body and return the headers to send with it.
 *
 * `headers` is whatever the caller wants signed beyond the mandatory ones.
 * Every header passed is signed, because a header AWS receives but did not
 * verify is a header a proxy could have rewritten.
 */
export function signPost(args: {
	url: string;
	body: string;
	region: string;
	service: string;
	credentials: SigV4Credentials;
	headers?: Record<string, string>;
	/** Injected by the tests to reproduce a published vector. */
	now?: Date;
}): SignedRequest {
	const { stamp, day } = amzDate(args.now ?? new Date());
	const url = new URL(args.url);
	// Loud rather than subtly wrong: AWS canonicalises a query string with its
	// own encoding rules, which `URLSearchParams` does not follow. Nothing here
	// needs one, so refusing is cheaper than a half-right implementation.
	if (url.search) throw new Error('signPost does not sign query strings');
	const payloadHash = sha256Hex(args.body);

	// `host` is derived from the URL rather than taken from the caller: a host
	// header that disagrees with where the request actually goes is the one
	// mismatch AWS cannot catch for us, because it only ever sees the header.
	const headers: Record<string, string> = {
		...args.headers,
		host: url.host,
		'x-amz-content-sha256': payloadHash,
		'x-amz-date': stamp
	};
	if (args.credentials.sessionToken) {
		headers['x-amz-security-token'] = args.credentials.sessionToken;
	}

	// Names lower-cased and sorted, values with runs of whitespace collapsed:
	// the canonical form exists so that both sides hash the same bytes no matter
	// how the transport chose to present them.
	const canonicalNames = Object.keys(headers)
		.map((h) => h.toLowerCase())
		.sort();
	const byLowerName = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
	const canonicalHeaders = canonicalNames
		.map((n) => `${n}:${String(byLowerName.get(n)).trim().replace(/\s+/g, ' ')}\n`)
		.join('');
	const signedHeaders = canonicalNames.join(';');

	const canonicalRequest = [
		'POST',
		url.pathname || '/',
		'',
		canonicalHeaders,
		signedHeaders,
		payloadHash
	].join('\n');

	const scope = `${day}/${args.region}/${args.service}/aws4_request`;
	const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n');
	const signature = hmac(
		signingKey(args.credentials.secretAccessKey, day, args.region, args.service),
		stringToSign
	).toString('hex');

	return {
		url: args.url,
		body: args.body,
		headers: {
			...headers,
			authorization: `${ALGORITHM} Credential=${args.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
		}
	};
}
