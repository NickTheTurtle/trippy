import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The SES/SNS receiver route, as a request.
 *
 * The endpoint is unauthenticated by necessity, so what these cases pin is the
 * order of the gates: nothing a caller sends is acted on until the signature
 * verifies, and a verified message is acted on exactly once. Without the second
 * gate, one genuine complaint captured off the wire could be re-POSTed to
 * suppress an address repeatedly; without the first, anyone who finds the URL
 * could suppress any address they liked and lock that person out of their own
 * account.
 *
 * `verifySnsSignature` is stubbed here (its own maths is covered exhaustively
 * in packages/server/test/sns.test.ts) so these cases are about the wiring, and
 * so nothing in this file needs a network or a real AWS certificate.
 */

const tempRoot = join(tmpdir(), `trippy-ses-route-${process.pid}-${Date.now()}`);
const dbPath = join(tempRoot, 'ses-route.test.db');
mkdirSync(tempRoot, { recursive: true });
process.env.TRIPPY_DB = dbPath;

/** The one topic this receiver is configured to trust in these cases. */
const OUR_TOPIC = 'arn:aws:sns:us-east-1:123456789012:ses-bounces';

const verifySnsSignature = vi.fn(async () => true);

vi.mock('@trippy/server/sns', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@trippy/server/sns')>();
	return { ...actual, verifySnsSignature };
});

let app: Awaited<typeof import('../src/routes/ses.ts')>['ses'];
let suppressions: typeof import('@trippy/server/suppressions');
let sns: typeof import('@trippy/server/sns');
let db: Awaited<typeof import('@trippy/server/db')>['db'];

beforeAll(async () => {
	// Imported one at a time, deliberately. A Promise.all here races the mock
	// factory against the direct import of the same module, and losing that race
	// hands the route the real verifier: every negative case still passes (it
	// verifies nothing) while the positive ones fail, which is the least useful
	// possible failure mode for a security test.
	sns = await import('@trippy/server/sns');
	({ ses: app } = await import('../src/routes/ses.ts'));
	suppressions = await import('@trippy/server/suppressions');
	({ db } = await import('@trippy/server/db'));
});

beforeEach(() => {
	process.env.SES_SNS_TOPIC_ARN = OUR_TOPIC;
	db.prepare(`DELETE FROM mail_suppressions`).run();
	sns.resetSeenMessageIds();
	verifySnsSignature.mockReset();
	verifySnsSignature.mockResolvedValue(true);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('ok'))
	);
});

