import { env } from '../infra/env';
import { signPost } from '../infra/sigv4';

/**
 * Outbound email.
 *
 * Two providers, both over plain HTTP: Amazon SES, and Resend. Neither needs a
 * dependency, an SMTP socket or a connection pool to keep alive, which is the
 * whole of what this app asks of a mail service. SES wins when both are
 * configured, because credentials for it are the more deliberate thing to have
 * set: `AWS_ACCESS_KEY_ID` may well be in the environment for other reasons,
 * but `MAIL_FROM` on a domain SES has verified is not an accident.
 *
 * Only two messages go out, and both belong to signing in: the link that turns
 * a pending registration into an account, and the one that resets a password.
 * Adding somebody to a trip deliberately sends nothing. They are on the roster
 * the moment they are added and are linked to their account when they register
 * at the address recorded for them, so an email would announce a thing that had
 * already happened without it.
 *
 * With nothing configured, sending is skipped rather than failed, so a fresh
 * clone can register and sign in with no keys at all. In development the
 * message is logged instead, so the copy can still be read.
 */
export type MailResult = 'sent' | 'skipped' | 'failed';

export interface Mail {
	to: string;
	subject: string;
	text: string;
	html: string;
}

type Provider = 'ses' | 'resend' | null;

/**
 * Which provider a send would use. Exported so a caller can report whether mail
 * is on without having to know what is behind it.
 */
export function mailProvider(): Provider {
	if (!env.MAIL_FROM) return null;
	if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return 'ses';
	if (env.RESEND_API_KEY) return 'resend';
	return null;
}

export function mailConfigured(): boolean {
	return mailProvider() !== null;
}

/**
 * The provider's own reason for a refusal (an unverified domain, an address
 * still inside the SES sandbox, a malformed From) is logged and never returned.
 * It is the operator's problem, and the invitee's address is not the caller's
 * to be told about.
 */
function logRefusal(provider: Provider, status: number, detail: string): 'failed' {
	console.error(`[mail] ${provider} send failed ${status}: ${detail.slice(0, 300)}`);
	return 'failed';
}

/**
 * SES v2. The v1 API is form-encoded and v2 is the one AWS adds features to.
 * Signed by hand rather than through the AWS SDK: see `infra/sigv4.ts`.
 */
async function sendViaSes(mail: Mail): Promise<MailResult> {
	const region = env.SES_REGION;
	const body = JSON.stringify({
		FromEmailAddress: env.MAIL_FROM,
		Destination: { ToAddresses: [mail.to] },
		Content: {
			Simple: {
				Subject: { Data: mail.subject, Charset: 'UTF-8' },
				Body: {
					Text: { Data: mail.text, Charset: 'UTF-8' },
					Html: { Data: mail.html, Charset: 'UTF-8' }
				}
			}
		}
	});

	const signed = signPost({
		url: `https://email.${region}.amazonaws.com/v2/email/outbound-emails`,
		body,
		region,
		service: 'ses',
		credentials: {
			accessKeyId: env.AWS_ACCESS_KEY_ID as string,
			secretAccessKey: env.AWS_SECRET_ACCESS_KEY as string,
			sessionToken: env.AWS_SESSION_TOKEN
		},
		headers: { 'content-type': 'application/json' }
	});

	const res = await fetch(signed.url, {
		method: 'POST',
		headers: signed.headers,
		body: signed.body
	});
	if (!res.ok) return logRefusal('ses', res.status, await res.text());
	// SES v2 answers a success with a JSON body carrying the MessageId. It is
	// not returned (MailResult stays a plain string union so callers are
	// unaffected), but logging it lets a delivery, bounce or complaint be traced
	// back to this send in the SES logs.
	try {
		const { MessageId } = (await res.json()) as { MessageId?: string };
		if (MessageId) console.info(`[mail] ses sent, MessageId ${MessageId}`);
	} catch {
		// A 2xx with no readable body is still a send; the id is a bonus, not a gate.
	}
	return 'sent';
}

export async function sendMail(mail: Mail): Promise<MailResult> {
	const provider = mailProvider();
	if (!provider) {
		console.info(`[mail] not configured, skipping: "${mail.subject}" to ${mail.to}`);
		return 'skipped';
	}
	try {
		if (provider === 'ses') return await sendViaSes(mail);
		return await sendViaResend(mail);
	} catch (err) {
		console.error(`[mail] ${provider} send threw`, err);
		return 'failed';
	}
}

async function sendViaResend(mail: Mail): Promise<MailResult> {
	try {
		const res = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${env.RESEND_API_KEY}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				from: env.MAIL_FROM,
				to: [mail.to],
				subject: mail.subject,
				text: mail.text,
				html: mail.html
			})
		});
		if (!res.ok) {
			return logRefusal('resend', res.status, await res.text());
		}
		return 'sent';
	} catch (err) {
		console.error('[mail] resend send threw', err);
		return 'failed';
	}
}

const esc = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The one HTML shell both messages use, so a change of voice or colour happens
 * once. `lead` and `tail` are already-escaped fragments, because both carry
 * markup of their own.
 */
function layout(args: { lead: string; url: string; action: string; tail: string }): string {
	return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1f2421">
  <p>${args.lead}</p>
  <p><a href="${esc(args.url)}" style="display:inline-block;background:#2f6d5e;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">${esc(args.action)}</a></p>
  <p style="color:#6b7280;font-size:13px">${args.tail}</p>
</div>`;
}

/**
 * The link that turns a pending registration into an account.
 *
 * It says plainly that nothing exists yet, because that is the honest state and
 * it also tells somebody who did not ask that there is nothing to undo.
 */
export function verifyEmailMail(args: { to: string; name: string; token: string }): Mail {
	const url = `${env.APP_URL}/verify?token=${encodeURIComponent(args.token)}`;
	const text = [
		`Hi ${args.name},`,
		'',
		'Confirm this address to finish setting up your Trippy account:',
		url,
		'',
		'Works for 24 hours. If you did not ask for an account, ignore this.'
	].join('\n');

	const html = layout({
		lead: `Hi ${esc(args.name)}, confirm this address to finish setting up your Trippy account.`,
		url,
		action: 'Confirm my email',
		tail: 'Works for 24 hours. If you did not ask for an account, ignore this.'
	});

	return { to: args.to, subject: 'Confirm your email for Trippy', text, html };
}

/**
 * The reset link. Shorter-lived than the verification one, because it opens an
 * account that already exists, and it warns that using it signs out every
 * device, since `POST /reset` drops all sessions and does not sign the user
 * back in.
 */
export function passwordResetMail(args: { to: string; name: string; token: string }): Mail {
	const url = `${env.APP_URL}/reset?token=${encodeURIComponent(args.token)}`;
	const text = [
		`Hi ${args.name},`,
		'',
		'Set a new Trippy password:',
		url,
		'',
		'Works for one hour, and signs out every device. If you did not ask for this, ignore this.'
	].join('\n');

	const html = layout({
		lead: `Hi ${esc(args.name)}, set a new Trippy password.`,
		url,
		action: 'Set a new password',
		tail: 'Works for one hour, and signs out every device. If you did not ask for this, ignore this.'
	});

	return { to: args.to, subject: 'Reset your Trippy password', text, html };
}
