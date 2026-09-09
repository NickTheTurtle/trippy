import { useState } from 'react';
import { api } from '../../lib/api';
import { useMutation } from '../../hooks/useMutation';
import Modal from '../../components/ui/Modal';
import Select from '../../components/ui/Select';
import FormError from '../../components/ui/FormError';
import type { Draft } from './types';
import { cap } from './labels';

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
		{ fallback: 'Could not save that item.' }
	);

	return (
		<Modal open size="sm" title={draft.id ? 'Edit cost' : 'Add cost'} onClose={onClose}>
			<form className="mform" onSubmit={save.submit}>
				<div className="mbody flex flex-col gap-3">
					<label className="field">
						<span>What is it?</span>
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
							<span>Amount ({currency})</span>
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
							<span>Category</span>
							<Select
								options={categories.map((c) => ({ value: c, label: cap(c) }))}
								value={category}
								onChange={setCategory}
								ariaLabel="Category"
							/>
						</label>
						<label className="field flex-[1_1_130px]">
							<span>City</span>
							<Select
								options={[
									{ value: '', label: 'All / general' },
									...cities.map((c) => ({ value: c.id, label: c.name }))
								]}
								value={cityId}
								onChange={setCityId}
								ariaLabel="City"
							/>
						</label>
					</div>
				</div>

				<div className="mfoot">
					<FormError message={save.error} />
					<button className="btn" type="button" onClick={onClose}>
						Cancel
					</button>
					<button className="btn primary" type="submit" disabled={save.busy}>
						{save.busy ? 'Saving...' : draft.id ? 'Save changes' : 'Add cost'}
					</button>
				</div>
			</form>
		</Modal>
	);
}
