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
 *  - `footer`, the small line that sits beside the button that failed, which is
 *    the settle-up row: the reason is read next to the one control the user has
 *    to try again. A dialog's failed save no longer uses it. That went to the
 *    corner, because a line in a dialog footer is in the part of a tall dialog
 *    the reader may have scrolled away from;
 *  - `banner`, the tinted block above a form or a page section, which is where
 *    a result the user should notice after the fact belongs.
 */
export type MessageTone = 'error' | 'success';
export type MessageVariant = 'footer' | 'banner';

const FOOTER_TONE: Record<MessageTone, string> = {
	error: 'text-danger-ink',
	success: 'text-accent-ink'
};

const BANNER_TONE: Record<MessageTone, string> = {
	error: 'bg-danger-soft text-danger-ink',
	success: 'bg-accent-soft text-accent-ink'
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
			? `m-0 text-meta ${FOOTER_TONE[tone]}`
			: `m-0 mb-4 rounded-lg px-3.5 py-2.5 text-body ${BANNER_TONE[tone]}`;

	return (
		<p role={tone === 'error' ? 'alert' : 'status'} className={`${classes} ${className}`.trim()}>
			{message}
		</p>
	);
}
