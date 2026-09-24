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
 * The glyphs these use live in `components/ui/icons`, which is where every page
 * takes them from.
 */

import {
	CompassIcon,
	LockIcon,
	PencilIcon,
	TrashIcon,
	UpvoteIcon
} from '../../components/ui/icons';
import { copy } from '../../copy';
import { safeExternalUrl } from '@trippy/core/validate';

/** `.card` is the shared surface; the rest is this page's card geometry. The
    old string also carried an `.opt` class that no stylesheet defines. */
export const CARD = 'card flex flex-col overflow-hidden';

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
	disabled = false,
	busy = false
}: {
	votes: number;
	youVoted: boolean;
	/** Named so a grid of identical pills is not identical to a screen reader. */
	subject: string;
	onVote: () => void;
	disabled?: boolean;
	/**
	 * The last press is still on its way. The pill already shows where it will
	 * land (see `useVotes`), so this only refuses a second press, which on a
	 * toggle would undo the first. `aria-disabled` rather than `disabled`: a
	 * disabled button drops keyboard focus to the page, so a keyboard voter
	 * would be thrown out of the grid on every vote.
	 */
	busy?: boolean;
}) {
	return (
		<button
			type="button"
			className={youVoted ? 'btn small primary' : 'btn small'}
			aria-pressed={youVoted}
			aria-label={copy.discover.card.voteLabel(youVoted, subject)}
			aria-disabled={busy || undefined}
			disabled={disabled}
			onClick={() => {
				if (!busy) onVote();
			}}
		>
			<UpvoteIcon />
			<span className="font-semibold tabular-nums">{votes}</span>
		</button>
	);
}

/**
 * The organizer's lock on a stay: this is the one the group is booking.
 *
 * On the card rather than in the edit dialog, because it is a decision about
 * the stay among the others, like a vote, not a correction to what somebody
 * typed; the edit dialog is deliberately the proposer's fields and nothing
 * else. Organizer only, as the server enforces, so it is not drawn for anyone
 * else rather than drawn and refused. One stay per city holds the lock and the
 * server moves it, so locking a second stay releases the first.
 *
 * Worded, not an icon alone: a padlock by itself reads as a state, and this
 * is the control that changes it. The chip in the title says the state.
 */
export function LockButton({
	locked,
	name,
	onLock,
	busy = false
}: {
	locked: boolean;
	name: string;
	onLock: () => void;
	busy?: boolean;
}) {
	return (
		<button
			type="button"
			className="btn small"
			// No `aria-pressed`: the label already flips between Lock and Unlock,
			// and a pressed state on top of a label that changes says it twice.
			aria-label={copy.discover.stayCard.lockLabel(locked, name)}
			aria-disabled={busy || undefined}
			onClick={() => {
				if (!busy) onLock();
			}}
		>
			<LockIcon />
			{locked ? copy.discover.stayCard.unlock : copy.discover.stayCard.lock}
		</button>
	);
}

/**
 * "Open" as an icon, with the accessible name the text button used to carry.
 *
 * The href is re-checked here rather than trusted from the row. The write path
 * validates too, but rows predating that check are still in the database, and a
 * link is the one field whose stored value becomes executable context.
 */
export function OpenLink({ url, name }: { url: string; name: string }) {
	const safe = safeExternalUrl(url);
	if (!safe) return null;
	return (
		<a className="btn small" href={safe} target="_blank" rel="noopener">
			<CompassIcon />
			<span className="sr-only">{copy.discover.card.openLabel(name)}</span>
		</a>
	);
}

/**
 * "Edit", as the pencil every other list in the app uses.
 *
 * Pressing the body of the card has always opened the editor, and both cards
 * said so in a comment, which is the wrong place to say it: nothing on the card
 * looked like a control, so the only way to find out was to press a picture and
 * see what happened. This puts the action in the footer beside the other two,
 * where it is visible, reachable by tab, and carries a name of its own rather
 * than inheriting the card's contents.
 *
 * Deleting stays inside the editor. It is one more click from here, it wants
 * the confirmation that already guards it, and a trash button on every tile of
 * a fourteen-tile grid would be the loudest thing on the page, which is the
 * same reasoning `RemoveCardButton` is written down with.
 *
 * It is a bordered `btn small`, not the app's `IconButton`, because `IconButton`
 * is `quiet` (no border) and its two neighbours in this footer are not. Three
 * controls in a row, one of them without an outline, reads as two buttons and a
 * decoration. Checked on screen at both widths: it now sits in line with the
 * vote pill and the open link.
 */
export function EditCardButton({
	name,
	onEdit,
	className = ''
}: {
	name: string;
	onEdit: () => void;
	className?: string;
}) {
	const label = copy.common.editLabel(name);
	return (
		<button
			type="button"
			className={`btn small ${className}`.trim()}
			title={label}
			onClick={onEdit}
		>
			<PencilIcon />
			<span className="sr-only">{label}</span>
		</button>
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
