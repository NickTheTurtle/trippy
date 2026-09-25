import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { copy } from '@trippy/copy';
import { cap } from '@trippy/copy/format';
import { api, ApiError } from '../lib/api';
import { useMutation } from '../hooks/useMutation';
import { DestructiveRow, Field, InsetSection, ListRow } from '../ui';
import { CheckBox, SearchablePicker, SegmentedControl } from '../ui/controls';
import { Sheet } from '../ui/Sheet';
import { ConfirmSheet } from '../ui/ConfirmSheet';
import { color, hairline, space, type } from '../theme';
import { currencyName } from '@trippy/core/currency-names';
import { parseAmount } from '../lib/amount';

type Member = { id: string; name: string };
type Crew = { id: string; name: string; members: string[]; locked?: boolean };
type CostItem = {
	id: string;
	category: string;
	label: string;
	amountCents: number;
	currency: string;
	people: { id: string; name: string }[];
};

function currencyOptions(currencies: readonly string[]) {
	return currencies.map((code) => ({ key: code, label: code, detail: currencyName(code) }));
}

export function CostSheet({
	open,
	tripId,
	currency,
	currencies,
	categories,
	members,
	crews,
	item,
	onClose,
	onSaved
}: {
	open: boolean;
	tripId: string;
	currency: string;
	currencies: string[];
	categories: string[];
	members: Member[];
	crews: Crew[];
	item: CostItem | null;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [label, setLabel] = useState('');
	const [amount, setAmount] = useState('');
	const [cur, setCur] = useState(currency);
	const [category, setCategory] = useState(categories[0] ?? '');
	const [assignees, setAssignees] = useState<string[]>([]);
	const [confirmDelete, setConfirmDelete] = useState(false);

	useEffect(() => {
		if (!open) return;
		setLabel(item?.label ?? '');
		setAmount(item ? String(item.amountCents / 100) : '');
		setCur(item?.currency || currency);
		setCategory(item?.category ?? categories[0] ?? '');
		setAssignees(item ? item.people.map((p) => p.id) : []);
		setConfirmDelete(false);
		save.reset();
		remove.reset();
	}, [open, item?.id]);

	const save = useMutation(
		async () => {
			const value = parseAmount(amount);
			if (!Number.isFinite(value)) throw new ApiError(400, copy.common.amountMissing);
			const body = { label, category, amount: value, currency: cur, assignees };
			if (item) await api(`/trips/${tripId}/pretrip/costs/${item.id}`, { method: 'PUT', body });
			else await api(`/trips/${tripId}/pretrip/costs`, { method: 'POST', body });
		},
		{ fallback: copy.preparation.costDialog.fallback, onSuccess: onSaved }
	);

	const remove = useMutation(
		async () => {
			if (!item) return;
			await api(`/trips/${tripId}/pretrip/costs/${item.id}`, { method: 'DELETE' });
		},
		{
			fallback: copy.preparation.saveFallback,
			onSuccess: () => {
				setConfirmDelete(false);
				onSaved();
			}
		}
	);

	return (
		<>
			<Sheet
				open={open && !confirmDelete}
				title={item ? copy.preparation.costDialog.editTitle : copy.preparation.costDialog.addTitle}
				onClose={onClose}
				onPrimary={() => void save.run()}
				primaryLabel={item ? copy.common.save : copy.common.add}
				primaryBusyLabel={item ? copy.common.saving : copy.common.adding}
				primaryBusy={save.busy}
				primaryDisabled={!label.trim()}
			>
				<InsetSection error={save.error}>
					<Field
						variant="row"
						label={copy.preparation.costDialog.labelField}
						value={label}
						onChangeText={setLabel}
					/>
					<Field
						variant="row"
						label={copy.preparation.costDialog.amountLabel}
						value={amount}
						onChangeText={setAmount}
						keyboardType="decimal-pad"
					/>
					<SearchablePicker
						variant="row"
						label={copy.preparation.costDialog.currencyLabel}
						value={cur}
						options={currencyOptions(currencies)}
						onPick={setCur}
						noMatches={copy.ui.currencyPicker.noMatches}
					/>
				</InsetSection>
				<InsetSection title={copy.preparation.costDialog.categoryLabel}>
					<View style={{ padding: space.md }}>
						<SegmentedControl
							items={categories.map((c) => ({ key: c, label: cap(c) }))}
							active={category}
							onPick={setCategory}
						/>
					</View>
				</InsetSection>
				<AssigneePicker
					members={members}
					crews={crews}
					selected={assignees}
					onChange={setAssignees}
				/>
				{item ? (
					<InsetSection>
						<DestructiveRow
							title={copy.common.delete}
							accessibilityLabel={copy.common.deleteLabel(item.label)}
							onPress={() => setConfirmDelete(true)}
						/>
					</InsetSection>
				) : null}
			</Sheet>
			<ConfirmSheet
				open={!!item && confirmDelete}
				title={item ? copy.common.deleteTitle(item.label) : ''}
				confirmLabel={copy.common.delete}
				busyLabel={copy.common.deleting}
				busy={remove.busy}
				error={remove.error}
				onCancel={() => setConfirmDelete(false)}
				onConfirm={() => void remove.run()}
			/>
		</>
	);
}

function AssigneePicker({
	members,
	crews,
	selected,
	onChange
}: {
	members: Member[];
	crews: Crew[];
	selected: string[];
	onChange: (ids: string[]) => void;
}) {
	const selectedSet = useMemo(() => new Set(selected), [selected]);
	const setAll = (ids: string[]) => onChange([...new Set(ids)]);
	const toggle = (id: string) => {
		const next = new Set(selectedSet);
		if (!next.delete(id)) next.add(id);
		onChange([...next]);
	};
	return (
		<InsetSection
			title={`${copy.preparation.costDialog.forLabel}${copy.ui.field.optionalSuffix}`}
			footer={selected.length === 0 ? copy.preparation.costDialog.forEveryone : undefined}
		>
			{crews.map((crew) => (
				<ListRow
					key={crew.id}
					title={crew.name}
					subtitle={copy.people.crews.memberCount(crew.members.length)}
					accessory="none"
					onPress={() => setAll(crew.members)}
				/>
			))}
			{members.map((member, index) => {
				const on = selectedSet.has(member.id);
				return (
					<ChecklistRow
						key={member.id}
						label={member.name}
						checked={on}
						onPress={() => toggle(member.id)}
						last={index === members.length - 1}
					/>
				);
			})}
		</InsetSection>
	);
}

function ChecklistRow({
	label,
	checked,
	onPress,
	last
}: {
	label: string;
	checked: boolean;
	onPress: () => void;
	last: boolean;
}) {
	return (
		<View
			style={{
				minHeight: 52,
				flexDirection: 'row',
				alignItems: 'center',
				gap: space.md,
				paddingHorizontal: space.md,
				borderBottomWidth: last ? 0 : hairline,
				borderBottomColor: color.line
			}}
		>
			<CheckBox checked={checked} label={label} onPress={onPress} />
			<Text style={type.body}>{label}</Text>
		</View>
	);
}
