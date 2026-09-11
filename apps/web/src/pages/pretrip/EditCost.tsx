import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter, ModalForm } from '../../components/ui/Modal';
import { Field, FieldShell } from '../../components/ui/Field';
import Select from '../../components/ui/Select';
import MultiSelect from '../../components/ui/MultiSelect';
import { currencyOptions } from '../../lib/currencies';
import type { Draft } from './types';
import { cap } from '../../lib/format';
import { copy } from '../../copy';

const c = copy.preparation.costDialog;

/**
 * Adds or edits one cost estimate; the draft it opens on decides which.
 *
 * "Who is it for?" left alone means the whole trip, which is what most of an
 * estimate is. Naming people is for the lines that are not shared evenly: one
 * person's flight, or the two who want the diving trip.
 */
export default function EditCost({
	draft,
	currency,
	currencies,
	categories,
	members,
	me,
	tripId,
	onClose,
	onSaved
}: {
	draft: Draft;
	currency: string;
	currencies: string[];
	categories: string[];
	members: { id: string; name: string }[];
	me: string;
	tripId: string;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [label, setLabel] = useState(draft.label);
	const [amount, setAmount] = useState(draft.amount);
	const [cur, setCur] = useState(draft.currency || currency);
	const [category, setCategory] = useState(draft.category);
	const [assignees, setAssignees] = useState<Set<string>>(new Set(draft.assignees));

	const save = useMutation(
		async () => {
			await api(
				draft.id ? `/trips/${tripId}/pretrip/costs/${draft.id}` : `/trips/${tripId}/pretrip/costs`,
				{
					method: draft.id ? 'PUT' : 'POST',
					body: {
						label,
						amount: Number(amount),
						currency: cur,
						category,
						assignees: [...assignees]
					}
				}
			);
			onSaved();
			onClose();
		},
		{ fallback: c.fallback }
	);

	return (
		<Modal open size="sm" title={draft.id ? c.editTitle : c.addTitle} onClose={onClose}>
			<ModalForm onSubmit={save.submit}>
				<div className="mbody flex flex-col gap-4">
					{/* The same 12-column grid as the expense dialog: both are a money
					    line, so both lay their fields out the same way. */}
					<div className="grid grid-cols-12 gap-x-2.5 gap-y-3.5">
						<Field
							className="col-span-12"
							label={c.labelField}
							autoFocus
							required
							value={label}
							onChange={(e) => setLabel(e.target.value)}
						/>
						<Field
							className="col-span-4"
							label={c.amountLabel}
							type="number"
							min="0"
							step="0.01"
							inputMode="decimal"
							required
							value={amount}
							onChange={(e) => setAmount(e.target.value)}
						/>
						<FieldShell className="col-span-3" label={c.currencyLabel}>
							<Select
								options={currencyOptions(currencies)}
								value={cur}
								onChange={setCur}
								ariaLabel={c.currencyLabel}
							/>
						</FieldShell>
						<FieldShell className="col-span-5" label={c.categoryLabel}>
							<Select
								options={categories.map((x) => ({ value: x, label: cap(x) }))}
								value={category}
								onChange={setCategory}
								ariaLabel={c.categoryLabel}
							/>
						</FieldShell>
						<FieldShell className="col-span-12" label={c.forLabel}>
							<MultiSelect
								options={members.map((m) => ({
									value: m.id,
									label: m.name + (m.id === me ? copy.preparation.youSuffix : '')
								}))}
								selected={[...assignees]}
								onChange={(next) => setAssignees(new Set(next))}
								ariaLabel={c.forLabel}
								placeholder={c.forEveryone}
							/>
						</FieldShell>
					</div>
				</div>

				<ModalFooter
					error={save.error}
					onClose={onClose}
					busy={save.busy}
					busyLabel={draft.id ? copy.common.saving : copy.common.adding}
					submitLabel={draft.id ? copy.common.save : copy.common.add}
				/>
			</ModalForm>
		</Modal>
	);
}
