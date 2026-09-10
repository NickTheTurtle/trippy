import Cover from '../../components/Cover';
import type { Stay } from '../../lib/api-types';
import { formatNights, formatPerNight } from '../../lib/format';
import { CARD, OpenLink, RemoveCardButton, VotePill, VoteRule } from './card-controls';
import { copy } from '../../copy';

const c = copy.discover.stayCard;

/**
 * One proposed stay.
 *
 * Same treatment as a place card so the two read as one family: the cover,
 * title and meta are a single button, because clicking the stay is how you
 * edit it, and the vote, open and remove controls stay outside it so the card
 * never nests one interactive element inside another. A stay carries two
 * things a place does not: what it costs per night and the nights it covers.
 */
export default function StayCard({
	stay: o,
	currency,
	pct,
	onEdit,
	onVote,
	onRemove
}: {
	stay: Stay;
	currency: string;
	pct: number;
	onEdit: () => void;
	onVote: () => void;
	onRemove: () => void;
}) {
	const nights = formatNights(o.check_in, o.check_out);

	const ring = o.locked
		? 'border-accent shadow-[0_0_0_1px_var(--color-accent)]'
		: o.you_voted
			? 'border-accent-soft'
			: '';

	return (
		<article className={`${CARD} ${ring} group/card`}>
			<button
				type="button"
				onClick={onEdit}
				className="group flex min-w-0 flex-auto cursor-pointer flex-col p-0 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
			>
				<Cover photo={o.photo} seed={o.name} category="stay" />
				<span className="flex min-w-0 flex-auto flex-col px-4 pt-3.5">
					<span className="flex items-start justify-between gap-2">
						<span className="line-clamp-2 min-w-0 text-lead font-semibold [overflow-wrap:anywhere] group-hover:underline">
							{o.name}
						</span>
						{o.locked ? <span className="chip accent flex-none">{c.locked}</span> : null}
					</span>
					<span className="muted mt-1.5 mb-2.5 flex-auto text-meta">
						{o.tag ? `${o.tag} · ` : ''}
						{formatPerNight(o.price_cents, o.currency || currency)}
					</span>
					{nights && <span className="mb-2.5 text-meta text-accent-ink">🛏 {nights}</span>}
				</span>
			</button>

			<div className="flex flex-none flex-wrap items-center gap-1.5 px-4 pt-2.5 pb-3.5">
				<VotePill votes={o.votes} youVoted={!!o.you_voted} subject={o.name} onVote={onVote} />
				{o.url && <OpenLink url={o.url} name={o.name} />}
				<RemoveCardButton label={c.removeLabel(o.name)} onClick={onRemove} className="ml-auto" />
			</div>

			<VoteRule pct={pct} />
		</article>
	);
}
