/**
 * The controls a Discover card's footer is made of.
 *
 * The footer used to hold four things: a vote bar, the sentence "5 votes", an
 * "Open" button and a "Vote" button, laid out with `justify-between` so the two
 * buttons were pushed to the right edge with a gap in the middle that grew with
 * the card. Three of those four said the same thing twice (the bar, the count
 * and the button's Voted state), so it is now two controls, left aligned: one
 * vote pill that both shows the count and casts the vote, and one icon link
 * that opens the place. The bar moved to the card's bottom edge, where it reads
 * as an indicator on the card rather than a fourth thing competing in the row.
 *
 * Icons are inline SVG with `currentColor`, which is how the app already draws
 * the one it had (`Modal`'s close button). No icon dependency was added.
 */

/** `.card` is the shared surface; the rest is this page's card geometry. The
    old string also carried an `.opt` class that no stylesheet defines. */
export const CARD = 'card flex flex-col overflow-hidden';

export function CaretIcon() {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5">
			<path
				d="M8 3.5l4.5 6h-9z"
				fill="currentColor"
				stroke="currentColor"
				strokeWidth="1.2"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** A compass rose: "open this place somewhere else", not "submit a form". */
export function CompassIcon() {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5">
			<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
			<path
				d="M10.6 5.4l-1.3 3.9-3.9 1.3 1.3-3.9z"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function TrashIcon() {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="size-4">
			<path
				d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function PlusIcon() {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5">
			<path
				d="M8 3.5v9M3.5 8h9"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
			/>
		</svg>
	);
}

/**
 * The vote control: a caret and the count, as one toggle. Filled in accent when
 * the viewer has voted, which is the only state the old separate "Voted" button
 * carried.
 */
export function VotePill({
	votes,
	youVoted,
	subject,
	onVote,
	disabled = false
}: {
	votes: number;
	youVoted: boolean;
	/** Named so a grid of identical pills is not identical to a screen reader. */
	subject: string;
	onVote: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			className={youVoted ? 'btn small primary' : 'btn small'}
			aria-pressed={youVoted}
			aria-label={`${youVoted ? 'Remove your vote from' : 'Vote for'} ${subject}`}
			disabled={disabled}
			onClick={onVote}
		>
			<CaretIcon />
			<span className="font-semibold tabular-nums">{votes}</span>
		</button>
	);
}

/** "Open" as an icon, with the accessible name the text button used to carry. */
export function OpenLink({ url, name }: { url: string; name: string }) {
	return (
		<a className="btn small" href={url} target="_blank" rel="noopener">
			<CompassIcon />
			<span className="sr-only">Open {name} (opens in a new tab)</span>
		</a>
	);
}

/**
 * Share of the group behind this option, flush with the card's bottom edge.
 * The card clips it, so it follows the corner radius.
 */
export function VoteRule({ pct }: { pct: number }) {
	return (
		<div className="h-1 w-full flex-none bg-surface-2" aria-hidden="true">
			<div className="h-full bg-accent" style={{ width: `${pct}%` }} />
		</div>
	);
}

/**
 * The quiet remove button on a card or a sidebar row.
 *
 * Written out by hand three times (place card, stay card, city row) as the same
 * forty-word class string, which is three places to get one hover rule wrong.
 * It is deliberately not the shared `IconButton`: this one is bare rather than
 * bordered, and it is revealed by hovering its row, because removing is the
 * rarest thing anyone does here and one bordered button per card would be the
 * loudest thing on a page of fourteen. It keeps its space so the grid does not
 * shift, stays reachable by keyboard, and is always visible where there is no
 * hover to reveal it.
 *
 * Every caller's row must be marked `group/card`.
 */
export function RemoveCardButton({
	label,
	onClick,
	disabled = false,
	title,
	className = ''
}: {
	/** The accessible name, which is the only name this control has. */
	label: string;
	onClick: () => void;
	disabled?: boolean;
	/** Why it is disabled, when it is. */
	title?: string;
	className?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-label={label}
			title={title}
			className={`grid size-7 cursor-pointer place-items-center rounded-md border-none bg-transparent text-ink-faint opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 hover:bg-danger-soft hover:text-danger-ink focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-0 [@media(hover:none)]:opacity-100 ${className}`.trim()}
		>
			<TrashIcon />
		</button>
	);
}
