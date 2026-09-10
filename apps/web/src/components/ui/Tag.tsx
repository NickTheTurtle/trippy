/**
 * The small upper-case pill that qualifies the thing beside it: YOU, ORGANIZER,
 * PAYMENT, NEEDS REVIEW.
 *
 * The roster and the expense ledger had each written the pill out by hand, and
 * the two had already drifted: same size and weight, but one tracked its
 * capitals wider than the other, and only one of them was `shrink-0`, so a long
 * name squeezed the tag in one place and truncated the name in the other.
 *
 * Two axes, because the existing pills use both: what it means (`tone`) and
 * whether it is filled or outlined. Filled reads as a statement about the row
 * itself, outlined as a note about its status.
 */
import type { ReactNode } from 'react';

const TONE = {
	accent: {
		solid: 'bg-accent-soft text-accent-ink',
		outline: 'border border-accent-soft text-accent-ink'
	},
	neutral: { solid: 'bg-line text-ink-soft', outline: 'border border-line text-ink-faint' },
	warn: { solid: 'bg-warn-soft text-warn', outline: 'border border-warn text-warn' }
} as const;

export default function Tag({
	tone = 'neutral',
	outline = false,
	title,
	className = '',
	children
}: {
	tone?: keyof typeof TONE;
	outline?: boolean;
	title?: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<span
			title={title}
			className={[
				'shrink-0 rounded-full px-1.5 py-px text-micro font-semibold tracking-wider uppercase',
				TONE[tone][outline ? 'outline' : 'solid'],
				className
			]
				.filter(Boolean)
				.join(' ')}
		>
			{children}
		</span>
	);
}
