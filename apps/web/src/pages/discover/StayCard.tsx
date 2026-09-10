import { useState } from 'react';
import Cover from '../../components/Cover';
import { Field } from '../../components/ui/Field';
import type { Stay } from '../../lib/api-types';
import { formatNights, formatPerNight } from '../../lib/format';
import { LinkButton } from '../../components/ui/buttons';
import { CARD, OpenLink, RemoveCardButton, VotePill, VoteRule } from './card-controls';
import { copy } from '../../copy';

const c = copy.discover.stayCard;

/**
 * One proposed stay.
 *
 * Same footer treatment as a place card so the two read as one family: a vote
 * pill and an open icon, with the share of the group flush along the bottom
 * edge. A stay carries three things a place does not: what it costs per night,
 * the nights it covers, and the organizer's lock.
 */
export default function StayCard({
	stay: o,
	currency,
	pct,
	isOrganizer,
	editingDates,
	onToggleDates,
	onVote,
	onLock,
	onRemove,
	onSaveDates
}: {
	stay: Stay;
	currency: string;
	pct: number;
	isOrganizer: boolean;
	editingDates: boolean;
	onToggleDates: () => void;
	onVote: () => void;
	onLock: () => void;
	onRemove: () => void;
	onSaveDates: (checkIn: string | null, checkOut: string | null) => void;
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

				<div className="mt-3 flex flex-wrap items-center gap-3.5 border-t border-line pt-3">
					<LinkButton aria-expanded={editingDates} onClick={onToggleDates}>
						{editingDates ? copy.common.cancel : nights ? c.editDates : c.setDates}
					</LinkButton>
					{/* Locking is organizer-only on the server, so a member seeing this
					    button would only ever get a refusal out of it. */}
					{isOrganizer && (
						<LinkButton onClick={onLock} aria-label={c.lockAriaLabel(!!o.locked, o.name)}>
							{c.lockLabel(!!o.locked)}
						</LinkButton>
					)}
				</div>

				{editingDates && (
					// Keyed on the stay's stored dates: the editor is seeded from props,
					// so without this it would keep showing what the card held when it
					// first mounted after someone else's edit arrived on a reload.
					<StayDates
						key={`${o.check_in ?? ''}|${o.check_out ?? ''}`}
						stay={o}
						onSave={onSaveDates}
					/>
				)}
			</div>

			<VoteRule pct={pct} />
		</article>
	);
}

function StayDates({
	stay: o,
	onSave
}: {
	stay: Stay;
	onSave: (checkIn: string | null, checkOut: string | null) => void;
}) {
	const [checkIn, setCheckIn] = useState(o.check_in ?? '');
	const [checkOut, setCheckOut] = useState(o.check_out ?? '');

	return (
		<div className="mt-3 flex flex-wrap items-end gap-2">
			<Field
				label={c.checkInLabel}
				optional
				className="flex-[0_1_150px]"
				inputClassName="compact w-full"
				type="date"
				value={checkIn}
				onChange={(e) => setCheckIn(e.target.value)}
			/>
			<Field
				label={c.checkOutLabel}
				optional
				className="flex-[0_1_150px]"
				inputClassName="compact w-full"
				type="date"
				value={checkOut}
				onChange={(e) => setCheckOut(e.target.value)}
			/>
			<button
				className="btn small primary"
				type="button"
				onClick={() => onSave(checkIn || null, checkOut || null)}
			>
				{c.saveDates}
			</button>
		</div>
	);
}
