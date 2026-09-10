import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { cap } from '@trippy/copy/format';
import { api, ApiError } from '../lib/api';
import { useMutation } from '../hooks/useMutation';
import { Button, Field, FormError } from '../ui';
import { MemberPicker, Picker } from '../ui/controls';
import { Sheet } from '../ui/Sheet';
import { space, type } from '../theme';

type Member = { id: string; name: string };
type CostItem = {
	id: string;
	category: string;
	label: string;
	amountCents: number;
	/** Blank means the trip's home currency. */
	currency: string;
	people: { id: string; name: string }[];
};

/**
 * Adding or editing one cost estimate.
 *
 * The amount is posted in major units because that is what the endpoint takes
 * (`readItem` multiplies by 100), even though every figure the app displays is
 * in cents. Sending cents here would silently multiply the estimate by a
 * hundred.
 */
export function CostSheet({
	open,
	tripId,
	currency,
	categories,
	members,
	item,
	onClose,
	onSaved
}: {
	open: boolean;
	tripId: string;
	currency: string;
	categories: string[];
	members: Member[];
	item: CostItem | null;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [label, setLabel] = useState('');
	const [amount, setAmount] = useState('');
	const [cur, setCur] = useState(currency);
	const [category, setCategory] = useState(categories[0] ?? '');
	const [assignees, setAssignees] = useState<string[]>([]);

	useEffect(() => {
		if (!open) return;
		setLabel(item?.label ?? '');
		setAmount(item ? (item.amountCents / 100).toFixed(2) : '');
		setCur(item?.currency || currency);
		setCategory(item?.category ?? categories[0] ?? '');
		setAssignees(item ? item.people.map((p) => p.id) : []);
	}, [open, item, categories, currency]);

	const save = useMutation(
		async () => {
			const value = Number(amount.trim());
			if (!Number.isFinite(value) || value < 0) {
				throw new ApiError(400, copy.preparation.costDialog.fallback);
			}
			const body = { label, category, amount: value, currency: cur, assignees };
			if (item) {
				await api(`/trips/${tripId}/pretrip/costs/${item.id}`, { method: 'PUT', body });
			} else {
				await api(`/trips/${tripId}/pretrip/costs`, { method: 'POST', body });
			}
			onSaved();
		},
		{ fallback: copy.preparation.costDialog.fallback }
	);

	const remove = useMutation(
		async () => {
			if (!item) return;
			await api(`/trips/${tripId}/pretrip/costs/${item.id}`, { method: 'DELETE' });
			onSaved();
		},
		{ fallback: copy.preparation.saveFallback }
	);

	return (
		<Sheet
			open={open}
			title={item ? copy.preparation.costDialog.editTitle : copy.preparation.costDialog.addTitle}
			onClose={onClose}
		>
			<Field label={copy.preparation.costDialog.labelField} value={label} onChangeText={setLabel} />
			<View style={{ flexDirection: 'row', gap: space.sm }}>
				<View style={{ flex: 1 }}>
					<Field
						label={copy.preparation.costDialog.amountLabel}
						value={amount}
						onChangeText={setAmount}
						keyboardType="decimal-pad"
					/>
				</View>
				<View style={{ flex: 1 }}>
					<Field
						label={copy.preparation.costDialog.currencyLabel}
						value={cur}
						onChangeText={(v) => setCur(v.toUpperCase())}
						autoCapitalize="characters"
						maxLength={3}
					/>
				</View>
			</View>

			<View style={{ gap: space.xs }}>
				<Text style={type.small}>{copy.preparation.costDialog.categoryLabel}</Text>
				<Picker
					options={categories.map((c) => ({ key: c, label: cap(c) }))}
					value={category}
					onPick={setCategory}
				/>
			</View>

			<View style={{ gap: space.xs }}>
				<Text style={type.small}>{copy.preparation.costDialog.forLabel}</Text>
				<MemberPicker
					members={members}
					selected={assignees}
					onToggle={(id) =>
						setAssignees((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]))
					}
				/>
				{assignees.length === 0 ? (
					<Text style={type.faint}>{copy.preparation.costDialog.forEveryone}</Text>
				) : null}
			</View>

			<FormError message={save.error || remove.error} />
			<Button
				label={item ? copy.common.save : copy.preparation.costDialog.addLabel}
				onPress={() => void save.run()}
				busy={save.busy}
				disabled={!label.trim()}
			/>
			{item ? (
				<Button label="Delete" tone="danger" onPress={() => void remove.run()} busy={remove.busy} />
			) : null}
		</Sheet>
	);
}
