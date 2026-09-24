import type { SplitMode } from '@trippy/core/split';
import { formatMoney } from '../../lib/format';
import { formatSpentOn } from './day';
import { WarningIcon } from '../../components/ui/icons';
import Avatar from '../../components/ui/Avatar';
import Tag from '../../components/ui/Tag';
import type { Expense } from './types';
import { copy } from '../../copy';

const c = copy.expenses.row;

const splitLabel = (mode: SplitMode, n: number): string => c.splitLabel(mode, n);

/**
 * The colours the balances panel already gives a signed figure, so a row and
 * the balance it feeds into speak the same visual language. Zero stays neutral:
 * a row that left someone exactly where they were is neither.
 */
const netTone = (cents: number) =>
	cents > 0 ? 'text-accent-ink' : cents < 0 ? 'text-danger-ink' : '';

/** One line of the ledger: who paid, how it was split, and what it cost. */
export default function ExpenseRow({
	expense: e,
	home,
	net,
	onOpen
}: {
	expense: Expense;
	home: string;
	/**
	 * Home-currency cents this row moved the balance of the person the ledger is
	 * being read as: positive when it left the trip owing them, negative when it
	 * charged them. Undefined when the ledger is being read as the whole trip,
	 * where a shared cost has no direction.
	 */
	net?: number;
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
				aria-label={settled ? c.openLabel(e.description) : copy.common.editLabel(e.description)}
				className="tap-grow flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 border-0 bg-transparent p-0 text-left"
			>
				<Avatar name={e.payer_name} tone={credit ? 'muted' : 'accent'} />
				{/* `basis-40` is what makes the row wrap on a phone rather than squeeze:
				    a `min-w-0` column with no basis shrinks to nothing instead of
				    pushing its siblings onto the next line, and the description was
				    being cut to a single letter. */}
				<span className="flex min-w-0 flex-1 basis-40 flex-col">
					{/* The description wraps to two lines before it gives up; the marks
					    beside it do not wrap. They are siblings in a flex row rather
					    than inline inside the text, because a long description would
					    otherwise push the very thing that flags the row out of view.
					    Two lines, not one: a settlement's description is "Payment from
					    A to B", and cut at one line on a phone it lost the only half
					    that said who. */}
					<span className="flex items-start gap-1 text-body font-medium">
						<span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]" title={e.description}>
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
					{/* Wraps rather than truncating: who paid and how it was split is
					    what the row is for, and at 390px the split and the date were
					    the part being cut off. */}
					<span className="muted text-meta [overflow-wrap:anywhere]">
						{/* The day the money moved, not the day the row was typed in. The
						    two are usually the same, and when they are not it is because
						    somebody is entering a week of receipts after getting home,
						    which is exactly when the difference matters. */}
						{/* The description of a settlement already names both sides, so
						    repeating the payer and calling it a one-way split is noise. */}
						{settled ? (
							formatSpentOn(e.spent_on)
						) : (
							<>
								{e.payer_name} {credit ? c.received : c.paid} ·{' '}
								{splitLabel(e.split_mode, e.participants)} · {formatSpentOn(e.spent_on)}
							</>
						)}
					</span>
				</span>
				<span
					className={`ml-auto flex flex-col items-end text-right font-semibold ${net === undefined ? (credit ? 'text-accent-ink' : '') : netTone(net)}`}
				>
					{/* Read as one person, the figure that matters is what the row did to
					    their balance, so it takes the row's headline and the whole amount
					    goes underneath it. The sign, not the colour, carries that: `+`
					    for money the trip owes them back, a minus for money it charged
					    them, both written the way the balances panel writes them. */}
					{net === undefined ? (
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
							<span>
								{net > 0 ? '+' : ''}
								{formatMoney(net, home)}
							</span>
							{/* A settlement moved its whole amount one way, so the total
							    underneath would only repeat the figure above it. */}
							{!settled && (
								<span className="muted text-micro font-medium">
									{c.ofTotal(formatMoney(e.home_cents, home))}
								</span>
							)}
						</>
					)}
				</span>
			</button>
		</li>
	);
}
