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
 * With nothing configured, sending is skipped rather than failed. A trip still
 * works end to end without email (the invitee is added to the roster the moment
 * they are invited, and the invite is consumed when they register), so a
 * missing key must not turn inviting somebody into an error. In development the
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

	const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body });
	if (!res.ok) return logRefusal('ses', res.status, await res.text());
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
 * The invite itself.
 *
 * The link goes to the sign-up page, because an invite is consumed by
 * registering with the invited address: there is no separate accept step to
 * send somebody to, and a token would be a second way to join that the roster
 * already covers.
 */
export function tripInviteMail(args: {
	to: string;
	tripName: string;
	inviterName: string;
	dates: string | null;
}): Mail {
	const url = `${env.APP_URL}/register?email=${encodeURIComponent(args.to)}`;
	const when = args.dates ? ` (${args.dates})` : '';
	const subject = `${args.inviterName} invited you to ${args.tripName}`;

	const text = [
		`${args.inviterName} added you to ${args.tripName}${when} on Trippy.`,
		'',
		`Sign up with this address to join: ${url}`
	].join('\n');

	const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1f2421">
  <p>${esc(args.inviterName)} added you to <strong>${esc(args.tripName)}</strong>${esc(when)} on Trippy.</p>
  <p><a href="${esc(url)}" style="display:inline-block;background:#2f6d5e;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">Join the trip</a></p>
  <p style="color:#6b7280;font-size:13px">Sign up with ${esc(args.to)} and the trip will be waiting for you.</p>
</div>`;

	return { to: args.to, subject, text, html };
}
