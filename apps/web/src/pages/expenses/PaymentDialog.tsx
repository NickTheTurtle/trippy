import Modal, { ModalFooter } from '../../components/ui/Modal';
import { useDeleteAction } from '../../components/ui/useDeleteAction';
import { formatMoney, formatTimestamp } from '../../lib/format';
import type { Expense } from './types';
import { copy } from '../../copy';

/**
 * One settlement, opened from the ledger.
 *
 * A payment has nothing to edit: it is a fact ("Omar paid Marcus"), and
 * correcting it means deleting it and recording the real one. It still opens
 * like every other row, because a row that behaved differently from the rows
 * around it would have to be told apart before it was pressed. So the dialog
 * states the payment and offers the one thing that can be done to it.
 */
export default function PaymentDialog({
	payment: e,
	home,
	onClose,
	onDelete
}: {
	payment: Expense;
	/** The trip's home currency, for a payment made in another. */
	home: string;
	onClose: () => void;
	onDelete: () => void | Promise<void>;
}) {
	const del = useDeleteAction({
		title: copy.expenses.deletePaymentTitle(e.description),
		busyLabel: copy.common.deleting,
		onDelete
	});

	return (
		<>
			<Modal open={!del.asking} size="sm" title={e.description} onClose={onClose}>
				<div className="mbody flex flex-col gap-1">
					<p className="m-0 text-section font-semibold">
						{formatMoney(e.amount_cents, e.currency)}
					</p>
					{e.converted && (
						<p className="muted m-0 text-meta">≈ {formatMoney(e.home_cents, home)}</p>
					)}
					<p className="muted m-0 text-meta">{formatTimestamp(e.created_at)}</p>
				</div>
				<ModalFooter onClose={onClose} start={del.button} />
			</Modal>
			{del.confirm}
		</>
	);
}
