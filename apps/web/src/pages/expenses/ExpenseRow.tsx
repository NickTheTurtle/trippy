import type { SplitMode } from '@trippy/core/split';
import { formatMoney, formatTimestamp } from '../../lib/format';
import { IconButton } from '../../components/ui/buttons';
import { PencilIcon, TrashIcon, WarningIcon } from '../../components/ui/icons';
import Avatar from '../../components/ui/Avatar';
import Tag from '../../components/ui/Tag';
import type { Expense } from './types';
import { copy } from '../../copy';

const c = copy.expenses.row;

const splitLabel = (mode: SplitMode, n: number): string => c.splitLabel(mode, n);

/** One line of the ledger: who paid, how it was split, and what it cost. */
export default function ExpenseRow({
	expense: e,
	home,
	share,
	onEdit,
	onRemove
}: {
	expense: Expense;
	home: string;
	/**
	 * Home-currency cents this row charges the person the ledger is being read
	 * as. Undefined when it is being read as the whole trip.
	 */
	share?: number;
	/** Null for a settlement, which is deleted and re-recorded rather than edited. */
	onEdit: (() => void) | null;
	onRemove: () => void;
}) {
	const credit = e.amount_cents < 0;
	const settled = e.settlement === 1;
	return (
		<li className="group flex items-center gap-3">
			<Avatar name={e.payer_name} tone={credit ? 'muted' : 'accent'} />
			<div className="flex min-w-0 flex-col">
				<span className="truncate text-body font-medium" title={e.description}>
					{e.description}
					{/* A settlement is an expense in every way that matters to the maths,
					    but it is not a cost anyone shared, so the ledger says which it is. */}
					{(credit || settled) && (
						<Tag tone="accent" outline className="ml-1">
							{settled ? c.paymentTag : c.incomeTag}
						</Tag>
					)}
					{/* Somebody on this row has left the trip and their share could not
					    be re-divided. Marked rather than fixed: only the group can say
					    who absorbs a stated amount. A sign rather than a word, because
					    it has to read as an exception at a glance in a list where every
					    other row is fine. */}
					{e.needsReview && (
						<span
							role="img"
							aria-label={c.reviewTitle}
							title={c.reviewTitle}
							className="ml-1 inline-flex translate-y-0.5 align-text-bottom text-warn"
						>
							<WarningIcon />
						</span>
					)}
				</span>
				<span className="muted truncate text-meta">
					{/* The description of a settlement already names both sides, so
					    repeating the payer and calling it a one-way split is noise. */}
					{settled ? (
						formatTimestamp(e.created_at)
					) : (
						<>
							{e.payer_name} {credit ? c.received : c.paid} ·{' '}
							{splitLabel(e.split_mode, e.participants)} · {formatTimestamp(e.created_at)}
						</>
					)}
				</span>
			</div>
			<span
				className={`ml-auto flex flex-col items-end text-right font-semibold ${credit ? 'text-accent-ink' : ''}`}
			>
				{/* Read as one person, the figure that matters is their share, so it
				    takes the row's headline and the whole amount goes underneath it. */}
				{share === undefined ? (
					<>
						{formatMoney(e.amount_cents, e.currency)}
						{e.converted && (
							<span className="muted text-micro font-medium">
								≈ {formatMoney(e.home_cents, home)}
							</span>
						)}
					</>
				) : (
					<>
						{formatMoney(share, home)}
						<span className="muted text-micro font-medium">
							{c.ofTotal(formatMoney(e.home_cents, home))}
						</span>
					</>
				)}
			</span>
			{/* A payment cannot be edited, but its bin has to land in the same column
			    as every other row's, so the missing pencil leaves its slot behind. */}
			<span className="flex flex-none gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
				{onEdit ? (
					<IconButton label={c.editLabel(e.description)} onClick={onEdit}>
						<PencilIcon />
					</IconButton>
				) : (
					<span className="w-[var(--control-h-sm)]" aria-hidden />
				)}
				<IconButton label={c.deleteLabel(e.description)} danger onClick={onRemove}>
					<TrashIcon />
				</IconButton>
			</span>
		</li>
	);
}
