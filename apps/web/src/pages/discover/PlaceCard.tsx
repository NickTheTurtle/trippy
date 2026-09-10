import Cover from '../../components/Cover';
import type { Poi } from '../../lib/api-types';
import { CARD, OpenLink, RemoveCardButton, VotePill, VoteRule } from './card-controls';
import { MetaBits, parseHours, todayHours } from './place-meta';
import { copy } from '../../copy';

const c = copy.discover.placeCard;

/**
 * One discovered place.
 *
 * The cover, title and meta are a single button, because clicking the place is
 * how you edit it; the vote, open and remove controls stay outside it so the
 * card never nests one interactive element inside another.
 */
export default function PlaceCard({
	poi: p,
	tz,
	pct,
	onEdit,
	onVote,
	onRemove
}: {
	poi: Poi;
	/** The city's IANA zone, so "today's hours" means today *there*. */
	tz: string;
	pct: number;
	onEdit: () => void;
	onVote: () => void;
	onRemove: () => void;
}) {
	const hrs = todayHours(parseHours(p.hours), tz);
	return (
		<article className={`${CARD} group/card`}>
			<button
				type="button"
				onClick={onEdit}
				className="group flex min-w-0 flex-auto cursor-pointer flex-col p-0 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
			>
				<Cover photo={p.photo} seed={p.name} category={p.category} />
				<span className="flex min-w-0 flex-auto flex-col px-4 pt-3.5">
					<span className="line-clamp-2 text-lead font-semibold [overflow-wrap:anywhere] group-hover:underline">
						{p.name}
					</span>
					{/* Absorbs the slack so everything below aligns across cards. */}
					<span className="muted mt-1.5 mb-2.5 flex min-w-0 flex-auto flex-wrap items-baseline gap-x-2 gap-y-0.5 text-meta">
						<MetaBits
							rating={p.rating}
							ratingCount={p.rating_count}
							priceLevel={p.price_level}
							hours={hrs}
						/>
						{/* Notes are a multi-line field, so honour the breaks the author
						    typed, still clamped so cards stay the same height. */}
						{p.notes && (
							<span className="line-clamp-2 [overflow-wrap:anywhere] whitespace-pre-line">
								{p.notes}
							</span>
						)}
					</span>
				</span>
			</button>

			<div className="flex flex-none flex-col px-4 pt-2.5 pb-3.5">
				{p.linked > 0 && (
					<p className="mb-2.5 text-meta [overflow-wrap:anywhere] text-accent-ink">
						{c.onCalendar(p.linked)}
					</p>
				)}
				{/* Two controls, left aligned. The gap that used to sit here was
				    `justify-between` pushing Open and Vote to the right edge. */}
				<div className="flex flex-wrap items-center gap-1.5">
					<VotePill votes={p.votes} youVoted={!!p.you_voted} subject={p.name} onVote={onVote} />
					{p.url && <OpenLink url={p.url} name={p.name} />}
					<RemoveCardButton label={c.removeLabel(p.name)} onClick={onRemove} className="ml-auto" />
				</div>
			</div>

			<VoteRule pct={pct} />
		</article>
	);
}
