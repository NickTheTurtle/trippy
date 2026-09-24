import Cover from '../../components/Cover';
import type { Stay } from '../../lib/api-types';
import { formatPerNight } from '../../lib/format';
import { CARD, EditCardButton, OpenLink, VotePill, VoteRule } from './card-controls';

/**
 * One proposed stay.
 *
 * Same treatment as a place card so the two read as one family: the cover,
 * title and meta are a single button, because clicking the stay is how you edit
 * it, and the footer repeats that as a labelled pencil so the card has a
 * control that looks like one. Deleting is a button inside the edit dialog. The
 * footer controls stay outside the body button so the card never nests one
 * interactive element inside another. A stay carries one thing a place does
 * not: what it costs per night. Which nights are spent in it is the calendar's
 * answer, so the card does not give one of its own.
 */
export default function StayCard({
	stay: o,
	flipKey,
	currency,
	pct,
	voteBusy = false,
	onEdit,
	onVote
}: {
	stay: Stay;
	/** Identity for the grid's reorder animation. See `useFlip`. */
	flipKey: string;
	currency: string;
	pct: number;
	/** The viewer's vote in this city is on its way to the server. */
	voteBusy?: boolean;
	onEdit: () => void;
	onVote: () => void;
}) {
	const ring = o.you_voted ? 'border-accent-soft' : '';

	return (
		<article data-flip={flipKey} className={`${CARD} ${ring}`}>
			<button
				type="button"
				onClick={onEdit}
				className="group flex min-w-0 flex-auto cursor-pointer flex-col p-0 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
			>
				<Cover photo={o.photo} seed={o.name} category="stay" />
				<span className="flex min-w-0 flex-auto flex-col px-4 pt-3.5">
					<span className="line-clamp-2 min-w-0 text-lead font-semibold [overflow-wrap:anywhere] group-hover:underline">
						{o.name}
					</span>
					<span className="muted mt-1.5 mb-2.5 flex-auto text-meta">
						{o.tag ? `${o.tag} · ` : ''}
						{formatPerNight(o.price_cents, o.currency || currency)}
					</span>
				</span>
			</button>

			<div className="flex flex-none flex-wrap items-center gap-1.5 px-4 pt-2.5 pb-3.5">
				<VotePill
					votes={o.votes}
					youVoted={!!o.you_voted}
					subject={o.name}
					onVote={onVote}
					busy={voteBusy}
				/>
				{o.url && <OpenLink url={o.url} name={o.name} />}
				<EditCardButton name={o.name} onEdit={onEdit} className="ml-auto" />
			</div>

			<VoteRule pct={pct} />
		</article>
	);
}
