import Cover from '../../components/Cover';
import type { Poi } from '../../lib/api-types';
import { CARD, EditCardButton, OpenLink, VotePill, VoteRule } from './card-controls';
import { MetaBits, parseHours, todayHours } from './place-meta';

/**
 * One discovered place.
 *
 * The cover, title and meta are a single button, because clicking the place is
 * how you edit it; the footer repeats that as a labelled pencil, so the card
 * has a control that looks like one. Deleting it is a button inside the edit
 * dialog. The footer controls stay outside the body button so the card never
 * nests one interactive element inside another.
 */
export default function PlaceCard({
	poi: p,
	flipKey,
	tz,
	pct,
	onEdit,
	onVote
}: {
	poi: Poi;
	/** Identity for the grid's reorder animation. See `useFlip`. */
	flipKey: string;
	/** The city's IANA zone, so "today's hours" means today *there*. */
	tz: string;
	pct: number;
	onEdit: () => void;
	onVote: () => void;
}) {
	const hrs = todayHours(parseHours(p.hours), tz);
	return (
		<article data-flip={flipKey} className={CARD}>
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
				{/* Vote and link on the left, edit on the right: editing is the one
				    control that acts on the card rather than describing it, and the
				    far corner is where it stops competing with the vote count. */}
				<div className="flex flex-wrap items-center gap-1.5">
					<VotePill votes={p.votes} youVoted={!!p.you_voted} subject={p.name} onVote={onVote} />
					{p.url && <OpenLink url={p.url} name={p.name} />}
					<EditCardButton name={p.name} onEdit={onEdit} className="ml-auto" />
				</div>
			</div>

			<VoteRule pct={pct} />
		</article>
	);
}
