import type { SplitMode } from '@trippy/core/split';
import { formatMoney, formatTimestamp } from '../../lib/format';
import { WarningIcon } from '../../components/ui/icons';
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
	onOpen
}: {
	expense: Expense;
	home: string;
	/**
	 * Home-currency cents this row charges the person the ledger is being read
	 * as. Undefined when it is being read as the whole trip.
	 */
	share?: number;
	/**
	 * Pressing the row opens it: the edit dialog for an expense, and for a
	 * settlement, which cannot be edited, the question of deleting it.
	 */
	onOpen: () => void;
}) {
	const credit = e.amount_cents < 0;
	const settled = e.settlement === 1;
	return (
		<li>
			<button
				type="button"
				onClick={onOpen}
				aria-label={settled ? c.openLabel(e.description) : c.editLabel(e.description)}
				className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 border-0 bg-transparent p-0 text-left"
			>
				<Avatar name={e.payer_name} tone={credit ? 'muted' : 'accent'} />
				{/* `basis-40` is what makes the row wrap on a phone rather than squeeze:
				    a `min-w-0` column with no basis shrinks to nothing instead of
				    pushing its siblings onto the next line, and the description was
				    being cut to a single letter. */}
				<span className="flex min-w-0 flex-1 basis-40 flex-col">
					{/* The description truncates; the marks beside it do not. They are
					    siblings in a flex row rather than inline inside the truncating
					    span, because a long description would otherwise push the very
					    thing that flags the row out of view. */}
					<span className="flex items-center gap-1 text-body font-medium">
						<span className="truncate" title={e.description}>
							{e.description}
						</span>
						{/* A settlement is an expense in every way that matters to the maths,
						    but it is not a cost anyone shared, so the ledger says which it is. */}
						{(credit || settled) && (
							<Tag tone="accent" outline>
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
								className="flex-none text-warn"
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
				</span>
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
			</button>
		</li>
	);
}
