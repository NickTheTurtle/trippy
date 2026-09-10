import { useMutation } from '../../hooks/useMutation';
import FormError from '../../components/ui/FormError';
import type { Transfer } from './types';
import { copy } from '../../copy';

const c = copy.expenses.settleRow;

/**
 * One suggested transfer, with the button that records it as paid.
 *
 * Marking it paid is not destructive and is undone by deleting the expense it
 * writes, so it takes one click rather than a confirmation. The button reports
 * its own failure in place: the alternative, a banner at the top of a grid of
 * twenty rows, would not say which one failed.
 */
export default function SettleRow({
	t,
	fmt,
	onSettle
}: {
	t: Transfer;
	fmt: (cents: number) => string;
	onSettle: () => Promise<void>;
}) {
	const mark = useMutation(onSettle, { fallback: c.fallback });

	return (
		<li className="flex flex-col gap-1 rounded-md bg-surface-2 px-2.5 py-2 text-body">
			<div className="flex items-center gap-2">
				<span className="truncate font-semibold" title={t.from}>
					{t.from}
				</span>
				<span className="shrink-0 text-meta text-ink-faint">{c.pays}</span>
				<span className="truncate" title={t.to}>
					{t.to}
				</span>
				<span className="ml-auto font-semibold">{fmt(t.amountCents)}</span>
				<button
					className="btn small flex-none"
					disabled={mark.busy}
					onClick={() => void mark.run()}
					aria-label={c.markPaidLabel(t.from, t.to, fmt(t.amountCents))}
				>
					{mark.busy ? c.busyLabel : c.markPaid}
				</button>
			</div>
			<FormError message={mark.error} className="text-meta" />
		</li>
	);
}
