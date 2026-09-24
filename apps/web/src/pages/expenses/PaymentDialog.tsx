import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import { useDeleteAction } from '../../components/ui/useDeleteAction';
import { FieldShell } from '../../components/ui/Field';
import { formatMoney } from '../../lib/format';
import type { Expense } from './types';
import { copy } from '../../copy';

/**
 * One settlement, opened from the ledger.
 *
 * Almost nothing about a payment can be corrected: the amount and its two sides
 * are the debt it cleared, so putting those right means deleting it and
 * recording the real one. Its date is the exception, and the reason the dialog
 * is a form at all. A transfer is recorded when somebody gets round to pressing
 * the button, which is rarely the day the money moved, and the ledger is
 * ordered by day, so a payment stamped with the wrong one sorts into the wrong
 * place and stays there.
 *
 * So the dialog states the payment, lets its day be put right, and offers the
 * one other thing that can be done to it.
 */
export default function PaymentDialog({
	tripId,
	payment: e,
	home,
	onClose,
	onSaved,
	onDelete
}: {
	tripId: string;
	payment: Expense;
	/** The trip's home currency, for a payment made in another. */
	home: string;
	onClose: () => void;
	onSaved: () => void;
	onDelete: () => void | Promise<void>;
}) {
	const [spentOn, setSpentOn] = useState(e.spent_on);
	const del = useDeleteAction({
		title: copy.common.deleteTitle(e.description),
		name: e.description,
		busyLabel: copy.common.deleting,
		onDelete
	});

	const save = useMutation(
		async () => {
			await api(`/trips/${tripId}/expenses/${e.id}/date`, {
				method: 'PUT',
				body: { spentOn }
			});
			onSaved();
			onClose();
		},
		{ fallback: copy.expenses.addDialog.fallback }
	);

	return (
		<>
			<Modal open={!del.asking} size="sm" title={e.description} onClose={onClose}>
				<ModalForm onSubmit={save.submit}>
					<div className="mbody flex flex-col gap-4">
						<div className="flex flex-col gap-1">
							<p className="m-0 text-section font-semibold">
								{formatMoney(e.amount_cents, e.currency)}
							</p>
							{e.converted && (
								<p className="muted m-0 text-meta">≈ {formatMoney(e.home_cents, home)}</p>
							)}
						</div>
						{/* Unbounded like an expense's, and for the same reason: money moves
						    between people long before and long after the days they travelled. */}
						<FieldShell label={copy.expenses.addDialog.dateLabel}>
							<input
								type="date"
								value={spentOn}
								onChange={(event) => setSpentOn(event.target.value)}
								className="input"
							/>
						</FieldShell>
					</div>
					<ModalFooter
						error={save.error}
						onClose={onClose}
						busy={save.busy}
						busyLabel={copy.common.saving}
						submitLabel={copy.common.save}
						start={del.button}
					/>
				</ModalForm>
			</Modal>
			{del.confirm}
		</>
	);
}
