import Cover from '../../components/Cover';
import type { Stay } from '../../lib/api-types';
import { formatNights, formatPerNight } from '../../lib/format';
import { CARD, OpenLink, RemoveCardButton, VotePill, VoteRule } from './card-controls';
import { copy } from '../../copy';

const c = copy.discover.stayCard;

/**
 * One proposed stay.
 *
 * Same footer treatment as a place card so the two read as one family: a vote
 * pill and an open icon, with the share of the group flush along the bottom
 * edge. A stay carries two things a place does not: what it costs per night and
 * the nights it covers.
 */
export default function StayCard({
	stay: o,
	currency,
	pct,
	onVote,
	onRemove
}: {
	stay: Stay;
	currency: string;
	pct: number;
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
			<Cover photo={o.photo} seed={o.name} category="stay" />
			<div className="flex min-w-0 flex-auto flex-col px-4 pt-3.5 pb-3.5">
				<div className="flex items-start justify-between gap-2">
					<h4 className="m-0 line-clamp-2 min-w-0 text-base [overflow-wrap:anywhere]">{o.name}</h4>
					{o.locked ? <span className="chip accent flex-none">{c.locked}</span> : null}
				</div>
				<p className="muted mt-1.5 mb-2.5 flex-auto text-[0.85rem]">
					{o.tag ? `${o.tag} · ` : ''}
					{formatPerNight(o.price_cents, o.currency || currency)}
				</p>
				{nights && <p className="mb-2.5 text-[0.8rem] text-accent-ink">🛏 {nights}</p>}

				<div className="flex flex-wrap items-center gap-1.5">
					<VotePill votes={o.votes} youVoted={!!o.you_voted} subject={o.name} onVote={onVote} />
					{o.url && <OpenLink url={o.url} name={o.name} />}
					<RemoveCardButton label={c.removeLabel(o.name)} onClick={onRemove} className="ml-auto" />
				</div>
			</div>

			<VoteRule pct={pct} />
		</article>
	);
}
