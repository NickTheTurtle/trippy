import { env } from '../infra/env';

/**
 * Outbound email.
 *
 * One provider, Resend, over plain HTTP: it needs no dependency, no SMTP socket
 * and no connection pool to keep alive, which is the whole of what this app
 * asks of a mail service.
 *
 * With no key configured, sending is skipped rather than failed. A trip still
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

export function mailConfigured(): boolean {
	return !!env.RESEND_API_KEY && !!env.MAIL_FROM;
}

export async function sendMail(mail: Mail): Promise<MailResult> {
	if (!mailConfigured()) {
		console.info(`[mail] not configured, skipping: "${mail.subject}" to ${mail.to}`);
		return 'skipped';
	}
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
			// The body carries the provider's reason (an unverified domain, a
			// malformed address). Logged, never returned: it is the operator's
			// problem, and the invitee's address is not the caller's to be told about.
			console.error(`[mail] send failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
			return 'failed';
		}
		return 'sent';
	} catch (err) {
		console.error('[mail] send threw', err);
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
