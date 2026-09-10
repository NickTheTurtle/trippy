import type { SplitMode } from '@trippy/core/split';
import { formatMoney, formatTimestamp } from '../../lib/format';
import { IconButton } from '../../components/ui/buttons';
import type { Expense } from './types';
import { copy } from '../../copy';

const c = copy.expenses.row;

const splitLabel = (mode: SplitMode, n: number): string => c.splitLabel(mode, n);

/** One line of the ledger: who paid, how it was split, and what it cost. */
export default function ExpenseRow({
	expense: e,
	home,
	share,
	onRemove
}: {
	expense: Expense;
	home: string;
	/**
	 * Home-currency cents this row charges the person the ledger is being read
	 * as. Undefined when it is being read as the whole trip.
	 */
	share?: number;
	onRemove: () => void;
}) {
	const credit = e.amount_cents < 0;
	const settled = e.settlement === 1;
	return (
		<li className="flex items-center gap-3">
			<span
				className={`grid size-[30px] flex-none place-items-center rounded-full text-[0.82rem] font-semibold ${
					credit ? 'bg-surface-2 text-ink-soft' : 'bg-accent-soft text-accent-ink'
				}`}
			>
				{e.payer_name[0]}
			</span>
			<div className="flex min-w-0 flex-col">
				<span className="truncate text-[0.93rem] font-medium" title={e.description}>
					{e.description}
					{/* A settlement is an expense in every way that matters to the maths,
					    but it is not a cost anyone shared, so the ledger says which it is. */}
					{(credit || settled) && (
						<span className="ml-1 rounded-full border border-accent-soft px-1.5 py-px text-[0.66rem] font-semibold tracking-wider text-accent-ink uppercase">
							{settled ? c.paymentTag : c.incomeTag}
						</span>
					)}
				</span>
				<span className="muted truncate text-[0.8rem]">
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
							<span className="muted text-[0.75rem] font-medium">
								≈ {formatMoney(e.home_cents, home)}
							</span>
						)}
					</>
				) : (
					<>
						{formatMoney(share, home)}
						<span className="muted text-[0.75rem] font-medium">
							{c.ofTotal(formatMoney(e.home_cents, home))}
						</span>
					</>
				)}
			</span>
			<IconButton
				label={c.deleteLabel(e.description)}
				danger
				className="flex-none"
				onClick={onRemove}
			>
				×
			</IconButton>
		</li>
	);
}