afterAll(() => {
	delete process.env.SES_SNS_TOPIC_ARN;
	vi.unstubAllGlobals();
	db.close();
	for (const suffix of ['', '-wal', '-shm']) {
		const file = `${dbPath}${suffix}`;
		if (existsSync(file)) rmSync(file, { force: true });
	}
	if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

/** An SNS envelope carrying an SES complaint for one address. */
function complaintEnvelope(email: string, messageId = `id-${Math.random()}`) {
	return {
		Type: 'Notification',
		MessageId: messageId,
		TopicArn: OUR_TOPIC,
		Timestamp: new Date().toISOString(),
		SignatureVersion: '2',
		Signature: 'whatever-the-stub-says',
		SigningCertURL: 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-a1.pem',
		Message: JSON.stringify({
			notificationType: 'Complaint',
			complaint: {
				complaintFeedbackType: 'abuse',
				complainedRecipients: [{ emailAddress: email }]
			}
		})
	};
}

function post(body: unknown) {
	return app.request('/notifications', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
}

describe('the SES notification receiver', () => {
	it('is really running against the stubbed verifier', () => {
		// Guards the guard: if the mock ever fails to take effect, every negative
		// case below still passes (nothing verifies, so nothing is applied) and
		// the suite would go green while testing nothing. Fail here instead.
		expect(vi.isMockFunction(sns.verifySnsSignature)).toBe(true);
	});

	it('applies a verified complaint', async () => {
		const res = await post(complaintEnvelope('angry@example.test'));
		expect(res.status).toBe(200);
		expect(suppressions.isSuppressed('angry@example.test')).toBe(true);
	});

	it('acts on nothing when the signature does not verify', async () => {
		// The whole security property: an unsigned or forged POST from anyone who
		// found the URL must not be able to suppress an address.
		verifySnsSignature.mockResolvedValue(false);
		const res = await post(complaintEnvelope('victim@example.test'));
		expect(res.status).toBe(200);
		expect(suppressions.isSuppressed('victim@example.test')).toBe(false);
	});

	it('acts on nothing when verification throws', async () => {
		verifySnsSignature.mockRejectedValue(new Error('cert fetch exploded'));
		await post(complaintEnvelope('victim@example.test'));
		expect(suppressions.isSuppressed('victim@example.test')).toBe(false);
	});

	it('ignores a replay of a message it already applied', async () => {
		const envelope = complaintEnvelope('angry@example.test', 'replay-me');
		await post(envelope);
		suppressions.unsuppress('angry@example.test');
		// The identical, still perfectly signed, message arrives again.
		await post(envelope);
		expect(suppressions.isSuppressed('angry@example.test')).toBe(false);
	});

	it('refuses a verified message with no MessageId', async () => {
		const envelope = complaintEnvelope('angry@example.test');
		delete (envelope as Record<string, unknown>).MessageId;
		await post(envelope);
		expect(suppressions.isSuppressed('angry@example.test')).toBe(false);
	});

	it('confirms a subscription only through a real SNS URL', async () => {
		const stub = vi.fn(async () => new Response('ok'));
		vi.stubGlobal('fetch', stub);
		await post({
			Type: 'SubscriptionConfirmation',
			MessageId: 'sub-1',
			TopicArn: OUR_TOPIC,
			Token: 't',
			Timestamp: new Date().toISOString(),
			SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t'
		});
		expect(stub).toHaveBeenCalledOnce();

		stub.mockClear();
		await post({
			Type: 'SubscriptionConfirmation',
			MessageId: 'sub-2',
			TopicArn: OUR_TOPIC,
			Token: 't',
			Timestamp: new Date().toISOString(),
			SubscribeURL: 'https://evil.example/?Action=ConfirmSubscription&Token=t'
		});
		// A verified message still must not be able to point us at any host it
		// likes: that would be a request forgery with AWS's signature on it.
		expect(stub).not.toHaveBeenCalled();
	});

	it('shrugs off a body that is not JSON', async () => {
		const res = await post('not json at all');
		expect(res.status).toBe(200);
	});

	it('shrugs off a verified envelope whose inner payload is rubbish', async () => {
		const envelope = complaintEnvelope('angry@example.test');
		envelope.Message = '{{{';
		const res = await post(envelope);
		expect(res.status).toBe(200);
		expect(suppressions.isSuppressed('angry@example.test')).toBe(false);
	});

	it('acknowledges a verified type it does not handle', async () => {
		const res = await post({
			Type: 'UnsubscribeConfirmation',
			MessageId: 'unsub-1',
			TopicArn: OUR_TOPIC,
			Timestamp: new Date().toISOString()
		});
		expect(res.status).toBe(200);
	});
});

/**
 * The topic gate. A genuine SNS signature proves AWS wrote a message, not that
 * it came from our topic: any AWS account can subscribe this URL to a topic of
 * its own and publish signed complaints naming anyone. So the topic is held to
 * `SES_SNS_TOPIC_ARN` before anything else, for every message type.
 */
describe('the SES receiver topic allowlist', () => {
	it("drops a verified complaint from somebody else's topic, before verifying it", async () => {
		const envelope = {
			...complaintEnvelope('victim@example.test'),
			TopicArn: 'arn:aws:sns:us-east-1:999999999999:attacker'
		};
		const res = await post(envelope);
		expect(res.status).toBe(200);
		expect(suppressions.isSuppressed('victim@example.test')).toBe(false);
		// Refused on the topic alone, so no certificate was ever fetched for it.
		expect(verifySnsSignature).not.toHaveBeenCalled();
	});

	it('does not confirm a subscription to a foreign topic', async () => {
		const stub = vi.fn(async () => new Response('ok'));
		vi.stubGlobal('fetch', stub);
		await post({
			Type: 'SubscriptionConfirmation',
			MessageId: 'sub-foreign',
			TopicArn: 'arn:aws:sns:us-east-1:999999999999:attacker',
			Token: 't',
			Timestamp: new Date().toISOString(),
			SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t'
		});
		expect(stub).not.toHaveBeenCalled();
	});

	it('drops a message with no topic at all', async () => {
		const envelope = complaintEnvelope('victim@example.test');
		delete (envelope as Record<string, unknown>).TopicArn;
		await post(envelope);
		expect(suppressions.isSuppressed('victim@example.test')).toBe(false);
	});

	it('refuses everything when no topic is configured', async () => {
		delete process.env.SES_SNS_TOPIC_ARN;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await post(complaintEnvelope('angry@example.test'));
		await post(complaintEnvelope('angry@example.test'));
		expect(suppressions.isSuppressed('angry@example.test')).toBe(false);
		// Said once, not once per message: a busy topic must not flood the log.
		expect(warn.mock.calls.filter((c) => String(c[0]).includes('SES_SNS_TOPIC_ARN'))).toHaveLength(1);
		warn.mockRestore();
	});

	it('accepts any topic in a comma-separated list', async () => {
		process.env.SES_SNS_TOPIC_ARN = `arn:aws:sns:eu-west-1:123456789012:other, ${OUR_TOPIC}`;
		await post(complaintEnvelope('angry@example.test'));
		expect(suppressions.isSuppressed('angry@example.test')).toBe(true);
	});
});
