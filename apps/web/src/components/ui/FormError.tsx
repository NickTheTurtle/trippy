import type { ReactNode } from 'react';

/**
 * The shared form message.
 *
 * Five pages had grown their own version of this and they had drifted apart in
 * both wording and semantics: one announced failures as `role="status"`, which
 * a screen reader delivers politely and may therefore never interrupt with, and
 * the whole point of the message is that something went wrong. The role is
 * derived from the tone here so it cannot be got wrong per call site.
 *
 * Two shapes, because the app has exactly two places a message like this
 * appears:
 *  - `footer`, the small line that sits beside the buttons in a dialog's
 *    `.mfoot`, which is where a failed submit belongs;
 *  - `banner`, the tinted block above a form or a page section, which is where
 *    a result the user should notice after the fact belongs.
 */
export type MessageTone = 'error' | 'success' | 'info';
export type MessageVariant = 'footer' | 'banner';

const FOOTER_TONE: Record<MessageTone, string> = {
	error: 'text-danger-ink',
	success: 'text-accent-ink',
	info: 'text-ink-soft'
};

const BANNER_TONE: Record<MessageTone, string> = {
	error: 'bg-danger-soft text-danger-ink',
	success: 'bg-accent-soft text-accent-ink',
	info: 'bg-surface-2 text-ink-soft'
};

export default function FormError({
	message,
	tone = 'error',
	variant = 'footer',
	className = ''
}: {
	/** Nothing renders when this is empty, so callers can pass state straight in. */
	message?: ReactNode;
	/** Errors are announced assertively; everything else politely. */
	tone?: MessageTone;
	variant?: MessageVariant;
	className?: string;
}) {
	if (message === null || message === undefined || message === '' || message === false) return null;

	const classes =
		variant === 'footer'
			? `mfoot-note m-0 text-[0.86rem] ${FOOTER_TONE[tone]}`
			: `m-0 mb-4 rounded-lg px-3.5 py-2.5 text-[0.9rem] ${BANNER_TONE[tone]}`;

	return (
		<p role={tone === 'error' ? 'alert' : 'status'} className={`${classes} ${className}`.trim()}>
			{message}
		</p>
	);
}
