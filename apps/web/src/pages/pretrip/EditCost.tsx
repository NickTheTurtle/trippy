import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter } from '../../components/ui/Modal';
import Select from '../../components/ui/Select';
import MultiSelect from '../../components/ui/MultiSelect';
import { currencyOptions } from '../../lib/currencies';
import type { Draft } from './types';
import { cap } from './labels';
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
			<form className="mform" onSubmit={save.submit}>
				<div className="mbody flex flex-col gap-3">
					<label className="field">
						<span>{c.labelField}</span>
						<input
							autoFocus
							required
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							className="input w-full"
						/>
					</label>
					<div className="flex flex-wrap gap-2.5">
						<label className="field flex-[0_1_110px]">
							<span>{c.amountLabel}</span>
							<input
								type="number"
								min="0"
								step="1"
								required
								value={amount}
								onChange={(e) => setAmount(e.target.value)}
								className="input w-full"
							/>
						</label>
						<label className="field flex-[0_1_110px]">
							<span>{c.currencyLabel}</span>
							<Select
								options={currencyOptions(currencies)}
								value={cur}
								onChange={setCur}
								ariaLabel={c.currencyAriaLabel}
							/>
						</label>
						<label className="field flex-[1_1_130px]">
							<span>{c.categoryLabel}</span>
							<Select
								options={categories.map((x) => ({ value: x, label: cap(x) }))}
								value={category}
								onChange={setCategory}
								ariaLabel={c.categoryAriaLabel}
							/>
						</label>
					</div>
					<label className="field">
						<span>{c.forLabel}</span>
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
					</label>
				</div>

				<ModalFooter
					error={save.error}
					onClose={onClose}
					busy={save.busy}
					busyLabel={copy.common.saving}
					submitLabel={draft.id ? copy.common.save : c.addLabel}
				/>
			</form>
		</Modal>
	);
}
