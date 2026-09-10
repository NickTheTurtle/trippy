/**
 * The initial-in-a-circle that stands in for a person.
 *
 * Four pages had each drawn their own, at four sizes (28px, 30px, 30px, 34px)
 * and in three colour schemes, and they disagreed about the letter itself:
 * the header wrote `name.slice(0, 1).toUpperCase()` while the expense ledger
 * and the roster wrote `name[0]`, so the same member showed up as `A` in one
 * place and `a` in another. The circle is one idea and belongs in one file.
 *
 * `label` is an escape hatch for the one caller that does not show an initial:
 * the "+4" that closes an overflowing stack of members.
 */
import type { ReactNode } from 'react';

const SIZE = {
	/** The default. Rows, stacks, and the header. */
	md: 'size-[30px] text-meta',
	/** For the roster, where the circle is the row's leading element. */
	lg: 'size-[34px] text-body'
} as const;

const TONE = {
	/** A person, at rest. */
	accent: 'bg-accent-soft text-accent-ink',
	/** The signed-in user, in the header. The only filled one. */
	solid: 'bg-accent text-white',
	/** Not a person, or not an active one: a credit, or the "+4" overflow. */
	muted: 'bg-surface-2 text-ink-soft'
} as const;

export default function Avatar({
	name,
	label,
	tone = 'accent',
	size = 'md',
	title,
	className = ''
}: {
	/** The person's name. Only its first letter is drawn. */
	name?: string;
	/** Drawn instead of the initial. For the overflow count. */
	label?: ReactNode;
	tone?: keyof typeof TONE;
	size?: keyof typeof SIZE;
	title?: string;
	className?: string;
}) {
	return (
		<span
			title={title}
			className={[
				'grid shrink-0 place-items-center rounded-full font-semibold',
				SIZE[size],
				TONE[tone],
				className
			]
				.filter(Boolean)
				.join(' ')}
		>
			{label ?? name?.slice(0, 1).toUpperCase()}
		</span>
	);
}
