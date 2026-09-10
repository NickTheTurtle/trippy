import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal, { ModalFooter } from '../../components/ui/Modal';
import Select from '../../components/ui/Select';
import type { Draft } from './types';
import { cap } from './labels';
import { copy } from '../../copy';

const c = copy.preparation.costDialog;

/** Adds or edits one cost estimate; the draft it opens on decides which. */
export default function EditCost({
	draft,
	currency,
	categories,
	cities,
	tripId,
	onClose,
	onSaved
}: {
	draft: Draft;
	currency: string;
	categories: string[];
	cities: { id: string; name: string }[];
	tripId: string;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [label, setLabel] = useState(draft.label);
	const [amount, setAmount] = useState(draft.amount);
	const [category, setCategory] = useState(draft.category);
	const [cityId, setCityId] = useState(draft.cityId);

	const save = useMutation(
		async () => {
			await api(
				draft.id ? `/trips/${tripId}/pretrip/costs/${draft.id}` : `/trips/${tripId}/pretrip/costs`,
				{
					method: draft.id ? 'PUT' : 'POST',
					body: { label, amount: Number(amount), category, cityId }
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
						<label className="field flex-[0_1_130px]">
							<span>{c.amountLabel(currency)}</span>
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
						<label className="field flex-[1_1_130px]">
							<span>{c.categoryLabel}</span>
							<Select
								options={categories.map((x) => ({ value: x, label: cap(x) }))}
								value={category}
								onChange={setCategory}
								ariaLabel={c.categoryAriaLabel}
							/>
						</label>
						<label className="field flex-[1_1_130px]">
							<span>{c.cityLabel}</span>
							<Select
								options={[
									{ value: '', label: c.anyCity },
									...cities.map((x) => ({ value: x.id, label: x.name }))
								]}
								value={cityId}
								onChange={setCityId}
								ariaLabel={c.cityAriaLabel}
							/>
						</label>
					</div>
				</div>

				<ModalFooter
					error={save.error}
					onClose={onClose}
					busy={save.busy}
					busyLabel={copy.common.saving}
					submitLabel={draft.id ? c.saveLabel : c.addLabel}
				/>
			</form>
		</Modal>
	);
}
