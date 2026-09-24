import { Hono } from 'hono';
import { env } from '@trippy/server/env';
import {
	verifySnsSignature,
	isAllowedSnsApiUrl,
	rememberMessageId,
	type SnsMessage
} from '@trippy/server/sns';
import { applySesNotification, type SesEvent } from '@trippy/server/suppressions';

/**
 * Receives Amazon SES bounce and complaint notifications, delivered over SNS.
 *
 * SES publishes each bounce and complaint to an SNS topic, and SNS POSTs the
 * event here as JSON. The endpoint exists so a hard bounce or a complaint lands
 * in the suppression list and `sendMail` stops mailing that address, which is
 * what keeps the owner's `dxu.info` sending identity below the bounce and
 * complaint rates AWS suspends accounts for.
 *
 * It is mounted OUTSIDE `requireUser`: SNS is unauthenticated and holds no
 * session, so a session gate would reject every real notification. That makes
 * the message signature the only thing that authenticates a caller, and it is
 * verified on every message type before anything is acted on. Nothing else about
 * the request is trusted: the endpoint takes no path parameters, reads only the
 * signed fields, and answers everything with a bare 200 and no detail, so it can
 * neither be probed nor made to leak an internal error.
 */
export const ses = new Hono();

/** SNS message types this endpoint understands. */
type SnsType = 'SubscriptionConfirmation' | 'Notification' | 'UnsubscribeConfirmation';

/**
 * Confirm a subscription (or unsubscribe) by fetching the URL SNS put in the
 * message. The URL is validated as a real SNS host first, for the same reason
 * the signing certificate URL is: a verified message still must not be able to
 * point us at an arbitrary server. A confirmed signature already vouches for the
 * message, and this is belt-and-braces on top of it.
 */
async function confirm(subscribeUrl: string | undefined): Promise<void> {
	if (!subscribeUrl || !isAllowedSnsApiUrl(subscribeUrl)) return;
	try {
		await fetch(subscribeUrl, { redirect: 'error' });
	} catch {
		// A failed confirmation is AWS's to retry; there is nothing to report to
		// the caller, which is SNS itself.
	}
}

let warnedNoTopics = false;

/**
 * Whether a message came from one of OUR topics.
 *
 * A valid signature only proves AWS wrote the message. Any AWS account can
 * create an SNS topic, subscribe this public URL to it, confirm the
 * subscription (we used to follow any genuine `SubscribeURL`) and then publish
 * correctly signed "complaints" naming any address it liked, suppressing that
 * person's mail from us for good. `TopicArn` is one of the signed fields, so
 * holding it to `SES_SNS_TOPIC_ARN` is what binds a genuine message to our own
 * SES identity. Unset refuses everything, and says so once in the log: a
 * receiver nobody has configured should do nothing, not trust the world.
 */
function ourTopic(arn: unknown): boolean {
	const allowed = env.SES_SNS_TOPIC_ARN;
	if (!allowed.length) {
		if (!warnedNoTopics) {
			warnedNoTopics = true;
			console.warn('[ses] SES_SNS_TOPIC_ARN is not set; refusing every SNS message.');
		}
		return false;
	}
	return typeof arn === 'string' && allowed.includes(arn);
}

ses.post('/notifications', async (c) => {
	let message: SnsMessage;
	try {
		message = (await c.req.json()) as SnsMessage;
	} catch {
		// Not JSON at all: nothing to verify, nothing to do.
		return c.body(null, 200);
	}

	// The topic gate, before the signature, because it is free and the
	// signature check can fetch a certificate: a message for somebody else's
	// topic is dropped without costing us a request. It is still re-proven by
	// the signature below, since `TopicArn` is part of the signed string.
	if (!ourTopic(message?.TopicArn)) return c.body(null, 200);

	// The signature gate. Until this passes, the body is just bytes a stranger
	// sent, so no field of it is allowed to influence anything.
	const genuine = await verifySnsSignature(message).catch(() => false);
	if (!genuine) return c.body(null, 200);

	// The replay gate. A signature says who wrote a message, never how many
	// times it may be delivered, so one genuine complaint captured off the wire
	// could otherwise be re-POSTed for as long as it stays inside the freshness
	// window. Burned here, at the point of action, and only for a message that
	// already verified.
	if (!rememberMessageId(message.MessageId)) return c.body(null, 200);

	const type = message.Type as SnsType | undefined;

	if (type === 'SubscriptionConfirmation' || type === 'UnsubscribeConfirmation') {
		await confirm(message.SubscribeURL);
		return c.body(null, 200);
	}

	if (type === 'Notification') {
		// The SES event rides inside the SNS envelope as a JSON string.
		try {
			const event = JSON.parse(message.Message ?? '') as SesEvent;
			const applied = applySesNotification(event);
			// One line per applied notification, so an address that stops
			// receiving mail is something an operator can find rather than a
			// silent disappearance.
			if (applied.length) {
				console.info(`[ses] notification applied, ${applied.length} address(es) suppressed`);
			}
		} catch {
			// A malformed inner payload suppresses nothing and is not worth a 500;
			// SNS would only retry a request it could never make succeed.
		}
		return c.body(null, 200);
	}

	// A verified message of a type we do not handle is acknowledged and dropped.
	return c.body(null, 200);
});
